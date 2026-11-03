// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { AiModel, FLAG_AT, featureVector, nominalSamples } from '../src/sim/aiModel';
import { FRAME_PERIOD_S } from '../src/sim/constants';
import {
  EmulatedHsm,
  ReplayWindow,
  createEd25519,
  encodeText,
  importMacKey,
} from '../src/sim/crypto';
import { DEMO_LENGTH_S, Engine, UPLINK_RUN_S } from '../src/sim/engine';
import { frameErrorRate } from '../src/sim/fec';
import {
  ALTITUDE_KM,
  C_KM_S,
  ORBIT_PERIOD_S,
  PASS_S,
  atmosphericLossDb,
  passAt,
  snrPredDb,
  timeAfterAos,
  timeCompression,
} from '../src/sim/geometry';
import { IsolationForest } from '../src/sim/iforest';
import { LinkDetector, zeroTrust } from '../src/sim/linkDetector';
import {
  CHI_SQUARE,
  NATURAL,
  SIGNAL,
  STEALTH,
  peakMicrovolts,
  rmsMicrovolts,
  snrLossDb,
} from '../src/sim/linkFacts';
import { mulberry32 } from '../src/sim/noise';
import {
  PhysicsEngine,
  chiSquareQuantile,
  elevationSpreadFactor,
  erfc,
  normalTwoSidedQuantile,
  rangeJerkBoundFor,
  type LinkState,
} from '../src/sim/physicsEngine';
import { JAMMED_RSSI_DBM, sample, type Attack, type Sample } from '../src/sim/signals';
import { decide } from '../src/sim/validator';
import { BELOW_GATE_DB } from '../src/ui/BelowGate';
import {
  TrustAnchorLedger,
  frameText,
  pyJsonDumps,
  seal,
  sha256Hex,
  type Frame,
} from '../src/sim/trustAnchor';
import {
  OnboardVerifier,
  ROGUE_COMMAND,
  UPLINK_THREATS,
  commandText,
  constantTimeEqual,
  sealCommand,
} from '../src/sim/uplink';
import { CHANNEL_HZ, SPAN_HZ, renderSpectrum, spectrumState } from '../src/ui/spectrumModel';

const KEY = Uint8Array.from({ length: 32 }, (_, i) => i);
const GOLDEN_FRAME: Frame = {
  satellite_id: 'TERRASAR-X',
  sequence: 1001,
  timestamp: 1790000000.123456,
  hw_token: '0x4FE2',
  payload: '00112233445566778899aabbccddeeff',
};

describe('trust anchor (port of trust_anchor.py)', () => {
  it('matches the Python golden vectors byte for byte', async () => {
    const key = await importMacKey(KEY);
    expect(frameText(GOLDEN_FRAME)).toBe(
      'TERRASAR-X|1001|1790000000.123456|0x4FE2|00112233445566778899aabbccddeeff',
    );
    const mac = await seal(key, GOLDEN_FRAME);
    expect(mac).toBe('7d8434838567fa40b26a6959945cb66df548cd76094ad2a5b04cf7d72eb86231');
    expect(await sha256Hex(frameText(GOLDEN_FRAME))).toBe(
      'a33eaae585206cce592e6233a3b597a469727b56c59c807ceec59401ac153187',
    );

    const ledger = await TrustAnchorLedger.create();
    expect(ledger.genesisRoot).toBe(
      'f309c75abe507ae390667b057af430aa58acadee40797e09c2a664cbc5a01e25',
    );
    const first = await ledger.authenticate(GOLDEN_FRAME, mac, key);
    expect(first.reason).toBe('AUTHENTIC');
    const b1 = await ledger.append(GOLDEN_FRAME, mac, first.frameDigest, first.reason);
    expect(b1.hash).toBe('50672d025f1b97fcf710509759e25e68257ca99fa301219dfc74753b74217fa2');
    const again = await ledger.authenticate(GOLDEN_FRAME, mac, key);
    expect(again.reason).toBe('STALE_OR_REUSED_NONCE');
    const b2 = await ledger.append(GOLDEN_FRAME, mac, again.frameDigest, again.reason);
    expect(b2.hash).toBe('98c284840bae540bb7d1df9924602d4c72a85410231e0bb7ff369a7b309916e2');
    expect((await ledger.verifyChain()).ok).toBe(true);
  });

  it('encodes block payloads like json.dumps(sort_keys=True)', () => {
    expect(pyJsonDumps({ b: 2, a: 'x', c: 'é' })).toBe('{"a": "x", "b": 2, "c": "\\u00e9"}');
  });

  it('rejects a single flipped payload bit before it can burn the nonce', async () => {
    const key = await importMacKey(KEY);
    const mac = await seal(key, GOLDEN_FRAME);
    const ledger = await TrustAnchorLedger.create();
    const tampered = { ...GOLDEN_FRAME, payload: '01' + GOLDEN_FRAME.payload.slice(2) };
    expect((await ledger.authenticate(tampered, mac, key)).reason).toBe('MAC_MISMATCH');
    expect((await ledger.authenticate(GOLDEN_FRAME, mac, key)).reason).toBe('AUTHENTIC');
  });

  it('rejects frames sealed under another key epoch', async () => {
    const hsm = await EmulatedHsm.create();
    const mac = await seal(await hsm.epochKey(0x3f), GOLDEN_FRAME);
    const ledger = await TrustAnchorLedger.create();
    expect((await ledger.authenticate(GOLDEN_FRAME, mac, await hsm.epochKey(0x40))).ok).toBe(false);
  });

  it('anti-replay window rejects repeats and anything older than the window', () => {
    const w = new ReplayWindow(64);
    expect(w.accept(100)).toBe(true);
    expect(w.accept(100)).toBe(false);
    expect(w.accept(99)).toBe(true);
    expect(w.accept(200)).toBe(true);
    expect(w.accept(136)).toBe(false);
    expect(w.accept(137)).toBe(true);
  });

  it('verify_chain() finds an edited block and a broken link', async () => {
    const key = await importMacKey(KEY);
    const ledger = await TrustAnchorLedger.create();
    for (let i = 0; i < 5; i++) {
      const f = { ...GOLDEN_FRAME, sequence: 2000 + i };
      const mac = await seal(key, f);
      const a = await ledger.authenticate(f, mac, key);
      await ledger.append(f, mac, a.frameDigest, a.reason);
    }
    const block = ledger.chain[3];
    const original = block.payload;
    block.payload = { ...(original as Record<string, string | number>), verdict: 'MAC_MISMATCH' };
    expect((await ledger.verifyChain()).message).toBe(
      'Tampering detected at index 3: hash mismatch.',
    );
    block.payload = original;
    ledger.chain[4].previous_hash = '0'.repeat(64);
    expect((await ledger.verifyChain()).message).toBe(
      'Chain broken at index 4: previous hash mismatch.',
    );
  });
});

