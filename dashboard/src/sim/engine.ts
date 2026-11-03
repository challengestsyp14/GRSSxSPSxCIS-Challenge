// Testbed engine: one LEO pass over the Zaghouan ground station, framed and sealed for real,
// attacked on demand, and defended by the digital twin's three tiers:
// 1. data layer: trust_anchor.py (HMAC-SHA256 seal, anti-replay window, SHA-256 chain from the
//    same genesis block) and the cleared identity of zero_trust.py;
// 2. statistical layer: the Isolation Forest of detector.py on orbit residuals;
// 3. physical layer: security_detector.py, the chi-square of range, Doppler, power and carrier
//    phase against the orbit and the ITU-R link budget, and the kinematic coupling of range and
//    Doppler.
// Each frame is decided as physics_validator.py decides it: either deterministic layer rejects,
// the statistical layer alone holds. Incident response escalates when two tiers flag at once.
// Each frame leaves a packet record for the inspection drawer. The trust anchor also checks an
// Ed25519 signature from the spacecraft at each re-key; its log is streamed as the
// trust_anchor.py terminal.
//
// Everything here is emulation. No component transmits or receives RF.

import * as copy from './copy';
import { AiModel, FLAG_AT, featureVector } from './aiModel';
import { FRAME_PERIOD_S } from './constants';
import {
  EmulatedHsm,
  createEd25519,
  encodeText,
  importMacKey,
  toHex,
  type Ed25519Identity,
} from './crypto';
import {
  LinkDetector,
  RATE_WINDOW,
  ROGUE_TOKEN,
  SAT_ID,
  SAT_TOKEN,
  setSatelliteIdentity,
  type Decision,
  type DetectorResult,
  type RfMeasurement,
} from './linkDetector';
import {
  PhysicsEngine,
  rangeJerkBoundFor,
  type ChiSquareResult,
  type LinkState,
  type PhysicsResult,
  type Residual,
} from './physicsEngine';
import { BURST_FAILURES, BURST_WINDOW, decide } from './validator';
import {
  OnboardVerifier,
  ROGUE_COMMAND,
  ROGUE_UPLINK,
  ROUTINE,
  sealCommand,
  type Telecommand,
  type UplinkThreat,
  type UplinkVerdict,
} from './uplink';
import {
  TrustAnchorLedger,
  seal,
  type AuthReason,
  type Block,
  type ChainCheck,
  type Frame,
} from './trustAnchor';
import {
  C_KM_S,
  PERIOD_S,
  UPLINK,
  atmosphericLossDb,
  passAt,
  passProfile,
  setPassProfile,
  snrPredDb,
  timeAfterAos,
  timeCompression,
  uplinkRxDbm,
  type PassState,
} from './geometry';
import { DEFAULT_PLAN, loadFlight, type FlightPlan } from './fleet';
import { clamp, easeInOutCubic, mulberry32, win } from './noise';
import { stealthBudgetAt } from './linkFacts';
import {
  envelope,
  jamSnrLossDb,
  sample,
  type Attack,
  type AttackKind,
  type Sample,
} from './signals';

export const TICK_S = 0.05;
export const WINDOW_S = 7;
export const HISTORY = Math.round(WINDOW_S / TICK_S);
export { FRAME_PERIOD_S };
const PACKET_RECORDS = 160;
const CHAIN_CHECK_EVERY_S = 5;
const LEDGER_ROWS = 60;
const RESPONSE_DELAY_S: Record<AttackKind, number> = {
  hijack: 4.8,
  spoof: 2.8,
  jam: 2.8,
  tamper: 2.8,
};
const UNANSWERED_END_S = 8;
const UNDETECTED_END_S = 6;
const ATTACKER_SHARE: Record<AttackKind, number> = {
  hijack: 0.75,
  spoof: 0.75,
  jam: 0,
  tamper: 0.75,
};
const TERMINAL_LINES = 160;
/** One routine telecommand per this many scene seconds while the link is up. */
const UPLINK_PERIOD_S = 1.1;
/** Hostile commands come this often during an uplink attack, which lasts UPLINK_RUN_S. */
const HOSTILE_PERIOD_S = 0.7;
/** An element set older than this is flagged as stale in the ledger. */
export const ELEMENT_SET_STALE_DAYS = 3;
export const UPLINK_RUN_S = 5;
const HANDSHAKE_EVERY_S = 8;

export type SystemState = 'NOMINAL' | 'CHECKING' | 'UNDER ATTACK' | 'JAMMING' | 'RECOVERING';
export type Verdict = 'VERIFIED' | 'MAC FAIL' | 'REPLAY' | 'LOST' | 'QUARANTINED';
export type DetectorId = 'PHYSICS' | 'TRUST' | 'AI';
export type Route = 'ZAG' | 'MAT';
export type FrameLabel = 'genuine' | AttackKind;

export type TermTone = 'info' | 'ok' | 'bad' | 'warn' | 'dim';

export interface TermLine {
  id: number;
  t: number;
  text: string;
  tone: TermTone;
}

/** The physical layer's live view of the current sample (chi-square only, no anchor). */
export interface LivePhysics {
  chi: ChiSquareResult;
  noFrames: boolean;
  breach: boolean;
}

/** The physical layer points at this residual: alone outside the gate, or driving a breach. */
export function axisFlag(p: LivePhysics | null, name: Residual): boolean {
  if (!p) return false;
  const z = Math.abs(p.chi.normalized[name]);
  return z > Math.sqrt(p.chi.threshold) || (p.chi.chiSquareBreach && p.chi.dominant === name);
}

export interface TelemetryPoint {
  s: number;
  x: Sample | null;
  physics: LivePhysics | null;
}

/** What the signal claimed and what the orbit and link budget said it must be. */
export interface LinkClaim {
  rx: LinkState;
  truth: LinkState;
  elevationDeg: number;
  /** ITU-R P.618 median atmospheric loss in the predicted power, dB. */
  atmosphereDb: number;
  /** Real seconds since the start of the run (scene time times the pass compression). */
  tReal: number;
}

export interface LedgerRow {
  id: number;
  seq: number | null;
  hash: string | null;
  source: string;
  verdict: Verdict;
  original: Verdict;
  label: FrameLabel;
  t: number;
  overheadMs: number;
}

export interface TxFrame {
  seq: number;
  t: number;
  /** satellite_id|sequence|timestamp|hw_token, the frame header as sealed. */
  frameHeader: string;
  payloadHex: string;
  macHex: string;
  epoch: number;
}

/** Everything the station saw and decided about one frame, for the inspection drawer. */
export interface PacketRecord {
  id: number;
  /** Scene time of reception. */
  t: number;
  /** Red-team ground truth, known to the simulator only; no detector reads it. */
  label: FrameLabel;
  /**
   * An attack was active when the frame arrived, or ended within the last RATE_WINDOW frame slots,
   * while the forest's failure rates still remember it (genuine frames included).
   */
  underAttack: boolean;
  source: string;
  /** null when jamming left nothing to decode. */
  frame: Frame | null;
  frameText: string | null;
  mac: string | null;
  expectedMac: string | null;
  frameDigest: string | null;
  keyEpoch: number;
  /** Tampering only: the payload as sealed on board, and the bit flipped in transit. */
  originalPayload: string | null;
  flipped: { byte: number; bit: number } | null;
  auth: { ok: boolean; reason: AuthReason | 'NO_FRAME' };
  block: Pick<Block, 'index' | 'previous_hash' | 'hash'> | null;
  rf: RfMeasurement | null;
  /** Physical layer: the claim, the prediction and the chi-square engine's verdict. */
  link: LinkClaim | null;
  physics: PhysicsResult | null;
  detector: DetectorResult | null;
  decision: Decision;
  authMs: number;
  detectorMs: number;
}

export type StatKey = FrameLabel | 'genuineUnderAttack';