describe('detector (port of detector.py) and zero trust', () => {
  const detector = new LinkDetector();
  let clock = 100;
  const rf = (dCarrier: number, dRssi: number) => ({
    carrierMHz: 8477.8 + dCarrier,
    carrierModelMHz: 8477.8,
    rssiDbm: -85 + dRssi,
    rssiModelDbm: -85,
    evmPct: 17.8,
    evmModelPct: 17.8,
    timingUs: 0,
    t: (clock += 1),
  });

  it('keeps the false-alarm rate near the 1% contamination point on unseen passes', () => {
    const d = new LinkDetector();
    let flagged = 0;
    let n = 0;
    for (let s = 50_000.3; n < 2000; s += FRAME_PERIOD_S) {
      const pass = passAt(s);
      if (!pass.linkActive) continue;
      const x = sample(s, snrPredDb(pass.rangeKm, pass.elevationDeg), {
        attacks: [],
        falseAlarm: 0,
        dopplerPredHz: pass.dopplerHz,
      });
      const m = { ...x, t: s };
      const r = d.evaluate(m);
      d.observe(m, false);
      if (r.anomaly) flagged++;
      else d.accept(m);
      n++;
    }
    expect(flagged / n).toBeLessThan(0.03);
  });

  it('flags a +14.2 MHz carrier and a collapsed carrier power with physics reasons', () => {
    detector.accept(rf(0, 0));
    const hijack = detector.evaluate(rf(14.2, 0));
    expect(hijack.physics).toBe(true);
    expect(hijack.physicsReasons).toContain('carrier offset no orbit can produce');
    // The carrier jumped since the last accepted frame, far beyond anything seen in training.
    expect(hijack.forest).toBe(true);
    expect(hijack.beyondRange).toContain('carrier step');
    const jam = detector.evaluate(rf(0, -11.5));
    expect(jam.physicsReasons).toContain('carrier power outside the link-budget band');
  });

  it('flags the MAC-failure rate after a failed frame, which no clean pass ever shows', () => {
    const d = new LinkDetector();
    const first = rf(0, 0);
    expect(d.evaluate(first).beyondRange).not.toContain('MAC / nonce failure rate');
    d.observe(first, true);
    expect(d.evaluate(rf(0, 0)).beyondRange).toContain('MAC / nonce failure rate');
  });

  it('zero trust drops on any failing evidence, whatever the frame claims', () => {
    const ok = new LinkDetector().evaluate(rf(0, 0));
    const claim = { satellite_id: 'TERRASAR-X', hw_token: '0x4FE2' };
    expect(zeroTrust(claim, { ok: true, reason: 'AUTHENTIC' }, ok).allow).toBe(true);
    const forged = zeroTrust(
      { ...claim, hw_token: '0x99A2' },
      { ok: false, reason: 'MAC_MISMATCH' },
      ok,
    );
    expect(forged.action).toBe('QUARANTINE_AND_DROP');
    expect(forged.reasons).toHaveLength(2);
    expect(zeroTrust(null, null, null).allow).toBe(false);
  });
});

describe('Ed25519 authentication', () => {
  it('signs and verifies a handshake challenge with Ed25519', async () => {
    const id = await createEd25519();
    expect(id).not.toBeNull();
    const challenge = encodeText('GS-ZAG|epoch:63');
    const sig = await id!.sign(challenge);
    expect(sig).toHaveLength(64);
    expect(await id!.verify(challenge, sig)).toBe(true);
    expect(await id!.verify(encodeText('GS-ZAG|epoch:64'), sig)).toBe(false);
  });
});

describe('pass geometry', () => {
  it("flies TerraSAR-X's 514 km sun-synchronous LEO orbit", () => {
    expect(ALTITUDE_KM).toBe(514);
    expect(ORBIT_PERIOD_S / 60).toBeGreaterThan(94.5);
    expect(ORBIT_PERIOD_S / 60).toBeLessThan(95);
  });

  it('culminates mid-pass with Doppler crossing zero', () => {
    const rise = passAt(PASS_S * 0.2);
    const top = passAt(PASS_S * 0.5);
    const set = passAt(PASS_S * 0.8);
    expect(top.elevationDeg).toBeGreaterThan(80);
    expect(Math.abs(top.dopplerHz)).toBeLessThan(1000);
    expect(rise.dopplerHz).toBeGreaterThan(50_000);
    expect(set.dopplerHz).toBeLessThan(-50_000);
    expect(snrPredDb(top.rangeKm)).toBeGreaterThan(snrPredDb(rise.rangeKm) + 5);
  });

  it('finds the elevation-mask rise', () => {
    expect(passAt(timeAfterAos(0.01)).linkActive).toBe(true);
    expect(passAt(timeAfterAos(-0.5)).linkActive).toBe(false);
  });
});

/** The link as the station measures it and as the orbit and link budget predict it. */
function claim(s: number, x: Sample) {
  const p = passAt(s);
  const rx: LinkState = {
    rangeKm: p.rangeKm + (x.timingUs ?? 0) * C_KM_S * 1e-6,
    dopplerHz: p.dopplerHz + x.dopplerHz,
    rssiDbm: x.rssiDbm,
    phaseDeg: x.phaseDeg,
  };
  const truth: LinkState = {
    rangeKm: p.rangeKm,
    dopplerHz: p.dopplerHz,
    rssiDbm: x.rssiModelDbm,
    phaseDeg: 0,
  };
  return { rx, truth, el: p.elevationDeg, t: s * timeCompression() };
}