export interface LayerStats {
  frames: number;
  /** Frames that reached the trust anchor (jamming leaves nothing to decode). */
  decoded: number;
  anchor: number;
  physics: number;
  forest: number;
  detector: number;
  blocked: number;
  /** Frames that raised an alarm: blocked, or delivered tagged as degraded. */
  flagged: number;
  /** Frames delivered tagged as degraded: genuine, on a jammed link. */
  degraded: number;
  /** Frames the statistical layer alone held for review. */
  held: number;
  /** Per run: milliseconds from attack onset to the first blocked attack frame. */
  firstBlockMs: number[];
}

export interface ChainStatus extends ChainCheck {
  full: boolean;
  blocks: number;
  at: number;
}

export interface DetectorState {
  flag: boolean;
  /** Milliseconds from attack start to this detector's first flag, for the current run. */
  latencyMs: number | null;
  evaded: boolean;
}

export interface Run {
  kind: AttackKind;
  tTrigger: number;
  start: number;
  escalatedAt: number | null;
  escalateMs: number | null;
  rejectMs: number | null;
  latency: Record<DetectorId, number | null>;
  auto: boolean;
  ended: boolean;
  respondedAt: number | null;
  firstRowId: number;
  demo: boolean;
  firstBlockMs: number | null;
  /** A frame with a valid tag but a foreign token, or new content under a stale nonce. */
  keyHolder: boolean;
}

export type Tone = 'bad' | 'warn' | 'ok';

export interface BannerState {
  kind: AttackKind | UplinkThreat;
  tone: Tone;
  headline: string;
  detail: string;
  shownAt: number;
  hideAt: number | null;
}

/** One telecommand as the spacecraft received and judged it. */
export interface UplinkRecord {
  id: number;
  /** Scene time of reception on board. */
  t: number;
  seq: number;
  opcode: string;
  args: string;
  /** Who transmitted it: the station, the rogue uplink, or the station's command replayed. */
  source: string;
  /** Red-team ground truth, for the jury; the decoder never reads it. */
  threat: UplinkThreat | null;
  tag: string;
  expected: string;
  macOk: boolean;
  fresh: boolean;
  verdict: UplinkVerdict;
  reason: string;
  /** Doppler and power the on-board receiver sees on the S-band uplink. */
  dopplerHz: number;
  rxDbm: number;
}

export interface UplinkRun {
  threat: UplinkThreat;
  tTrigger: number;
  until: number;
  /** Hostile commands rejected on board, and executed (must stay zero). */
  blocked: number;
  executed: number;
}

export type CalloutTarget = 'sat' | 'station' | 'telemetry' | 'ledger' | 'fusion' | 'deck';

export interface Callout {
  id: number;
  text: string;
  sub?: string;
  target: CalloutTarget;
  tone: Tone | 'info';
  until: number;
}

interface Arrival {
  t: number;
  outcome: 'ok' | 'fail' | 'lost';
}

interface DemoEvent {
  at: number;
  run: (engine: Engine) => void;
}

const DEMO_EVENTS: DemoEvent[] = [
  { at: 0.4, run: (e) => e.say(copy.TOUR_CALLOUTS.controls, 'deck', 'info', 4) },
  { at: 7.4, run: (e) => e.say(copy.TOUR_CALLOUTS.lock, 'sat', 'info', 3.4) },
  { at: 10.2, run: (e) => e.say(copy.TOUR_CALLOUTS.gate, 'telemetry', 'info', 3.2) },
  { at: 12.2, run: (e) => e.say(copy.TOUR_CALLOUTS.chain, 'ledger', 'info', 3) },
  { at: 14.7, run: (e) => e.startFalseAlarm(1.5) },
  { at: 16.3, run: (e) => (e.heavyBatch = true) },
  { at: 17.9, run: (e) => (e.heavyBatch = false) },
  { at: 21.5, run: (e) => e.trigger('hijack', { demo: true }) },
  { at: 29.5, run: (e) => e.trigger('tamper', { demo: true }) },
  { at: 35.5, run: (e) => e.trigger('spoof', { demo: true }) },
  { at: 41.5, run: (e) => e.trigger('jam', { demo: true }) },
  { at: 48.5, run: (e) => e.stopDemo() },
];
export const DEMO_LENGTH_S = 48.5;

export class Engine {
  s = 0;
  pass: PassState;
  current: Sample | null = null;
  physics: LivePhysics | null = null;
  history: TelemetryPoint[] = [];

  ledger: LedgerRow[] = [];
  txLog: TxFrame[] = [];
  keyEpoch = 0x3f;
  keyFlashAt = -10;
  route: Route = 'ZAG';
  handoverAt = -10;

  power = 9;
  autoResponse = true;
  logEvents = true;
  heldOut = true;

  attack: Attack | null = null;
  run: Run | null = null;
  runs: Run[] = [];
  detectors: Record<DetectorId, DetectorState> = {
    PHYSICS: { flag: false, latencyMs: null, evaded: false },
    TRUST: { flag: false, latencyMs: null, evaded: false },
    AI: { flag: false, latencyMs: null, evaded: false },
  };
  votes = 0;
  state: SystemState = 'NOMINAL';
  banner: BannerState | null = null;
  callouts: Callout[] = [];
  statusLine = 'Ready · standard scenario';

  anomaly = 0.08;
  spoofLikelihood = 0.04;
  aiScore = 0.08;
  aiDriver = 0;
  features: number[] = [0, 0, 0, 0, 0, 0];
  heavyBatch = false;
  batchLoad = 0.32;

  quarantineUntil = -10;
  compromised: { from: number; to: number } | null = null;
  recoveringUntil = -10;

  /** Telecommand uplink, ground to satellite: what the spacecraft received, newest first. */
  uplink: UplinkRecord[] = [];
  uplinkStats = { sent: 0, executed: 0, rejected: 0, hostileExecuted: 0 };
  uplinkRun: UplinkRun | null = null;
  uplinkRuns: UplinkRun[] = [];

  framesSent = 0;
  framesVerified = 0;
  framesReceived = 0;
  framesRejected = 0;
  rejectedMac = 0;
  rejectedNonce = 0;
  framesLost = 0;
  corruptedToAnalyst = 0;
  overheadMs: number[] = [];

  demo: { active: boolean; t0: number; next: number } = { active: false, t0: 0, next: 0 };
  eventCount = 0;

  terminal: TermLine[] = [];
  blockHeight = 0;
  readonly signer: Ed25519Identity | null;
  handshakes = 0;

  /** Browser ports of trust_anchor.py and detector.py. */
  readonly anchor: TrustAnchorLedger;
  readonly linkDetector: LinkDetector;
  /** Port of security_detector.py; frames go through it in order, for the kinematic anchor. */
  readonly physicsEngine: PhysicsEngine;
  packets: PacketRecord[] = [];
  layerStats: Partial<Record<StatKey, LayerStats>> = {};
  heldByZeroTrust = 0;
  /** SHA-256 of the element set flown (its two lines), recorded at start-up. */
  elementSetSha256: string | null = null;
  /** Genuine frames delivered tagged as degraded (a jammed link). */
  degradedToAnalyst = 0;
  /** Authentication results of the last BURST_WINDOW decoded frames, for the burst rule. */
  private authWindow: boolean[] = [];
  /** Frame slots since the last one an attack was active in. */
  private slotsSinceAttack = Infinity;
  /** Digests of frames received with a valid tag: a replay repeats one, a key holder does not. */
  private seenDigests = new Set<string>();
  private burstActive = false;
  chainStatus: ChainStatus | null = null;
  /** Red-team edit of a past ledger block, restored after a few seconds. */
  ledgerTamper: { index: number; until: number } | null = null;

  readonly ai: AiModel;
  private passOffset: number;
  private acc = 0;
  private nextFrameAt = 0;
  private genuineSeq = 1_048_576;
  private arrivals: Arrival[] = [];
  private lastPhysicsViolation = -10;
  private rowId = 0;
  private calloutId = 0;
  private packetId = 0;
  private verifiedUpTo = 0;
  /** verify_chain() runs are serialised, so a status never reflects a half-finished check. */
  private chainChecks: Promise<unknown> = Promise.resolve();
  private nextChainCheckAt = CHAIN_CHECK_EVERY_S;
  private ledgerTamperOriginal: Block['payload'] | null = null;
  private termId = 0;
  private nextHandshakeAt = HANDSHAKE_EVERY_S;
  private queue: Promise<void> = Promise.resolve();
  private readonly rand = mulberry32(20261108);
  private falseAlarm: { from: number; to: number } | null = null;
  private faCallout: 'none' | 'held' | 'cleared' = 'none';
  private listeners = new Set<() => void>();
  private recentVectors: number[][] = [];
  private aiEvals: { t: number; n: number }[] = [];

  private readonly hsm: EmulatedHsm;
  private readonly attackerKey: CryptoKey;
  private readonly onboard = new OnboardVerifier();
  private tcSeq = 4096;
  private uplinkId = 0;
  private nextCommandAt = 0.6;
  private nextHostileAt = 0;
  /** Genuine commands a replay attacker has recorded off the air. */
  private recorded: { c: Telecommand; tag: string }[] = [];

  private constructor(
    hsm: EmulatedHsm,
    attackerKey: CryptoKey,
    ai: AiModel,
    anchor: TrustAnchorLedger,
    signer: Ed25519Identity | null,
  ) {
    this.hsm = hsm;
    this.attackerKey = attackerKey;
    this.ai = ai;
    this.anchor = anchor;
    this.linkDetector = new LinkDetector();
    this.physicsEngine = new PhysicsEngine({
      rangeJerkBoundKmS3: rangeJerkBoundFor(passProfile().altitudeKm),
    });
    this.signer = signer;
    const genesis = anchor.genesisRoot;
    this.passOffset = timeAfterAos(8);
    this.pass = passAt(this.passOffset);

    this.log(`$ python trust_anchor.py --node ${copy.STATION} --link x-band`, 'dim');
    this.log(`genesis root ${genesis.slice(0, 24)}…${genesis.slice(-8)}`, 'info');
    if (signer) {
      this.log(`Ed25519 pub ${copy.SATELLITE} ${signer.publicHex.slice(0, 24)}…`, 'info');
    } else {
      this.log('Ed25519 unavailable in this browser · HMAC-SHA256 seals only', 'warn');
    }
    this.handshake('session open');
  }

  static async create(plan: FlightPlan = DEFAULT_PLAN): Promise<Engine> {
    const [hsm, attackerKey, anchor, signer, profile] = await Promise.all([
      EmulatedHsm.create(),
      importMacKey(crypto.getRandomValues(new Uint8Array(32))),
      TrustAnchorLedger.create(),
      createEd25519(),
      loadFlight(plan),
    ]);
    // The live pass and the satellite's identity are in place before the models train.
    setPassProfile(profile);
    setSatelliteIdentity(profile.satName, profile.noradId ?? 31698);
    copy.setSatelliteName(profile.satName, profile.noradId ?? 31698);
    const engine = new Engine(hsm, attackerKey, new AiModel(), anchor, signer);
    await engine.recordElementSet(profile);
    return engine;
  }