describe('physical layer (port of security_detector.py)', () => {
  const attack = (kind: Attack['kind'], power = 9): Attack => ({
    kind,
    tTrigger: 0,
    tResponse: 1e9,
    power: () => power,
  });
  /** One frame per frame period across `passes` passes; counts chi-square and kinematic breaches. */
  const sweep = (passes: number, a: Attack | null, from = 0) => {
    const engine = new PhysicsEngine();
    let frames = 0;
    let chi = 0;
    let kinematic = 0;
    let sum = 0;
    for (let s = from + 0.5; s < from + passes * 69; s += FRAME_PERIOD_S) {
      const p = passAt(s);
      if (!p.linkActive) {
        engine.reset();
        continue;
      }
      const x = sample(s, snrPredDb(p.rangeKm, p.elevationDeg), {
        attacks: a ? [a] : [],
        falseAlarm: 0,
        dopplerPredHz: p.dopplerHz,
      });
      if (x.timingUs === null) continue;
      const c = claim(s, x);
      const r = engine.evaluate(c.rx, c.truth, c.el, c.t);
      frames++;
      sum += r.chiSquare;
      if (r.chiSquareBreach) chi++;
      if (r.kinematic.breach) kinematic++;
    }
    return { frames, chi, kinematic, meanChi: sum / frames };
  };

  it("uses the twin's gates: chi-square with 4 dof and a two-sided z at 1e-4", () => {
    // chi_square_quantile(1 - 1e-4, 4) and normal_two_sided_quantile(1e-4) in the twin.
    expect(chiSquareQuantile(1 - 1e-4, 4)).toBeCloseTo(23.5127, 3);
    expect(normalTwoSidedQuantile(1e-4)).toBeCloseTo(3.8906, 3);
    expect(erfc(1)).toBeCloseTo(0.157299207, 6);
    expect(CHI_SQUARE.dof).toBe(4);
    expect(elevationSpreadFactor(0)).toBe(3);
    expect(elevationSpreadFactor(60)).toBeCloseTo(1, 3);
    expect(CHI_SQUARE.maskGate / CHI_SQUARE.gate).toBeCloseTo(elevationSpreadFactor(2), 9);
    // 0.859 v^3 / rho^2 overhead at 514 km: the twin's default bound.
    expect(rangeJerkBoundFor(514)).toBeCloseTo((0.859 * (7.6 + 0.465) ** 3) / 514 ** 2, 3);
  });

  it('never fires on clean passes: chi-square averages its 4 degrees of freedom', () => {
    const clean = sweep(60, null);
    expect(clean.frames).toBeGreaterThan(10_000);
    expect(clean.chi).toBe(0);
    expect(clean.kinematic).toBe(0);
    expect(clean.meanChi).toBeGreaterThan(3.2);
    expect(clean.meanChi).toBeLessThan(4.8);
  });

  it('rejects the hijack, the strong jam and the spoof; passes tampering and the below-gate jam', () => {
    const hijack = sweep(4, attack('hijack'));
    expect(hijack.chi).toBe(hijack.frames);
    // Started mid-pass, the hijacker's carrier also breaks the range-Doppler coupling against
    // the last trusted frame.
    const late = sweep(1, { ...attack('hijack'), tTrigger: 30 });
    expect(late.kinematic).toBeGreaterThan(0);
    // At +9 dB the carrier is lost outright; at +6 dB frames still arrive, 5.4 dB too weak.
    const jam = sweep(4, attack('jam', 6));
    expect(jam.chi).toBe(jam.frames);
    // 3.2 dB below the link budget: inside a ±4 dB band, 14 sigma off the prediction.
    const spoof = sweep(4, attack('spoof'));
    expect(spoof.chi).toBe(spoof.frames);
    expect(sweep(4, attack('tamper')).chi).toBe(0);
    const quiet = sweep(4, attack('jam', BELOW_GATE_DB));
    expect(quiet.chi + quiet.kinematic).toBe(0);
  });

  it('catches a delay without the matching Doppler, even when the orbit model is stale', () => {
    const engine = new PhysicsEngine();
    const s0 = timeAfterAos(20);
    const stale = 40; // km: the orbit model is off, the signal is genuine
    let consistent = 0;
    for (let k = 0; k < 10; k++) {
      const s = s0 + k * FRAME_PERIOD_S;
      const x = sample(s, 15, { attacks: [], falseAlarm: 0 });
      const c = claim(s, x);
      const r = engine.evaluate(c.rx, { ...c.truth, rangeKm: c.truth.rangeKm + stale }, c.el, c.t);
      expect(r.chiSquareBreach).toBe(true);
      if (r.kinematic.verdict !== 'KINEMATIC_VIOLATION') consistent++;
    }
    // The stale model fires chi-square, so no frame becomes an anchor: start from a good one.
    const ok = engine;
    const s = s0 + 20;
    const x = sample(s, 15, { attacks: [], falseAlarm: 0 });
    const c = claim(s, x);
    ok.evaluate(c.rx, c.truth, c.el, c.t);
    const s2 = s + FRAME_PERIOD_S;
    const c2 = claim(s2, sample(s2, 15, { attacks: [], falseAlarm: 0 }));
    // A meaconer: 241.8 µs of extra light time, 72.5 km of range, Doppler still the satellite's.
    const meaconed = { ...c2.rx, rangeKm: c2.rx.rangeKm + 72.5 };
    const r = ok.evaluate(meaconed, { ...c2.truth, rangeKm: c2.truth.rangeKm + 72.5 }, c2.el, c2.t);
    expect(r.chiSquareBreach).toBe(false);
    expect(r.kinematic.verdict).toBe('KINEMATIC_VIOLATION');
    expect(r.kinematic.z).toBeGreaterThan(50);
    expect(consistent).toBe(10);
  });

  it('decides as decision.py: one deterministic tier rejects, two quarantine, the forest holds', () => {
    const claimOk = { satellite_id: 'TERRASAR-X', hw_token: '0x4FE2' };
    const authOk = { ok: true, reason: 'AUTHENTIC' as const };
    const engine = new PhysicsEngine();
    const s = timeAfterAos(10);
    const c = claim(s, sample(s, 15, { attacks: [], falseAlarm: 0 }));
    const clean = engine.evaluate(c.rx, c.truth, c.el, c.t);
    const breach = { ...clean, breach: true, chiSquareBreach: true, chiSquare: 200 };
    const forest = { forest: true, score: 0.7, threshold: 0.6 } as Parameters<typeof decide>[3];
    expect(decide(claimOk, authOk, clean, null).verdict).toBe('ACCEPTED');
    expect(decide(claimOk, authOk, clean, forest).verdict).toBe('HELD');
    expect(decide(claimOk, authOk, clean, forest).action).toBe('HOLD_FOR_REVIEW');
    expect(decide(claimOk, authOk, breach, null).verdict).toBe('REJECTED');
    expect(decide(claimOk, authOk, breach, forest).verdict).toBe('QUARANTINED');
    const macFail = { ok: false, reason: 'MAC_MISMATCH' as const };
    const forged = decide(claimOk, macFail, clean, null);
    expect(forged.verdict).toBe('REJECTED');
    expect(forged.reasons).toEqual(['data: trust anchor: MAC_MISMATCH']);
    expect(decide(null, null, null, null).verdict).toBe('REJECTED');
    // A burst of authentication failures quarantines the link.
    const burst = decide(claimOk, macFail, clean, null, true);
    expect(burst.verdict).toBe('QUARANTINED');
    expect(burst.reasons[0]).toMatch(/burst · 3 authentication failures within the last 10 frames/);
    // Genuine, authenticated, only the power residual out: delivered tagged as degraded.
    const faded = {
      ...clean,
      breach: true,
      chiSquareBreach: true,
      chiSquare: clean.chiSquare + 400,
      normalized: { ...clean.normalized, rssiDb: -20 },
    };
    const degraded = decide(claimOk, authOk, faded, forest);
    expect(degraded.verdict).toBe('DEGRADED');
    expect(degraded.allow).toBe(true);
    expect(decide(claimOk, macFail, faded, null).verdict).toBe('QUARANTINED');
  });

  it('moves the carrier to ~8492 MHz under hijack and RSSI to −96.5 dBm under jamming', () => {
    const snrModel = 15;
    const at = (a: Attack) =>
      sample(12, snrModel, { attacks: [{ ...a, tTrigger: 10 }], falseAlarm: 0, dopplerPredHz: 0 });
    const hijacked = at(attack('hijack'));
    expect(hijacked.carrierMHz).toBeGreaterThan(8491.4);
    expect(hijacked.carrierMHz).toBeLessThan(8492.6);
    expect(Math.abs(hijacked.phaseDeg)).toBeGreaterThan(30);
    const jammed = at(attack('jam', 9));
    expect(Math.abs(jammed.rssiDbm - JAMMED_RSSI_DBM)).toBeLessThan(1);
    // 15 dB less the jam's 9.6 dB is above the decoder's threshold: the frame decodes.
    expect(jammed.timingUs).not.toBeNull();
    // At the mask, 11.2 dB less 9.6 dB is below it: the decoder fails and the frame is lost.
    const atMask = sample(12, 11.2, {
      attacks: [{ ...attack('jam', 9), tTrigger: 10 }],
      falseAlarm: 0,
      dopplerPredHz: 0,
    });
    expect(atMask.timingUs).toBeNull();
    expect(frameErrorRate(11.2)).toBeLessThan(1e-20);
    expect(frameErrorRate(1.6)).toBe(1);
    // The same waterfall as digital_twin/fec.py.
    expect(frameErrorRate(3.5)).toBeCloseTo(0.185, 2);
    expect(frameErrorRate(4.0)).toBeCloseTo(0.0378, 3);
    const spoofed = at(attack('spoof'));
    expect(spoofed.rssiDbm).toBeLessThan(spoofed.rssiModelDbm - 2);
    expect(spoofed.rssiDbm).toBeGreaterThan(spoofed.rssiModelDbm - 4);
  });
});

describe('isolation forest', () => {
  it('scores outliers above the centre of a Gaussian cluster', () => {
    const rand = mulberry32(5);
    const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
    const data = Array.from({ length: 1000 }, () => [gauss() * 0.3, gauss() * 0.3]);
    const forest = new IsolationForest({ nEstimators: 200, seed: 3 }).fit(data);
    expect(forest.score([2, 2])).toBeGreaterThan(forest.score([0, 0]) + 0.15);
  });
});

describe('AI model', () => {
  const model = new AiModel();
  const clean = { lossRate: 0, failRate: 0 };

  it('keeps the nominal exceedance of the operating point near the 0.6% target', () => {
    const unseen = nominalSamples(3000, 9001.7, 0.43);
    const flagged = unseen.filter(
      (x) => model.score(featureVector(x, clean, model.scales)) >= FLAG_AT,
    );
    expect(flagged.length / unseen.length).toBeLessThan(0.015);
  });

  it('flags the mimic from MAC failures and an EVM burst alone', () => {
    const x = sample(12, 15, { attacks: [], falseAlarm: 0 });
    expect(
      model.score(featureVector(x, { lossRate: 0, failRate: 0.4 }, model.scales)),
    ).toBeGreaterThan(FLAG_AT);
    const burst = sample(12, 15, { attacks: [], falseAlarm: 1 });
    expect(model.score(featureVector(burst, clean, model.scales))).toBeGreaterThan(FLAG_AT);
  });
});

async function runFor(engine: Engine, seconds: number) {
  const steps = Math.round(seconds / 0.05);
  for (let i = 0; i < steps; i++) {
    engine.step();
    await engine.settle();
  }
}