  /**
   * Records the SHA-256 of the element set flown and checks its epoch: the relay that served it
   * is not trusted for integrity, so the ledger keeps what was used. A stale set drifts the χ²
   * prediction; the kinematic test of range against Doppler needs no orbit and still holds.
   */
  private async recordElementSet(profile: ReturnType<typeof passProfile>) {
    if (!profile.tleLines) return;
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(profile.tleLines.join('\n')),
    );
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const ageDays =
      profile.tleEpochMs === null ? null : (Date.now() - profile.tleEpochMs) / 86_400_000;
    const age = ageDays === null ? 'epoch unknown' : `epoch age ${ageDays.toFixed(1)} d`;
    const stale = ageDays !== null && ageDays > ELEMENT_SET_STALE_DAYS;
    this.elementSetSha256 = hex;
    this.log(
      `orbit: element set sha256 ${hex.slice(0, 16)}…${hex.slice(-6)} · ${age}` +
        (stale ? ' · stale: χ² prediction drifts, kinematic test still holds' : ' · fresh'),
      stale ? 'warn' : 'info',
    );
  }

  /** Root of the ledger: SHA-256 of the genesis block, identical to trust_anchor.py. */
  get genesis(): string {
    return this.anchor.genesisRoot;
  }

  // ---------------------------------------------------------------- trust_anchor.py log

  log(text: string, tone: TermTone = 'info') {
    this.terminal.push({ id: ++this.termId, t: this.s, text, tone });
    if (this.terminal.length > TERMINAL_LINES) this.terminal.shift();
  }

  /** Signs a fresh challenge with the spacecraft's Ed25519 key and verifies it at the station. */
  private handshake(reason: string) {
    const signer = this.signer;
    if (!signer) return;
    const epoch = this.keyEpoch;
    const challenge = encodeText(`${copy.STATION}|epoch:${epoch}|t:${this.s.toFixed(2)}`);
    this.queue = this.queue.then(async () => {
      const signature = await signer.sign(challenge);
      const ok = await signer.verify(challenge, signature);
      this.handshakes++;
      this.log(
        `Ed25519 auth ${ok ? '✓' : '✗'} ${reason} · sig ${toHex(signature).slice(0, 12)}…`,
        ok ? 'ok' : 'bad',
      );
    });
  }

  // ---------------------------------------------------------------- subscriptions

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    this.eventCount++;
    for (const l of this.listeners) l();
  }

  /** Waits for every queued frame to finish cryptographic processing (tests). */
  settle(): Promise<void> {
    return this.queue;
  }

  // ---------------------------------------------------------------- controls

  get busy(): boolean {
    return this.attack !== null || this.uplinkRun !== null;
  }

  trigger(kind: AttackKind, opts: { demo?: boolean } = {}): boolean {
    if (this.attack || this.uplinkRun) return false;
    const s = this.s;
    const power =
      kind === 'jam' && opts.demo
        ? (t: number) => (t < s ? 0 : 2 + 10 * easeInOutCubic(t - (s + 1.1)))
        : () => this.power;

    this.attack = { kind, tTrigger: s, tResponse: s + UNDETECTED_END_S, power };
    this.run = {
      kind,
      tTrigger: s,
      start: s + 0.05,
      escalatedAt: null,
      escalateMs: null,
      rejectMs: null,
      latency: { PHYSICS: null, TRUST: null, AI: null },
      auto: this.autoResponse,
      ended: false,
      respondedAt: null,
      firstRowId: this.rowId + 1,
      demo: Boolean(opts.demo),
      firstBlockMs: null,
      keyHolder: false,
    };
    for (const d of Object.values(this.detectors)) {
      d.latencyMs = null;
      d.evaded = false;
    }
    this.statusLine = `Running: ${copy.ATTACK_BUTTONS[kind].running}`;
    this.emit();
    return true;
  }

  setPower(db: number) {
    this.power = clamp(db, 0, 15);
  }

  /** Power currently applied by the running attack (the demo ramps it). */
  get appliedPower(): number {
    if (this.attack && this.run?.demo && this.attack.kind === 'jam')
      return this.attack.power(this.s);
    return this.power;
  }

  playDemo() {
    if (this.demo.active) return;
    this.attack = null;
    this.run = null;
    this.uplinkRun = null;
    this.banner = null;
    this.compromised = null;
    this.route = 'ZAG';
    this.autoResponse = true;
    // Start a fresh pass so the whole schedule plays with the satellite in view.
    this.passOffset = timeAfterAos(3) - this.s;
    this.queue = this.queue.then(() => this.physicsEngine.reset());
    this.demo = { active: true, t0: this.s, next: 0 };
    this.statusLine = 'Ready · standard scenario';
    this.emit();
  }

  stopDemo() {
    this.demo.active = false;
    this.heavyBatch = false;
    this.emit();
  }

  startFalseAlarm(duration: number) {
    this.falseAlarm = { from: this.s, to: this.s + duration };
    this.faCallout = 'none';
  }

  say(
    c: { text: string; sub?: string },
    target: CalloutTarget,
    tone: Tone | 'info',
    seconds: number,
  ) {
    this.callouts.push({
      id: ++this.calloutId,
      text: c.text,
      sub: c.sub,
      target,
      tone,
      until: this.s + seconds,
    });
    if (this.callouts.length > 4) this.callouts.shift();
  }

  // ---------------------------------------------------------------- clock

  advance(realDtS: number) {
    this.acc += Math.min(realDtS, 0.25);
    let steps = 0;
    while (this.acc >= TICK_S && steps < 8) {
      this.step();
      this.acc -= TICK_S;
      steps++;
    }
  }

  step() {
    this.s += TICK_S;
    const s = this.s;

    if (this.demo.active) {
      const t = s - this.demo.t0;
      while (this.demo.next < DEMO_EVENTS.length && DEMO_EVENTS[this.demo.next].at <= t) {
        DEMO_EVENTS[this.demo.next++].run(this);
      }
    }

    const previousInView = this.pass.inView;
    this.pass = passAt(s + this.passOffset);
    if (this.route === 'MAT' && previousInView && !this.pass.inView) {
      this.route = 'ZAG';
      this.log(`route restored → ${copy.STATION} for the next pass`, 'info');
    }

    this.updateLifecycle(s);

    const attacks =
      this.attack && !(this.route === 'MAT' && this.attack.kind === 'jam') ? [this.attack] : [];
    const falseAlarm = this.falseAlarm
      ? win(s, this.falseAlarm.from, this.falseAlarm.to, 0.15, 0.4)
      : 0;

    if (this.pass.linkActive) {
      const handoverLoss = this.route === 'MAT' ? 1.2 : 0;
      this.current = sample(
        s,
        snrPredDb(this.pass.rangeKm, this.pass.elevationDeg) - handoverLoss,
        {
          attacks,
          falseAlarm,
          dopplerPredHz: this.pass.dopplerHz,
        },
      );
      const claim = this.claim(this.current);
      const chi = this.physicsEngine.chiSquare(claim.rx, claim.truth, claim.elevationDeg);
      const noFrames = this.current.timingUs === null;
      this.physics = { chi, noFrames, breach: chi.chiSquareBreach || noFrames };
      if (this.physics.breach) this.lastPhysicsViolation = s;
    } else {
      // A new pass starts a new kinematic reference.
      if (this.current) this.queue = this.queue.then(() => this.physicsEngine.reset());
      this.current = null;
      this.physics = null;
    }
    this.history.push({ s, x: this.current, physics: this.physics });
    if (this.history.length > HISTORY) this.history.shift();

    if (this.pass.linkActive) {
      if (s >= this.nextFrameAt) {
        this.emitFrame(s);
        // On the 0.32 s grid, not 0.32 s after the tick that sent it: 3.1 frames a second.
        this.nextFrameAt = Math.max(this.nextFrameAt + FRAME_PERIOD_S, s);
      }
    } else {
      this.nextFrameAt = s;
    }

    this.updateUplink(s);
    this.updateDetectors(s);
    this.updateState(s);

    if (s >= this.nextHandshakeAt) {
      this.nextHandshakeAt = s + HANDSHAKE_EVERY_S;
      if (this.pass.linkActive) this.handshake('periodic');
    }
    if (s >= this.nextChainCheckAt) {
      this.nextChainCheckAt = s + CHAIN_CHECK_EVERY_S;
      // While the red-team edit is live, keep showing the full check that caught it.
      if (!this.ledgerTamper) void this.checkChain(false);
    }
    if (this.ledgerTamper && s >= this.ledgerTamper.until) this.restoreLedger();

    this.batchLoad +=
      ((this.heavyBatch ? 0.88 : 0.3 + 0.08 * Math.sin(s * 0.7)) - this.batchLoad) * 0.12;
    this.callouts = this.callouts.filter((c) => c.until > s);
    const banner = this.banner;
    if (banner && banner.hideAt !== null && s >= banner.hideAt) this.banner = null;
    while (this.arrivals.length && this.arrivals[0].t < s - 3) this.arrivals.shift();
    while (this.aiEvals.length && this.aiEvals[0].t < s - 1) this.aiEvals.shift();
  }

  // ---------------------------------------------------------------- frames

  /** The link as measured against the link as predicted, for the physical layer. */
  private claim(x: Sample): LinkClaim {
    const pass = this.pass;
    return {
      rx: {
        rangeKm: pass.rangeKm + (x.timingUs ?? 0) * C_KM_S * 1e-6,
        dopplerHz: pass.dopplerHz + x.dopplerHz,
        rssiDbm: x.rssiDbm,
        phaseDeg: x.phaseDeg,
      },
      truth: {
        rangeKm: pass.rangeKm,
        dopplerHz: pass.dopplerHz,
        rssiDbm: x.rssiModelDbm,
        phaseDeg: 0,
      },
      elevationDeg: pass.elevationDeg,
      atmosphereDb: atmosphericLossDb(pass.elevationDeg),
      tReal: this.s * timeCompression(),
    };
  }

  private emitFrame(s: number) {
    const x = this.current;
    const rf: RfMeasurement | null = x
      ? {
          carrierMHz: x.carrierMHz,
          carrierModelMHz: x.carrierModelMHz,
          rssiDbm: x.rssiDbm,
          rssiModelDbm: x.rssiModelDbm,
          evmPct: x.evmPct,
          evmModelPct: x.evmModelPct,
          timingUs: x.timingUs,
          t: s,
        }
      : null;
    const link = x && x.timingUs !== null ? this.claim(x) : null;
    const attacking = this.attack !== null && envelope(this.attack, s) > 0.05;
    this.slotsSinceAttack = attacking ? 0 : this.slotsSinceAttack + 1;
    const underAttack = this.slotsSinceAttack <= RATE_WINDOW;

    if (x && x.timingUs === null) {
      this.framesLost++;
      this.arrivals.push({ t: s, outcome: 'lost' });
      this.log(`⚠ frame missing · RSSI ${x.rssiDbm.toFixed(1)} dBm`, 'warn');
      this.pushRow({
        seq: null,
        hash: null,
        source: 'no signal',
        verdict: 'LOST',
        label: 'jam',
        t: s,
        overheadMs: 0,
      });
      // Nothing to authenticate or range, but the RF still goes through the forest.
      this.queue = this.queue.then(() => {
        const t0 = performance.now();
        const detection = rf ? this.linkDetector.evaluate(rf) : null;
        if (rf) this.linkDetector.observe(rf, false);
        this.record({
          t: s,
          label: 'jam',
          underAttack,
          source: 'no signal',
          frame: null,
          frameText: null,
          mac: null,
          expectedMac: null,
          frameDigest: null,
          keyEpoch: this.keyEpoch,
          originalPayload: null,
          flipped: null,
          auth: { ok: false, reason: 'NO_FRAME' },
          block: null,
          rf,
          link: null,
          physics: null,
          detector: detection,
          decision: decide(null, null, null, detection),
          authMs: 0,
          detectorMs: performance.now() - t0,
        });
      });
      return;
    }

    const kind = this.attack?.kind;
    const active = this.attack && kind && envelope(this.attack, s) > 0.3;
    const roll = this.rand();
    const route = this.route;
    const genuineSource = `${copy.SATELLITE} · VC1 · ${route}`;

    if (active && kind && kind !== 'tamper' && roll < ATTACKER_SHARE[kind]) {
      // The hijacker pushes the next sequence number; node 0x99A2 forges nonces from recent ones.
      const frame: Frame = {
        satellite_id: SAT_ID,
        sequence:
          kind === 'spoof' ? this.genuineSeq - Math.floor(this.rand() * 24) : this.genuineSeq + 1,
        timestamp: Date.now() / 1000,
        hw_token: kind === 'spoof' ? ROGUE_TOKEN : SAT_TOKEN,
        payload: toHex(this.payload()),
      };
      const source = kind === 'spoof' ? `NODE ${copy.ROGUE_NODE}` : 'ROGUE-TX +14.2 MHz';
      this.queue = this.queue.then(async () => {
        const mac = await seal(this.attackerKey, frame);
        await this.verify(frame, mac, source, kind, s, rf, link, underAttack, null);
      });
      return;
    }

    const epoch = this.keyEpoch;
    const frame: Frame = {
      satellite_id: SAT_ID,
      sequence: ++this.genuineSeq,
      timestamp: Date.now() / 1000,
      hw_token: SAT_TOKEN,
      payload: toHex(this.payload()),
    };
    // Data tampering: a relay in the path flips one payload bit after the satellite sealed it.
    const tampered = active && kind === 'tamper' && roll < ATTACKER_SHARE.tamper;
    this.framesSent++;
    this.queue = this.queue.then(async () => {
      const key = await this.hsm.epochKey(epoch);
      const mac = await seal(key, frame);
      this.txLog.unshift({
        seq: frame.sequence,
        t: s,
        frameHeader: `${frame.satellite_id}|${frame.sequence}|${frame.timestamp.toFixed(6)}|${frame.hw_token}`,
        payloadHex: frame.payload,
        macHex: mac,
        epoch,
      });
      if (this.txLog.length > 8) this.txLog.pop();
      if (tampered) {
        const byte = Math.floor(this.rand() * 16);
        const bit = Math.floor(this.rand() * 8);
        const bytes = frame.payload.match(/../g)!.map((h) => parseInt(h, 16));
        bytes[byte] ^= 1 << bit;
        const received = {
          ...frame,
          payload: bytes.map((b) => b.toString(16).padStart(2, '0')).join(''),
        };
        await this.verify(received, mac, genuineSource, 'tamper', s, rf, link, underAttack, {
          originalPayload: frame.payload,
          flipped: { byte, bit },
        });
      } else {
        // On a jammed link the genuine frames that still decode are the jam's frames, while the
        // jam costs more SNR than the stealth budget at this elevation. Below it the jam is
        // bounded and hidden by design: its frames count as genuine frames under attack, as the
        // twin reports its below-the-gate jams apart from the attack packets.
        const jam = this.attack;
        const visible =
          active &&
          kind === 'jam' &&
          jam !== null &&
          envelope(jam, s) * jamSnrLossDb(jam.power(s)) >=
            stealthBudgetAt(this.pass.elevationDeg).maxSnrLossDb;
        const label: FrameLabel = visible ? 'jam' : 'genuine';
        await this.verify(frame, mac, genuineSource, label, s, rf, link, underAttack, null);
      }
    });
  }

  private payload(): Uint8Array {
    // 16 bytes, as in ingester.py.
    const p = new Uint8Array(16);
    for (let i = 0; i < p.length; i++) p[i] = Math.floor(this.rand() * 256);
    return p;
  }

  /**
   * Station side, tier by tier: the data layer (trust_anchor.py: MAC, then nonce, then the
   * chain), the physical layer (security_detector.py on the range, Doppler, power and phase),
   * the statistical layer (detector.py's forest on the RF), then the twin's decision.
   */
  private async verify(
    frame: Frame,
    mac: string,
    source: string,
    label: FrameLabel,
    s: number,
    rf: RfMeasurement | null,
    link: LinkClaim | null,
    underAttack: boolean,
    tamper: { originalPayload: string; flipped: { byte: number; bit: number } } | null,
  ) {
    const started = performance.now();
    const key = await this.hsm.epochKey(this.keyEpoch);
    const auth = await this.anchor.authenticate(frame, mac, key);
    const block = await this.anchor.append(frame, mac, auth.frameDigest, auth.reason);
    const authMs = performance.now() - started;

    const t0 = performance.now();
    const physics = link
      ? this.physicsEngine.evaluate(link.rx, link.truth, link.elevationDeg, link.tReal)
      : null;
    const detection = rf ? this.linkDetector.evaluate(rf) : null;
    if (rf) this.linkDetector.observe(rf, !auth.ok || frame.hw_token !== SAT_TOKEN);
    const detectorMs = performance.now() - t0;
    // Key-holder evidence, the only reason to re-key: a valid tag on a foreign hardware token,
    // or on content never received before under a stale nonce. A replay repeats a digest.
    const tagValid = auth.reason !== 'MAC_MISMATCH';
    const keyHolder =
      tagValid &&
      (frame.hw_token !== SAT_TOKEN || (!auth.ok && !this.seenDigests.has(auth.frameDigest)));
    if (tagValid) this.seenDigests.add(auth.frameDigest);
    if (keyHolder) {
      if (this.run) this.run.keyHolder = true;
      this.log('!! valid tag from a key holder · re-key on response', 'bad');
    }
    // The burst rule: authentication failures over the last BURST_WINDOW decoded frames.
    this.authWindow.push(!auth.ok);
    if (this.authWindow.length > BURST_WINDOW) this.authWindow.shift();
    const burst = !auth.ok && this.authWindow.filter(Boolean).length >= BURST_FAILURES;
    const decision = decide(frame, auth, physics, detection, burst);
    if (decision.verdict === 'ACCEPTED' && rf) this.linkDetector.accept(rf);
    if (decision.verdict === 'DEGRADED') this.degradedToAnalyst++;

    const verdict: Verdict = auth.ok
      ? 'VERIFIED'
      : auth.reason === 'MAC_MISMATCH'
        ? 'MAC FAIL'
        : 'REPLAY';
    this.framesReceived++;
    this.overheadMs.push(authMs);
    if (this.overheadMs.length > 240) this.overheadMs.shift();
    if (verdict === 'VERIFIED') {
      this.framesVerified++;
      if (decision.allow && label !== 'genuine' && label !== 'jam') this.corruptedToAnalyst++;
      this.arrivals.push({ t: s, outcome: 'ok' });
      if (!decision.allow) this.heldByZeroTrust++;
    } else {
      this.framesRejected++;
      if (verdict === 'MAC FAIL') this.rejectedMac++;
      else this.rejectedNonce++;
      this.arrivals.push({ t: s, outcome: 'fail' });
      const run = this.run;
      if (run && run.rejectMs === null && s >= run.start) run.rejectMs = (s - run.start) * 1000;
    }
    this.pushRow({
      seq: frame.sequence,
      hash: block.hash,
      source,
      verdict,
      label,
      t: s,
      overheadMs: authMs,
    });

    this.blockHeight = block.index;
    const short = `${block.hash.slice(0, 10)}…${block.hash.slice(-4)}`;
    if (burst && !this.burstActive) {
      this.log(
        `!! burst: ${BURST_FAILURES} authentication failures in the last ${BURST_WINDOW} frames · link quarantined`,
        'bad',
      );
    }
    this.burstActive = burst || (this.burstActive && this.authWindow.some(Boolean));
    if (decision.verdict === 'DEGRADED') {
      this.log(
        `⚠ block #${block.index} ${short} hmac ok · degraded link, delivered flagged`,
        'warn',
      );
    } else if (verdict === 'VERIFIED') {
      this.log(`✓ block #${block.index} ${short} hmac ok`, 'ok');
    } else if (label === 'spoof') {
      this.log(
        `✗ block #${block.index} forged nonce 0x${frame.sequence.toString(16)} · node ${copy.ROGUE_NODE}`,
        'bad',
      );
    } else if (label === 'tamper') {
      this.log(`✗ block #${block.index} HASH MISMATCH · payload altered in transit`, 'bad');
    } else if (verdict === 'REPLAY') {
      this.log(`✗ block #${block.index} stale nonce 0x${frame.sequence.toString(16)}`, 'bad');
    } else {
      this.log(`✗ PROOF FAIL #${block.index} · hmac mismatch · ROGUE-TX`, 'bad');
    }

    this.record({
      t: s,
      label,
      underAttack,
      source,
      frame,
      frameText: `${frame.satellite_id}|${frame.sequence}|${frame.timestamp.toFixed(6)}|${frame.hw_token}|${frame.payload}`,
      mac,
      expectedMac: auth.expectedMac,
      frameDigest: auth.frameDigest,
      keyEpoch: this.keyEpoch,
      originalPayload: tamper?.originalPayload ?? null,
      flipped: tamper?.flipped ?? null,
      auth: { ok: auth.ok, reason: auth.reason },
      block: { index: block.index, previous_hash: block.previous_hash, hash: block.hash },
      rf,
      link,
      physics,
      detector: detection,
      decision,
      authMs,
      detectorMs,
    });
  }

  private record(r: Omit<PacketRecord, 'id'>) {
    this.packets.unshift({ ...r, id: ++this.packetId });
    if (this.packets.length > PACKET_RECORDS) this.packets.pop();

    const key: StatKey = r.label === 'genuine' && r.underAttack ? 'genuineUnderAttack' : r.label;
    const st = (this.layerStats[key] ??= {
      frames: 0,
      decoded: 0,
      anchor: 0,
      physics: 0,
      forest: 0,
      detector: 0,
      blocked: 0,
      flagged: 0,
      degraded: 0,
      held: 0,
      firstBlockMs: [],
    });
    st.frames++;
    if (r.frame) st.decoded++;
    if (r.frame && !r.auth.ok) st.anchor++;
    // No frame at all is the strongest physical evidence: the carrier is gone.
    if (r.physics?.breach || !r.frame) st.physics++;
    if (r.detector?.forest) st.forest++;
    if (r.physics?.breach || !r.frame || r.detector?.forest) st.detector++;
    if (!r.decision.allow) st.blocked++;
    if (!r.decision.allow || r.decision.verdict === 'DEGRADED') st.flagged++;
    if (r.decision.verdict === 'DEGRADED') st.degraded++;
    if (r.decision.verdict === 'HELD') st.held++;

    const run = this.run;
    const alarm = !r.decision.allow || r.decision.verdict === 'DEGRADED';
    if (run && r.label === run.kind && alarm && run.firstBlockMs === null)
      run.firstBlockMs = Math.max(0, (r.t - run.start) * 1000);
  }

  // ---------------------------------------------------------------- ledger checks

  /** verify_chain() on the browser ledger: incremental by default, from genesis when `full`. */
  checkChain(full: boolean): Promise<ChainStatus> {
    const run = async () => {
      const from = full ? 1 : this.verifiedUpTo + 1;
      const end = this.anchor.chain.length - 1;
      const result = await this.anchor.verifyChain(from);
      if (result.ok) this.verifiedUpTo = Math.max(this.verifiedUpTo, end);
      const status: ChainStatus = { ...result, full, blocks: end, at: this.s };
      this.chainStatus = status;
      this.emit();
      return status;
    };
    const next = this.chainChecks.then(run, run);
    this.chainChecks = next;
    return next;
  }

  /** Red-team demo: edits a past block's recorded verdict, then lets verify_chain() find it. */
  async tamperLedger(): Promise<void> {
    const chain = this.anchor.chain;
    if (this.ledgerTamper || chain.length < 4) return;
    const index = Math.max(1, Math.floor(chain.length / 2));
    const block = chain[index];
    if (typeof block.payload === 'string') return;
    this.ledgerTamperOriginal = block.payload;
    const verdict = block.payload.verdict === 'AUTHENTIC' ? 'MAC_MISMATCH' : 'AUTHENTIC';
    block.payload = { ...block.payload, verdict };
    this.ledgerTamper = { index, until: this.s + 6 };
    this.log(`!! red team edited ledger block #${index}: verdict → ${verdict}`, 'warn');
    const status = await this.checkChain(true);
    if (!status.ok) this.log(`✗ verify_chain(): ${status.message}`, 'bad');
  }

  private restoreLedger() {
    const t = this.ledgerTamper;
    const original = this.ledgerTamperOriginal;
    this.ledgerTamper = null;
    this.ledgerTamperOriginal = null;
    if (!t || !original) return;
    this.anchor.chain[t.index].payload = original;
    this.log(`ledger block #${t.index} restored from the HSM-signed backup`, 'info');
    void this.checkChain(true).then((status) => {
      if (status.ok) this.log('✓ verify_chain(): intact again to genesis', 'ok');
    });
  }

  private pushRow(row: Omit<LedgerRow, 'id' | 'original'>) {
    this.ledger.unshift({ ...row, id: ++this.rowId, original: row.verdict });
    if (this.ledger.length > LEDGER_ROWS) this.ledger.pop();
  }

  // ---------------------------------------------------------------- detection

  private frameStats(s: number) {
    const recent = this.arrivals.filter((a) => a.t > s - 1.0);
    const n = Math.max(recent.length, 1);
    return {
      lossRate: recent.filter((a) => a.outcome === 'lost').length / n,
      failRate: recent.filter((a) => a.outcome === 'fail').length / n,
    };
  }

  private updateDetectors(s: number) {
    const { PHYSICS, TRUST, AI } = this.detectors;
    const link = this.pass.linkActive && this.current !== null;

    PHYSICS.flag = link && s - this.lastPhysicsViolation <= 0.15;

    const recentFails = this.arrivals.filter((a) => a.outcome === 'fail' && a.t > s - 1.2).length;
    const recentLost = this.arrivals.filter((a) => a.outcome === 'lost' && a.t > s - 1.0).length;
    TRUST.flag = recentFails > 0 || recentLost >= 2;

    if (link && this.current) {
      const stats = this.frameStats(s);
      this.features = featureVector(this.current, stats, this.ai.scales);
      this.aiScore = this.ai.score(this.features);
      this.aiDriver = this.ai.driver(this.features);
      this.recentVectors.push(this.features);
      if (this.recentVectors.length > 60) this.recentVectors.shift();
      let evaluated = 1;
      if (this.heavyBatch) {
        // Heavy batch: re-score the recent window as a backlog would be, for real.
        for (const v of this.recentVectors) this.ai.score(v);
        evaluated += this.recentVectors.length;
      }
      this.aiEvals.push({ t: s, n: evaluated });
    } else {
      this.aiScore = 0.08;
    }
    this.anomaly += (this.aiScore - this.anomaly) * 0.3;
    AI.flag = AI.flag ? this.anomaly >= 0.5 : this.anomaly >= FLAG_AT;

    // Spoof likelihood: fuses physical signatures, the trust result and the model score.
    let z = -3 + 2 * (this.anomaly - 0.5);
    const live = this.physics;
    if (this.current && live) {
      const n = live.chi.normalized;
      const limit = Math.sqrt(live.chi.threshold);
      if (Math.abs(n.dopplerHz) > limit) z += 2.2;
      if (n.rssiDb > limit) z += 1.8;
      // Too weak: jamming when frames go missing, a mimicked fade when they keep arriving.
      if (n.rssiDb < -limit) z += recentLost > 0 ? -2 : 1;
      if (Math.abs(n.rangeKm) > limit) z += 1.2;
      if (Math.abs(n.phaseDeg) > limit) z += 0.8;
    }
    if (recentFails > 0) z += 3;
    this.spoofLikelihood += (1 / (1 + Math.exp(-z)) - this.spoofLikelihood) * 0.2;

    this.votes = Number(PHYSICS.flag) + Number(TRUST.flag) + Number(AI.flag);

    const run = this.run;
    if (run && !run.ended && s >= run.start) {
      for (const id of ['PHYSICS', 'TRUST', 'AI'] as DetectorId[]) {
        const d = this.detectors[id];
        if (d.flag && d.latencyMs === null) {
          d.latencyMs = (s - run.start) * 1000;
          run.latency[id] = d.latencyMs;
        }
      }
      PHYSICS.evaded =
        (run.kind === 'spoof' || run.kind === 'tamper') && !PHYSICS.flag && (TRUST.flag || AI.flag);
      if (this.votes >= 2 && run.escalatedAt === null) this.escalate(run, s);
    }

    // False-alarm suppression moment: the model flags alone and fusion holds.
    if (this.falseAlarm && s < this.falseAlarm.to + 1.5) {
      if (this.faCallout === 'none' && this.votes === 1 && AI.flag) {
        this.say(copy.TOUR_CALLOUTS.hold, 'fusion', 'warn', 1.6);
        this.faCallout = 'held';
      } else if (this.faCallout === 'held' && this.votes === 0) {
        this.say(copy.TOUR_CALLOUTS.suppressed, 'fusion', 'ok', 2.4);
        this.faCallout = 'cleared';
      }
    }
  }

  private escalate(run: Run, s: number) {
    run.escalatedAt = s;
    run.escalateMs = (s - run.start) * 1000;
    const attack = this.attack;
    if (!attack) return;

    const shown = copy.activeBanner(run.kind, run.escalateMs);
    this.banner = {
      kind: run.kind,
      tone: run.kind === 'jam' ? 'warn' : 'bad',
      ...shown,
      shownAt: s,
      hideAt: null,
    };

    if (run.auto) {
      attack.tResponse = Math.max(run.tTrigger + RESPONSE_DELAY_S[run.kind], s + 1);
    } else {
      attack.tResponse = run.tTrigger + UNANSWERED_END_S;
    }
    if (run.kind === 'hijack') this.compromised = { from: s + 0.2, to: attack.tResponse };

    this.statusLine =
      run.kind === 'jam'
        ? `Jamming detected · forcing fallback routing to ${copy.HANDOVER_STATION}`
        : `Running: ${copy.ATTACK_BUTTONS[run.kind].running} · frames held at the gate`;

    const say = (text: string, sub: string | undefined, target: CalloutTarget, tone: Tone) =>
      this.say({ text, sub }, target, tone, 3.2);
    switch (run.kind) {
      case 'hijack':
        say('Carrier jumped to 8492 MHz', '+14.2 MHz: no orbit produces that', 'telemetry', 'bad');
        say('Proof failures on every rogue frame', undefined, 'ledger', 'bad');
        say('Rogue carrier aimed at Zaghouan', undefined, 'station', 'bad');
        this.log('!! ALERT frequency hijack · carrier +14.2 MHz', 'bad');
        break;
      case 'spoof':
        say(
          'Power inside a ±4 dB band, 14σ below the link budget',
          'the χ² engine rejects the fade',
          'telemetry',
          'bad',
        );
        say(`Forged MAC headers from node ${copy.ROGUE_NODE}`, undefined, 'ledger', 'bad');
        say(
          'Quarantine protocols engaged',
          'physical, data and statistical layers all fire',
          'fusion',
          'bad',
        );
        this.log(`!! QUARANTINE PROTOCOLS ENGAGED · node ${copy.ROGUE_NODE} isolated`, 'bad');
        break;
      case 'tamper':
        say('RF looks clean', 'χ² inside the gate: physics sees nothing', 'telemetry', 'warn');
        say('HMAC mismatch: payload altered in transit', undefined, 'ledger', 'bad');
        say(
          'Caught by the data layer',
          'the hash no longer matches what the satellite sealed',
          'fusion',
          'bad',
        );
        this.log('!! ALERT data tampering · hash verification failing', 'bad');
        break;
      case 'jam':
        say(
          'Carrier power collapsing to −96.5 dBm',
          'driven live by the power slider',
          'telemetry',
          'warn',
        );
        say('Broadband noise floods Zaghouan', undefined, 'station', 'warn');
        this.log('!! ALERT noise jamming · carrier power collapse', 'warn');
        break;
    }
    this.emit();
  }

  private respond(run: Run, s: number) {
    run.respondedAt = s;
    let handoverS: number | null = null;
    switch (run.kind) {
      case 'hijack':
      case 'spoof':
        this.quarantineUntil = s + 1.7;
        if (run.keyHolder) {
          // Someone holds the key: rotate it.
          this.keyEpoch += 1;
          this.keyFlashAt = s;
          this.statusLine = `Re-keying · key epoch 0x${this.keyEpoch.toString(16).toUpperCase()}`;
          this.log(
            `quarantine: ${this.framesRejected} frames isolated · epoch 0x${this.keyEpoch.toString(16).toUpperCase()}`,
            'warn',
          );
          this.handshake('re-key');
        } else {
          // No frame carried a valid tag: the attacker never had the key. Isolate and re-lock.
          this.statusLine =
            run.kind === 'hijack'
              ? `Carrier re-locked on ${copy.SATELLITE} · link quarantined`
              : `Node ${copy.ROGUE_NODE} isolated · link quarantined`;
          this.log(
            `quarantine: ${this.framesRejected} frames isolated · key epoch unchanged: no valid tag from the attacker`,
            'warn',
          );
        }
        break;
      case 'tamper':
        // The relay never had the key: no re-key needed, just drop and re-request.
        this.quarantineUntil = s + 1.2;
        this.statusLine = 'Tampered frames quarantined · retransmission requested';
        this.log(
          `quarantine: tampered frames dropped · retransmission requested · key epoch unchanged`,
          'warn',
        );
        break;
      case 'jam':
        this.route = 'MAT';
        this.handoverAt = s;
        handoverS = run.escalatedAt === null ? null : s - run.escalatedAt;
        this.statusLine = `Link restored via ${copy.HANDOVER_STATION}`;
        this.log(`fallback routing → ${copy.HANDOVER_STATION} · downlink restored`, 'ok');
        this.say(
          {
            text: `Fallback routing to ${copy.HANDOVER_STATION}`,
            sub: 'no corrupted frames accepted',
          },
          'sat',
          'ok',
          3,
        );
        break;
    }
    for (const row of this.ledger) {
      if (row.id >= run.firstRowId && (row.verdict === 'MAC FAIL' || row.verdict === 'REPLAY')) {
        row.verdict = 'QUARANTINED';
      }
    }
    if (run.kind === 'hijack' || run.kind === 'spoof' || run.kind === 'tamper') {
      this.say(
        { text: 'Frames held at the provenance gate', sub: 'the pipeline never fails silently' },
        'ledger',
        'ok',
        3,
      );
    }
    const resolved = copy.resolvedBanner(run.kind, this.keyEpoch, handoverS, run.keyHolder);
    this.banner = { kind: run.kind, tone: 'ok', ...resolved, shownAt: s, hideAt: s + 1.4 };
    this.recoveringUntil = s + 1.1;
    this.emit();
  }

  private updateLifecycle(s: number) {
    const attack = this.attack;
    const run = this.run;
    if (!attack || !run) return;

    if (!run.ended && s >= attack.tResponse) {
      run.ended = true;
      if (run.firstBlockMs !== null) {
        const st = this.layerStats[run.kind];
        if (st) st.firstBlockMs.push(run.firstBlockMs);
      }
      if (run.escalatedAt !== null && run.auto) {
        this.respond(run, s);
      } else if (run.escalatedAt !== null) {
        this.banner = {
          kind: run.kind,
          tone: 'warn',
          ...copy.unansweredBanner,
          shownAt: s,
          hideAt: s + 2.5,
        };
        this.statusLine = 'Ready · standard scenario';
        this.recoveringUntil = s + 1.1;
      } else {
        this.statusLine =
          run.kind === 'jam'
            ? 'Jamming stayed below the detection gate · carrier power held in the band'
            : 'Attack ended without escalation';
      }
      this.compromised = null;
      this.runs.push(run);
      this.emit();
    }

    if (run.ended && s >= attack.tResponse + 0.6) {
      this.attack = null;
      this.run = null;
      if (!this.statusLine.startsWith('Jamming stayed'))
        this.statusLine = 'Ready · standard scenario';
      this.emit();
    }
  }

  private updateState(s: number) {
    const run = this.run;
    let next: SystemState;
    if (run && run.escalatedAt !== null && !run.ended)
      next = run.kind === 'jam' ? 'JAMMING' : 'UNDER ATTACK';
    else if (this.uplinkRun && this.uplinkRun.blocked > 0) next = 'UNDER ATTACK';
    else if (s < this.recoveringUntil) next = 'RECOVERING';
    else if (this.votes >= 2) next = 'UNDER ATTACK';
    else if (this.votes === 1) next = 'CHECKING';
    else next = 'NOMINAL';
    if (next !== this.state) {
      this.state = next;
      this.emit();
    }
  }

  // ---------------------------------------------------------------- uplink

  /** The uplink key of the current epoch: derived apart from the downlink's in the same HSM. */
  private uplinkKey(): Promise<CryptoKey> {
    return this.hsm.epochKey(0x10000 + this.keyEpoch);
  }

  /** Red team on the uplink: tamper with, inject or replay telecommands for a few seconds. */
  triggerUplink(threat: UplinkThreat): boolean {
    if (this.attack || this.uplinkRun || this.demo.active) return false;
    const s = this.s;
    this.uplinkRun = { threat, tTrigger: s, until: s + UPLINK_RUN_S, blocked: 0, executed: 0 };
    this.nextHostileAt = s + 0.15;
    this.nextCommandAt = Math.min(this.nextCommandAt, s + 0.2);
    this.statusLine = `Running: ${copy.UPLINK_BUTTONS[threat].running}`;
    const shown = copy.activeUplinkBanner(threat);
    this.banner = { kind: threat, tone: 'bad', ...shown, shownAt: s, hideAt: null };
    this.emit();
    return true;
  }

  private updateUplink(s: number) {
    const run = this.uplinkRun;
    if (this.pass.linkActive) {
      if (s >= this.nextCommandAt) {
        this.nextCommandAt = s + UPLINK_PERIOD_S;
        this.sendCommand(s, run && s < run.until && run.threat === 'cmdtamper' ? run : null);
      }
      if (run && s < run.until && run.threat !== 'cmdtamper' && s >= this.nextHostileAt) {
        this.nextHostileAt = s + HOSTILE_PERIOD_S;
        if (run.threat === 'cmdinject') this.injectCommand(s);
        else this.replayCommand(s);
      }
    }
    if (run && s >= run.until) {
      this.uplinkRun = null;
      this.uplinkRuns.push(run);
      const resolved = copy.resolvedUplinkBanner(run.threat, run.blocked, run.executed);
      this.banner = { kind: run.threat, tone: 'ok', ...resolved, shownAt: s, hideAt: s + 2.2 };
      this.statusLine = 'Ready · standard scenario';
      this.recoveringUntil = s + 1.1;
      this.emit();
    }
  }

  /** What the on-board receiver sees on the S-band uplink right now. */
  private uplinkRf() {
    const pass = this.pass;
    return {
      dopplerHz: (-UPLINK.carrierHz * pass.rangeRateKmS) / C_KM_S,
      rxDbm: uplinkRxDbm(pass.rangeKm, pass.elevationDeg),
    };
  }

  /** Mission control's next routine command; a tamperer may rewrite it in flight. */
  private sendCommand(s: number, tamper: UplinkRun | null) {
    const routine = ROUTINE[this.tcSeq % ROUTINE.length];
    const c: Telecommand = { satelliteId: SAT_ID, seq: ++this.tcSeq, t: s, ...routine };
    const rf = this.uplinkRf();
    this.uplinkStats.sent++;
    this.queue = this.queue.then(async () => {
      const key = await this.uplinkKey();
      const tag = await sealCommand(key, c);
      this.recorded.push({ c, tag });
      if (this.recorded.length > 12) this.recorded.shift();
      // Rewritten in flight: the transmitter goes off, the original tag rides along.
      const received = tamper ? { ...c, ...ROGUE_COMMAND } : c;
      await this.receiveCommand(received, tag, copy.STATION, tamper?.threat ?? null, s, rf, key);
    });
  }

  /** A command forged at the rogue uplink station, its tag under a guessed key. */
  private injectCommand(s: number) {
    const c: Telecommand = {
      satelliteId: SAT_ID,
      seq: this.tcSeq + 1 + Math.floor(this.rand() * 8),
      t: s,
      ...ROGUE_COMMAND,
    };
    const rf = this.uplinkRf();
    this.queue = this.queue.then(async () => {
      const tag = await sealCommand(this.attackerKey, c);
      await this.receiveCommand(c, tag, ROGUE_UPLINK, 'cmdinject', s, rf, await this.uplinkKey());
    });
  }

  /** A genuine command recorded off the air, sent again: the tag is right, the count is old. */
  private replayCommand(s: number) {
    const old = this.recorded[Math.floor(this.rand() * Math.max(1, this.recorded.length - 2))];
    if (!old) return;
    const rf = this.uplinkRf();
    this.queue = this.queue.then(async () => {
      await this.receiveCommand(
        old.c,
        old.tag,
        `${ROGUE_UPLINK} · replay`,
        'cmdreplay',
        s,
        rf,
        await this.uplinkKey(),
      );
    });
  }

  private async receiveCommand(
    c: Telecommand,
    tag: string,
    source: string,
    threat: UplinkThreat | null,
    s: number,
    rf: { dopplerHz: number; rxDbm: number },
    key: CryptoKey,
  ) {
    const check = await this.onboard.verify(key, c, tag);
    if (check.verdict === 'EXECUTED') this.uplinkStats.executed++;
    else this.uplinkStats.rejected++;
    const run = this.uplinkRun;
    if (threat && run && run.threat === threat) {
      if (check.verdict === 'EXECUTED') {
        run.executed++;
        this.uplinkStats.hostileExecuted++;
      } else run.blocked++;
    }
    this.uplink.unshift({
      id: ++this.uplinkId,
      t: s,
      seq: c.seq,
      opcode: c.opcode,
      args: c.args,
      source,
      threat,
      tag,
      ...check,
      ...rf,
    });
    if (this.uplink.length > 60) this.uplink.pop();
  }

  // ---------------------------------------------------------------- read models

  /** Attack strength 0..1 at the current instant (for visuals). */
  get attackEnvelope(): number {
    return this.attack ? envelope(this.attack, this.s) : 0;
  }

  get quarantined(): boolean {
    return this.s < this.quarantineUntil;
  }

  get compromisedNow(): boolean {
    return (
      this.compromised !== null && this.s >= this.compromised.from && this.s < this.compromised.to
    );
  }

  get linkIntegrity(): number {
    const received = this.arrivals.filter((a) => a.outcome !== 'lost' && a.t > this.s - 3);
    if (received.length === 0) return 1;
    return received.filter((a) => a.outcome === 'ok').length / received.length;
  }

  get verifiedPerSecond(): number {
    return this.arrivals.filter((a) => a.outcome === 'ok' && a.t > this.s - 3).length / 3;
  }

  /** Feature vectors scored by the Isolation Forest over the last second. */
  get vectorsPerSecond(): number {
    return this.aiEvals.reduce((n, e) => n + e.n, 0);
  }

  get medianOverheadMs(): number | null {
    if (this.overheadMs.length === 0) return null;
    const sorted = [...this.overheadMs].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  get medianEscalateMs(): number | null {
    const values = this.runs.map((r) => r.escalateMs).filter((v): v is number => v !== null);
    if (this.run?.escalateMs != null) values.push(this.run.escalateMs);
    if (values.length === 0) return null;
    values.sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  }

  get lastRun(): Run | null {
    return this.run ?? this.runs[this.runs.length - 1] ?? null;
  }

  get demoProgress(): number {
    return this.demo.active ? clamp((this.s - this.demo.t0) / DEMO_LENGTH_S) : 0;
  }

  /** Smoothly interpolated pass state for rendering, optionally `lagS` seconds in the past. */
  visualPass(lagS = 0): PassState {
    return passAt(this.s + this.acc - lagS + this.passOffset);
  }

  get passPhase(): number {
    return ((((this.s + this.passOffset) % PERIOD_S) + PERIOD_S) % PERIOD_S) / PERIOD_S;
  }
}