describe('engine scenarios', () => {
  it('stays nominal on a clean pass, verifies every frame and logs the trust anchor', async () => {
    const engine = await Engine.create();
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      engine.step();
      await engine.settle();
      seen.add(engine.state);
    }
    expect(seen.has('UNDER ATTACK')).toBe(false);
    expect(engine.framesVerified).toBeGreaterThan(40);
    expect(engine.framesRejected).toBe(0);
    expect(engine.ledger.every((r) => r.verdict === 'VERIFIED')).toBe(true);
    const log = engine.terminal.map((l) => l.text).join('\n');
    expect(log).toContain(`genesis root ${engine.genesis.slice(0, 24)}`);
    expect(log).toMatch(/✓ block #\d+ [0-9a-f]{10}…[0-9a-f]{4} hmac ok/);
    expect(log).toMatch(/Ed25519 auth ✓ /);
    expect(engine.handshakes).toBeGreaterThanOrEqual(2);
  });

  it('frequency hijack: escalates, flags proof failures, quarantines without re-keying', async () => {
    const engine = await Engine.create();
    await runFor(engine, 1);
    engine.trigger('hijack');
    await runFor(engine, 1.5);
    expect(engine.state).toBe('UNDER ATTACK');
    expect(engine.detectors.TRUST.flag && engine.detectors.PHYSICS.flag).toBe(true);
    expect(engine.current!.carrierMHz).toBeGreaterThan(8490);
    expect(
      engine.ledger.some((r) => r.verdict === 'MAC FAIL' && r.source.startsWith('ROGUE-TX')),
    ).toBe(true);
    expect(engine.terminal.some((l) => l.text.includes('PROOF FAIL'))).toBe(true);
    await runFor(engine, 5);
    // No frame carried a valid tag: no key-holder evidence, so the key epoch stays.
    expect(engine.keyEpoch).toBe(0x3f);
    expect(engine.terminal.some((l) => l.text.includes('key epoch unchanged'))).toBe(true);
    expect(engine.ledger.some((r) => r.verdict === 'QUARANTINED')).toBe(true);
    expect(engine.corruptedToAnalyst).toBe(0);
  });

  it('stealth spoofing: inside a ±4 dB band, but χ² and forged nonces from 0x99A2 give it away', async () => {
    const engine = await Engine.create();
    await runFor(engine, 1);
    engine.trigger('spoof');
    await runFor(engine, 1.2);
    expect(engine.detectors.PHYSICS.flag).toBe(true);
    expect(engine.detectors.PHYSICS.evaded).toBe(false);
    expect(engine.physics!.chi.dominant).toBe('rssiDb');
    expect(engine.votes).toBeGreaterThanOrEqual(2);
    const forged = engine.packets.filter((p) => p.label === 'spoof');
    expect(forged.length).toBeGreaterThan(0);
    for (const p of forged) {
      // Forged tag and a χ² breach: two tiers, or a burst of failures, quarantine.
      expect(p.decision.verdict).toBe('QUARANTINED');
      expect(p.decision.reasons.some((r) => r.startsWith('data: '))).toBe(true);
    }
    expect(engine.state).toBe('UNDER ATTACK');
    expect(engine.banner?.headline).toMatch(/Quarantine protocols engaged/);
    expect(engine.ledger.some((r) => r.source === 'NODE 0x99A2')).toBe(true);
    expect(engine.terminal.some((l) => l.text.includes('forged nonce'))).toBe(true);
    expect(engine.corruptedToAnalyst).toBe(0);
  });

  it('noise jamming: power collapses, frames are lost or delivered degraded, routing falls back', async () => {
    const engine = await Engine.create();
    await runFor(engine, 1);
    engine.setPower(9);
    engine.trigger('jam');
    await runFor(engine, 1.5);
    expect(engine.state).toBe('JAMMING');
    expect(engine.current!.rssiDbm).toBeLessThan(-95);
    const jammed = engine.packets.filter((p) => p.label === 'jam');
    expect(jammed.length).toBeGreaterThan(0);
    for (const p of jammed) {
      // Lost to the decoder, or genuine and delivered flagged: never accepted as clean.
      expect(p.decision.verdict).not.toBe('ACCEPTED');
      if (p.frame) {
        expect(p.auth.ok).toBe(true);
        expect(p.decision.verdict).toBe('DEGRADED');
      }
    }
    expect(engine.corruptedToAnalyst).toBe(0);
    await runFor(engine, 3);
    expect(engine.route).toBe('MAT');
    expect(engine.terminal.some((l) => l.text.includes('fallback routing → GS-MAT'))).toBe(true);
  });

  it('jam below the gate is never escalated and every frame is still accepted', async () => {
    const engine = await Engine.create();
    await runFor(engine, 1);
    engine.setPower(BELOW_GATE_DB);
    engine.trigger('jam');
    await runFor(engine, 4);
    expect(engine.runs.length + (engine.run ? 1 : 0)).toBe(1);
    expect(engine.run?.escalatedAt ?? null).toBeNull();
    expect(engine.packets.every((p) => p.decision.verdict === 'ACCEPTED')).toBe(true);
  });

  it('data tampering: no RF signature, every altered frame fails the hash and is dropped', async () => {
    const engine = await Engine.create();
    await runFor(engine, 1);
    engine.trigger('tamper');
    await runFor(engine, 1.5);
    expect(engine.detectors.PHYSICS.flag).toBe(false);
    expect(engine.detectors.PHYSICS.evaded).toBe(true);
    const tampered = engine.packets.filter((p) => p.label === 'tamper');
    expect(tampered.length).toBeGreaterThan(0);
    for (const p of tampered) {
      expect(p.auth.reason).toBe('MAC_MISMATCH');
      expect(p.decision.allow).toBe(false);
      expect(p.physics?.breach).toBe(false);
      expect(p.flipped).not.toBeNull();
      expect(p.frame!.payload).not.toBe(p.originalPayload);
      expect(p.mac).not.toBe(p.expectedMac);
    }
    expect(engine.terminal.some((l) => l.text.includes('HASH MISMATCH'))).toBe(true);
    // The burst rule, replayed over the frames in order: a failure is rejected unless the last
    // 10 decoded frames hold 3 failures, then it quarantines the link.
    const window: boolean[] = [];
    for (const p of [...engine.packets].reverse()) {
      if (!p.frame) continue;
      window.push(!p.auth.ok);
      if (window.length > 10) window.shift();
      if (p.label !== 'tamper') continue;
      // A failure among the frames before it: the forest's MAC-failure rate flags too.
      const prior = window.slice(0, -1).some(Boolean);
      const burst = window.filter(Boolean).length >= 3;
      expect(p.decision.verdict).toBe(burst || prior ? 'QUARANTINED' : 'REJECTED');
    }
    expect(engine.keyEpoch).toBe(0x3f);
    expect(engine.corruptedToAnalyst).toBe(0);
  });

  it('records every packet for the inspection drawer and per-scenario layer stats', async () => {
    const engine = await Engine.create();
    await runFor(engine, 2);
    const genuine = engine.packets.find((p) => p.label === 'genuine')!;
    expect(genuine.auth.reason).toBe('AUTHENTIC');
    expect(genuine.mac).toBe(genuine.expectedMac);
    expect(genuine.frameText).toBe(frameText(genuine.frame!));
    expect(genuine.frameDigest).toBe(await sha256Hex(genuine.frameText!));
    expect(genuine.block!.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(genuine.detector!.confidence).toBeGreaterThanOrEqual(0);
    expect(genuine.decision.action).toBe('ALLOW_STREAM');

    engine.trigger('spoof');
    await runFor(engine, 2);
    const spoof = engine.layerStats.spoof!;
    expect(spoof.frames).toBeGreaterThan(0);
    expect(spoof.anchor).toBe(spoof.frames);
    expect(spoof.blocked).toBe(spoof.frames);
    expect(engine.layerStats.genuine!.blocked).toBe(0);
  });

  it('verify_chain() passes on the live ledger and catches an edited past block', async () => {
    const engine = await Engine.create();
    await runFor(engine, 3);
    const ok = await engine.checkChain(true);
    expect(ok!.ok).toBe(true);
    expect(ok!.blocks).toBe(engine.anchor.height);
    await engine.tamperLedger();
    expect(engine.chainStatus!.ok).toBe(false);
    expect(engine.chainStatus!.message).toMatch(/Tampering detected at index \d+: hash mismatch/);
    await runFor(engine, 7);
    expect(engine.ledgerTamper).toBeNull();
    expect((await engine.checkChain(true))!.ok).toBe(true);
  });

  it('demo: plays all four scenarios back to back and holds the false alarm', async () => {
    const engine = await Engine.create();
    engine.playDemo();
    const kinds = new Set<string>();
    let held = false;
    for (let i = 0; i < Math.round((DEMO_LENGTH_S + 0.5) / 0.05); i++) {
      engine.step();
      await engine.settle();
      if (engine.run) kinds.add(engine.run.kind);
      if (engine.state === 'CHECKING' && engine.detectors.AI.flag && !engine.run) held = true;
    }
    expect([...kinds].sort()).toEqual(['hijack', 'jam', 'spoof', 'tamper']);
    expect(held).toBe(true);
    expect(engine.runs.every((r) => r.escalatedAt !== null && r.respondedAt !== null)).toBe(true);
    expect(engine.corruptedToAnalyst).toBe(0);
  });
});

describe('signal facts quoted on the site', () => {
  it('derives the carrier, Doppler, power and amplitude from the link model', () => {
    expect(SIGNAL.carrierMHz).toBe(8477.8);
    expect(SIGNAL.dopplerMaxKHz).toBeCloseTo(199.0, 0);
    // ITU-R P.618 median atmosphere from the twin: 1.06 dB at the 2° mask, 0.05 dB overhead.
    expect(SIGNAL.atmosphereDb.mask).toBeCloseTo(1.064, 3);
    expect(SIGNAL.atmosphereDb.zenith).toBeCloseTo(0.047, 3);
    expect(atmosphericLossDb(13)).toBeCloseTo(0.2102, 4);
    expect(SIGNAL.rxDbm.mask).toBeCloseTo(-88.8, 1);
    expect(SIGNAL.rxDbm.zenith).toBeCloseTo(-74.4, 1);
    expect(SIGNAL.snrDb.mask).toBeCloseTo(11.2, 1);
    expect(SIGNAL.snrDb.zenith).toBeCloseTo(25.6, 1);
    expect(SIGNAL.amplitudeUv.mask).toBeCloseTo(11.4, 1);
    expect(SIGNAL.amplitudeUv.zenith).toBeCloseTo(60.0, 1);
    expect(SIGNAL.noiseUvRms).toBeCloseTo(2.24, 2);
    expect(peakMicrovolts(-100)).toBeCloseTo(rmsMicrovolts(-100) * Math.SQRT2, 9);
  });

  it('caps a noise-shaped jammer 5.3 dB below the floor to stay inside the χ² gate', () => {
    // 0.23 dB × √23.51: the most SNR a jammer can take before the power residual alone fires.
    expect(STEALTH.maxSnrLossDb).toBeCloseTo(1.115, 3);
    expect(STEALTH.maxNoiseAboveFloorDb).toBeCloseTo(-5.33, 2);
    expect(snrLossDb(STEALTH.maxNoiseAboveFloorDb)).toBeCloseTo(STEALTH.maxSnrLossDb, 9);
    expect(STEALTH.maxNoiseDbm).toBeCloseTo(-105.3, 1);
    // The old ±4 dB box band let an attacker hide 1.8 dB above the floor.
    expect(10 * Math.log10(10 ** (STEALTH.boxBandDb / 10) - 1)).toBeCloseTo(1.8, 1);
  });

  it('keeps natural jitter inside the χ² gate, as quoted', () => {
    const dop: number[] = [];
    const pow: number[] = [];
    const tim: number[] = [];
    const pha: number[] = [];
    for (let s = 0; s < 69 * 120; s += 0.05) {
      const p = passAt(s);
      if (!p.linkActive) continue;
      const x = sample(s, snrPredDb(p.rangeKm, p.elevationDeg), {
        attacks: [],
        falseAlarm: 0,
        dopplerPredHz: p.dopplerHz,
      });
      dop.push(x.dopplerHz);
      pow.push(x.snrDb - x.snrModelDb);
      tim.push(x.timingUs!);
      pha.push(x.phaseDeg);
    }
    const sd = (a: number[]) => {
      const m = a.reduce((x, y) => x + y, 0) / a.length;
      return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length);
    };
    const peak = (a: number[]) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expect(sd(dop)).toBeCloseTo(NATURAL.carrierHz.sigma, 0);
    expect(peak(dop)).toBeLessThanOrEqual(NATURAL.carrierHz.max + 0.5);
    expect(sd(pow)).toBeCloseTo(NATURAL.powerDb.sigma, 1);
    expect(peak(pow)).toBeLessThanOrEqual(NATURAL.powerDb.max + 0.02);
    expect(sd(tim)).toBeCloseTo(NATURAL.timingUs.sigma, 0);
    expect(peak(tim)).toBeLessThanOrEqual(NATURAL.timingUs.max + 0.1);
    expect(sd(pha)).toBeCloseTo(NATURAL.phaseDeg.sigma, 1);
    expect(peak(pha)).toBeLessThanOrEqual(NATURAL.phaseDeg.max + 0.1);
    // Each residual's largest natural excursion stays inside what the gate allows it alone.
    for (const k of ['carrierHz', 'powerDb', 'timingUs', 'phaseDeg'] as const) {
      expect(NATURAL[k].gate).toBeGreaterThan(1.3 * NATURAL[k].max);
    }
  });
});

describe('received spectrum', () => {
  it('shows the downlink channel SNR above a thermal floor on a clean pass', async () => {
    const engine = await Engine.create();
    await runFor(engine, 4);
    const st = spectrumState(engine);
    expect(st.link).toBe(true);
    expect(st.floorDb).toBe(0);
    expect(st.peaks).toHaveLength(1);
    expect(st.peaks[0].db).toBeCloseTo(engine.current!.snrDb, 6);
    expect(st.centreMHz).toBeCloseTo(engine.current!.carrierModelMHz, 6);

    const bins = new Float32Array(400);
    renderSpectrum(st, bins);
    const centre = 10 * Math.log10(bins.slice(195, 205).reduce((a, b) => a + b) / 10);
    const edge = 10 * Math.log10(bins.slice(0, 40).reduce((a, b) => a + b) / 40);
    expect(centre - edge).toBeGreaterThan(st.peaks[0].db - 3);
  });

  it('raises the floor under jamming, puts the hijacker at +14.2 MHz and 0x99A2 on the channel', async () => {
    const jam = await Engine.create();
    await runFor(jam, 1);
    jam.setPower(9);
    jam.trigger('jam');
    await runFor(jam, 1.5);
    expect(spectrumState(jam).floorDb).toBeGreaterThan(5);

    const hijack = await Engine.create();
    await runFor(hijack, 1);
    hijack.trigger('hijack');
    await runFor(hijack, 1.5);
    const rogue = spectrumState(hijack).peaks.find((p) => p.rogue);
    expect(rogue!.hz / 1e6).toBeGreaterThan(13.5);
    expect(rogue!.hz).toBeLessThan(SPAN_HZ / 2);

    const spoof = await Engine.create();
    await runFor(spoof, 1);
    spoof.trigger('spoof');
    await runFor(spoof, 1.2);
    const node = spectrumState(spoof).peaks.find((p) => p.rogue);
    expect(Math.abs(node!.hz)).toBeLessThan(CHANNEL_HZ / 2);
  });
});

describe('uplink telecommands', () => {
  const genuine = {
    satelliteId: 'TERRASAR-X',
    seq: 4097,
    t: 12.5,
    opcode: 'SET_MODE',
    args: 'IMAGING',
  };
  const hmacKey = (seed: number) =>
    crypto.subtle.importKey(
      'raw',
      Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + seed) & 0xff),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );

  it('executes only what mission control sealed, once, in order', async () => {
    const key = await hmacKey(1);
    const tag = await sealCommand(key, genuine);
    const onboard = new OnboardVerifier();
    expect((await onboard.verify(key, genuine, tag)).verdict).toBe('EXECUTED');
    expect(onboard.lastExecuted).toBe(4097);

    // Tampered in flight: the transmitter goes off, the original tag rides along.
    const tampered = await onboard.verify(key, { ...genuine, seq: 4098, ...ROGUE_COMMAND }, tag);
    expect([tampered.macOk, tampered.verdict]).toEqual([false, 'REJECTED']);

    // Forged under a guessed key.
    const forged = { ...genuine, seq: 4099, ...ROGUE_COMMAND };
    const injected = await onboard.verify(key, forged, await sealCommand(await hmacKey(2), forged));
    expect([injected.macOk, injected.verdict]).toEqual([false, 'REJECTED']);

    // Replayed: the tag is genuine, the count is old.
    const replayed = await onboard.verify(key, genuine, tag);
    expect([replayed.macOk, replayed.fresh, replayed.verdict]).toEqual([true, false, 'REJECTED']);
    expect(onboard.lastExecuted).toBe(4097);

    expect(commandText(genuine)).toBe('TC|TERRASAR-X|4097|12.500|SET_MODE|IMAGING');
    expect(constantTimeEqual(tag, tag)).toBe(true);
    expect(constantTimeEqual(tag, tag.slice(0, -1) + (tag.endsWith('0') ? '1' : '0'))).toBe(false);
    expect(constantTimeEqual(tag, tag.slice(0, -2))).toBe(false);
  });

  it('keeps flying routine commands and rejects every hostile one on board', async () => {
    const engine = await Engine.create();
    await runFor(engine, 3);
    expect(engine.pass.linkActive).toBe(true);
    expect(engine.uplinkStats.executed).toBeGreaterThan(0);
    expect(engine.uplink.every((r) => r.verdict === 'EXECUTED' && r.threat === null)).toBe(true);

    for (const threat of UPLINK_THREATS) {
      const before = engine.uplink.length;
      expect(engine.triggerUplink(threat)).toBe(true);
      expect(engine.trigger('hijack')).toBe(false);
      await runFor(engine, 1.5);
      expect(engine.state).toBe('UNDER ATTACK');
      expect(engine.banner?.kind).toBe(threat);
      await runFor(engine, UPLINK_RUN_S);
      expect(engine.uplinkRun).toBeNull();

      const run = engine.uplinkRuns[engine.uplinkRuns.length - 1];
      expect(run.threat).toBe(threat);
      expect(run.blocked).toBeGreaterThan(0);
      expect(run.executed).toBe(0);
      const received = engine.uplink.slice(0, engine.uplink.length - before);
      const hostile = received.filter((r) => r.threat === threat);
      expect(hostile.length).toBe(run.blocked);
      expect(hostile.every((r) => r.verdict === 'REJECTED')).toBe(true);
      if (threat === 'cmdreplay') expect(hostile.every((r) => r.macOk && !r.fresh)).toBe(true);
      else expect(hostile.every((r) => !r.macOk)).toBe(true);
      if (threat !== 'cmdtamper') {
        expect(received.some((r) => r.threat === null && r.verdict === 'EXECUTED')).toBe(true);
      }
      await runFor(engine, 2.5);
      expect(engine.state).not.toBe('UNDER ATTACK');
    }
    expect(engine.uplinkStats.hostileExecuted).toBe(0);
    const seqs = engine.uplink.filter((r) => r.verdict === 'EXECUTED').map((r) => r.seq);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeLessThan(seqs[i - 1]);
  });
});
