# Evaluation & Performance Report

**Track 1:** Secure Ground-Link Testbed
**Phase 1 Submission – Anonymous Evaluation**

---

## 1. Executive Summary

This report gives the measured detection, false-alarm rate, processing time and memory of the
three-tier pipeline under the decision rule of `digital_twin/decision.py`, which the live site
runs too: the data tier (decoder, HMAC-SHA256, SHA-256 digest, hardware token, anti-replay
window), the statistical tier (the site's per-frame Isolation Forest, re-implemented in Python
with the same six features and settings) and the physical tier (chi-square against SGP4 and the
ITU-R P.618 link budget, plus the kinematic range–Doppler test). Five outcomes: delivered,
degraded (genuine frame, only its power anomalous, delivered flagged with a jamming alarm), held,
rejected, quarantined (two tiers, at least one deterministic, or 3 authentication failures within
10 frames). The key is changed only on evidence that someone holds it. Telemetry comes from
TerraSAR-X (≈514 km, sun-synchronous), downlinking at X-band (8477.8 MHz) to the Zaghouan ground
station in Tunisia, with ten attacks injected in bursts.

Every one of the 90,000 attack packets was flagged, from the first packet of every burst, and
none reached the analyst unflagged (≤ 4.3 × 10⁻⁵ at 95 %). Of the 54,660 held-out genuine packets,
98.4 % were delivered clean; 1.59 % were not delivered, almost all of them held for review by the
statistical tier alone. The same evaluation through a sample-level receiver (QPSK samples
through a modem, section 4) gives the same 90,000 flagged and 1.30 % of genuine packets not
delivered.

**Scope.** The official reference datasets had not been published by the organisers when we last
checked, on 3 November 2026. The evaluation reads every packet through one adapter
(`digital_twin/datasets.py`): `--dataset official --path` scores the official set with no code
change. Real data today: the CelesTrak orbits and the ITU-R P.618-13 atmosphere. Synthetic: the
frame payloads and the RF measurements. These figures describe the testbed, not a real link.

---

## 2. Quantitative Performance & Metrics

Six seeded runs of `python -m digital_twin.evaluate` (seeds 1–6), one packet a second while the
link is up. Each run trains the statistical tier on 3,000 nominal packets, then scores 15,600
held-out nominal packets interleaved with 500 attack bursts (10 attacks × 50 bursts × 30
packets) and 150 bursts of three below-the-gate jams, then 150 telecommands under the uplink
threats. Rates are pooled over the six runs, with 95 % Wilson intervals.

**Which genuine packets count.** The false-alarm set is the held-out nominal packets whose last
10 frame slots hold no attack frame: 54,660 (9,110 a run). The other 38,940, the 10 slots after
each attack frame, are reported apart as the hold-over: the statistical tier's failure-rate
features still remember the attack there, and 48.6 % of them are held for review (none
rejected). The 3,000 training packets a run are never scored.

| Evaluation Metric | Target | Measured (6 seeds) | Status |
| :--- | :--- | :--- | :--- |
| **Attack packets flagged** (not delivered clean) | $100\%$ | 90,000 of 90,000; unflagged $\le 4.3 \times 10^{-5}$ at 95 % | ✅ Met |
| **Time to first flag** | first packet | packet 1 of every burst, all ten attacks | ✅ Met |
| **Genuine packets not delivered** | $< 2.0\%$ | 867 of 54,660 = 1.59 % [1.48, 1.69]: 859 held, 4 rejected, 4 quarantined | ✅ Met |
| **Genuine packets delivered degraded** | report | 1 of 54,660 ($1.8 \times 10^{-5}$) | — |
| **Chi-square fired on genuine packets** | $10^{-4}$ by design | 4 of 54,660 = $7.3 \times 10^{-5}$ [$2.8 \times 10^{-5}$, $1.9 \times 10^{-4}$] | ✅ Consistent |
| **Re-keys** | only with a key holder | 0 in every class (no attack holds the key) | ✅ Met |
| **Decision time per packet** (three tiers + rule) | $< 100\text{ ms}$ | $0.29$–$0.30\text{ ms}$ mean, $\le 0.48\text{ ms}$ p95 | ✅ Met |
| **Ledger overhead** (authenticate + SHA-256 chain one block) | $< 10\text{ ms}$ | $0.016\text{ ms}$ mean, $\le 0.032\text{ ms}$ p95 | ✅ Met |
| **Ledger tamper test** (one verdict edited mid-chain) | detected | detected in every run | ✅ Met |
| **Uplink commands executed under attack** | 0 | 0 of 900 ($\le 4.3 \times 10^{-3}$ at 95 %) | ✅ Met |
| **Memory, Python process** | report | 158 MB peak RSS (`getrusage`, numpy, scikit-learn, sgp4 included) | — |
| **Memory, browser** | report | 20.7 MB JS heap after 60 s of the live dashboard (Chromium, after GC) | — |

The 9 physical flags on genuine packets (4 chi-square, 6 kinematic, one both) became 1 degraded
delivery, 4 rejections and 4 quarantines. The forest is scored by walking its 256 trees together
(`FastForestScorer`, identical to scikit-learn's score to $10^{-15}$), which took the decision time
from 15 ms to 0.3 ms. Times were measured on one core of an Intel Xeon @ 2.10 GHz (Python 3.11,
scikit-learn 1.9.1). The ledger figures come from `testbed/trust_anchor.py`.

---

## 3. Adversarial Test Results

Share of packets flagged by each tier, and the outcome (pooled over the six seeds):

| Traffic | Data | Statistical | Physical | Delivered | Degraded | Held | Rejected | Quarantined |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Genuine | 0% | 1.58% | 0.02% | 98.41% | 0.00% | 1.57% | 0.01% | 0.01% |
| Genuine, hold-over | 0% | 48.63% | 0.01% | 51.36% | 0.01% | 48.62% | 0% | 0% |
| Frequency hijacking | 100% | 100% | 100% | 0% | 0% | 0% | 0% | 100% |
| Stealth spoofing | 100% | 100% | 100% | 0% | 0% | 0% | 0% | 100% |
| Noise jamming | 16.6% | 100% | 100% | 0% | 82.6% | 0% | 0% | 17.4% |
| Data tampering | 100% | 96.7% | 0.03% | 0% | 0% | 0% | 3.3% | 96.7% |
| Relay (meaconing) | 0% | 100% | 100% | 0% | 0% | 0% | 0% | 100% |
| Phase slip (held out) | 0% | 3.5% | 100% | 0% | 0% | 0% | 96.5% | 3.5% |
| Injection | 100% | 96.7% | 0.02% | 0% | 0% | 0% | 3.3% | 96.7% |
| Replay | 100% | 100% | 100% | 0% | 0% | 0% | 0% | 100% |
| Delay | 0% | 4.7% | 100% | 0% | 0% | 0% | 95.3% | 4.7% |
| Co-channel capture (held out) | 100% | 100% | 100% | 0% | 0% | 0% | 0% | 100% |

Where each attack comes from, and what is called: the four of the live dashboard
(`dashboard/src/sim/signals.ts` and `engine.ts`, with their constants); relay, phase slip and
injection call `AerospaceAttackInjector.inject_threat` of `digital_twin/attack_injector.py` with
`DELAY_SPOOFING_MEACONING`, `COHERENT_PHASE_SLIP` and `CCSDS_SEQUENCE_HIJACK`; replay and delay are
`groundlink/attacks.py`'s; the co-channel capture is a louder transmitter 4 kHz off the Doppler
track on the channel itself, the genuine carrier 6 dB under it. Phase slip and co-channel capture
were added after the gates and the rule were fixed and are reported as held-out attacks; every
gate is set from clean traffic.

1. **Frequency hijacking (+14.2 MHz).** A sanity check: only a station whose wideband monitor
   re-tunes to the rogue carrier is exposed. No orbit produces that Doppler and the frames are
   sealed under the attacker's key. Quarantined; no re-key, since no frame carried a valid tag.
   The co-channel capture is the realistic case.
2. **Stealth spoofing (node 0x99A2).** On the Doppler track and only 3.2 dB low: inside the old
   ±4 dB box gate, but 14σ off the link budget. Forged tags and reused counts. Quarantined.
3. **Noise jamming (J/N +9.1 dB).** The SNR falls 9.6 dB: below the decoder's 4.4 dB threshold
   (CCSDS rate-1/2 code, `fec.py`) the frames are lost, 16.6 % of them, on the low-elevation part
   of each pass; the others decode bit-exact, verify, and reach the analyst flagged as degraded
   with a jamming alarm. On the dashboard, quarantine of GS-ZAG triggers fallback routing to
   GS-MAT, 2.8 s after the jam starts.
4. **Data tampering, injection.** No RF signature: only the HMAC check sees them. The first frame
   of a burst is rejected and resent; from the second, the forest's MAC-failure rate flags too and
   the link is quarantined. No re-key.
5. **Replay.** Genuine frames recorded 1 to 3 minutes earlier: the count is stale for the data
   tier on every frame, and the Doppler belongs to another moment of the pass. The tag is valid,
   but the content was already received, so it is not taken as a key holder: no re-key.
6. **Relay, delay, phase slip.** Genuine frames: cryptography sees nothing; the range residual,
   the range–Doppler test, the timing and the phase residual do.

**Re-keying.** A valid tag on a frame with a foreign hardware token, or on content never received
under a stale count, can only come from a key holder; that alone triggers a re-key. No attack of
the evaluation holds the key, and there were 0 re-keys; `tests/test_digital_twin.py` checks that
a leaked-key frame does trigger one and a replay does not.

**Below the gate.** The stealth budget depends on elevation, because the chi-square gate widens
near the horizon: a jammer stays hidden while it costs less than √(23.5 · w(el)) × 0.23 dB of SNR.

| Elevation | Gate widening w(el) | Widened gate | Power-only allowance | Largest hidden J/N |
| :--- | ---: | ---: | ---: | ---: |
| 2° (mask) | 2.43 | 57.2 | 1.74 dB | −3.1 dB |
| 9° | 1.45 | 34.0 | 1.34 dB | −4.4 dB |
| 30° | 1.01 | 23.8 | 1.12 dB | −5.3 dB |
| 90° | 1.00 | 23.5 | 1.12 dB | −5.3 dB |

| Jam | SNR lost | Frames verifying | Physical flags | Held | Reaching the analyst (clean + degraded) |
| :--- | ---: | ---: | ---: | ---: | ---: |
| J/N −12.8 dB (the dashboard's demo) | 0.22 dB | 100% | 0.1% | 2.4% | 97.6% |
| J/N −5.3 dB (the budget overhead) | 1.12 dB | 100% | 36.0% | 10.6% | 89.4% |
| J/N −3.1 dB (the budget at the mask) | 1.73 dB | 100% | 91.9% | 5.1% | 94.9% |

**Before and after degraded delivery** (J/N −5.3 dB). Before the rule, the frames the physical
tier flagged on their power were rejected: 50.3–56.8 % of the jammed frames reached the analyst,
34.7–37.1 % were rejected although their tags proved them genuine. After it, 53.5 % are delivered
clean, 36.0 % delivered flagged as degraded with a jamming alarm, 10.6 % held for review by the
statistical tier (its EVM feature sees the jam), and none rejected: 89.4 % reach the analyst.
Below about J/N −12 dB a jammer costs under 0.3 dB of SNR. Under the budget the jam is not
harmless: it is bounded, at most 1.1 dB overhead and 1.7 dB at the mask, and corrupts no frame.

**Ablation.** Share of attack packets that would reach the analyst unflagged with one tier
removed (pooled):

| Attack | Without the data tier | Without the statistical tier | Without the physical tier |
| :--- | ---: | ---: | ---: |
| Data tampering | 3.3% | 0% | 0% |
| Injection | 3.3% | 0% | 0% |
| Delay | 0% | 0% | 95.3% |
| Phase slip | 0% | 0% | 96.5% |
| The six others | 0% | 0% | 0% |

Without the physical tier delay and phase slip pass. Without the data tier only the first frame
of each tampering or injection burst passes: the forest's MAC-failure rate, which reads the data
tier's verdicts on the frames before, flags the rest, so this column measures the data tier's own
frame, not a tier that sees the tampering itself.

**Detection curves.** `docs/figures/roc_curves.png`: detection rate against false-alarm rate for
the forest and the chi-square score, attack packets against clean ones, averaged over the seeds.

| Traffic | AUC forest | AUC chi-square |
| :--- | ---: | ---: |
| Frequency hijacking, replay, co-channel capture | 1.000 | 1.000 |
| Stealth spoofing | 0.998 | 1.000 |
| Noise jamming | 0.997 | 1.000 |
| Relay | 0.942 | 1.000 |
| Phase slip | 0.714 | 1.000 |
| Delay | 0.523 | 1.000 |
| Data tampering | 0.483 | 0.502 |
| Injection | 0.531 | 0.498 |
| Jam, J/N −5.3 dB | 0.779 | 0.977 |
| Jam, J/N −3.1 dB | 0.980 | 1.000 |

Both are at chance on tampering and injection, which leave no RF trace: only the HMAC sees them.

**Tier correlation.** The statistical tier reads none of the residuals the chi-square tests: its
features are the EVM against the link budget's, the frame-loss rate over the last 10 slots, the
arrival jitter since the last decoded frame, the MAC/nonce failure rate over the last 10 decoded
frames, and the change of carrier and power since the last delivered frame. On the 54,660 genuine
packets it flagged 864, the physical tier 9 and both 5: φ = 0.056. Quarantine needs two tiers, at
least one of them deterministic.

**Uplink.** Under command tampering, injection and replay, 0 of 900 hostile telecommands were
executed: the spacecraft checks each tag in constant time, then the sequence count.

---

## 4. The sample-level receiver

`digital_twin/iq_receiver.py` builds every frame's waveform and measures it, as a modem does:
QPSK at 50 ksym/s, root-raised-cosine pulses (roll-off 0.35), a 64-symbol preamble (the CCSDS
sync marker four times) and 960 data symbols, through AWGN at the link budget's Es/N0, with the
carrier offset (true Doppler against the receiver's SGP4-driven oscillator), the arrival delay and
the carrier phase applied to the samples. The receiver runs a matched filter, the preamble
correlator with parabolic interpolation (timing), a data-aided frequency and phase fit, a
second-order phase-locked loop over the frame, the blind M2M4 SNR estimator and the EVM from the
constellation. The wide acquisition search (a 200 Hz FFT bin, the whole symbol of the sync
marker) is modelled at its output. The residuals of all three tiers come from these
measurements; the chi-square's spreads are measured on the training frames (range 0.48 km,
Doppler 6.05 Hz, power 0.31 dB, phase 1.59°).

`python -m digital_twin.evaluate --receiver iq`, the same six seeds:

| | Model receiver | Sample-level receiver |
| :--- | ---: | ---: |
| Attack packets flagged | 90,000 / 90,000 | 90,000 / 90,000 |
| Genuine packets not delivered | 1.59 % [1.48, 1.69] | 1.30 % [1.21, 1.40] |
| Chi-square fired on genuine packets | $7.3 \times 10^{-5}$ | $9.1 \times 10^{-5}$ |
| Tier correlation φ on genuine packets | 0.056 | 0.031 |
| Jam at J/N −5.3 dB reaching the analyst | 89.4 % | 82.4 % |
| Jam at J/N −3.1 dB reaching the analyst | 94.9 % | 74.7 % |
| Decision time per packet (receiver excluded) | 0.30 ms | 0.43–0.68 ms |

With a 0.31 dB power spread the stealth budget overhead becomes √23.5 × 0.31 = 1.49 dB. The
constellation of one frame per traffic class is in `docs/figures/constellations.png`: the
co-channel capture smears it into rings (the genuine carrier 6 dB under the captor), the jam
spreads it, the hijacker's louder carrier tightens it.

---

## 5. The adaptive attacker

`digital_twin/adaptive_attacker.py`: an attacker without the key that knows the orbit, the link
budget and the gates, and tunes its power, its carrier against the predicted Doppler and its
timing against the predicted light time. Each point is 100 forged frames, each on a clean link,
through the sample-level receiver (seed 1). It was written after every gate and rule was fixed.

- **Capturing the receiver while the satellite transmits** (`docs/figures/adaptive_capture.png`):
  below a 4 dB margin over the genuine carrier the frames do not decode at all (0–1 %); from
  4 dB they decode (94–100 %), and the physical and statistical tiers flag 100 % at every margin.
- **Alone on the channel** (`docs/figures/adaptive_alone.png`): the largest single offset that
  the physical and statistical tiers flag on at most 5 % of frames is +0.42 dB of power, 15.9 Hz
  of Doppler or 2.7 µs of timing. All three at once: 27 % flagged by the RF tiers.
- **The data tier rejects 100 % of the attacker's frames in every case**: none reached the
  analyst.

---

## 6. Conclusion & Reproducibility

Each tier catches what the others miss: tampering and injection need the cryptography, delay
and phase slip the physics, and the statistical tier, reading what the physics cannot, corroborates
without ever rejecting or quarantining alone. Below the stealth budget an attacker costs the link
at most 1.1 dB overhead, 1.7 dB at the mask, and corrupts nothing; above it, genuine frames still
reach the analyst, flagged.

Every table above, from one command (about 8 minutes on 4 cores):

```bash
make install        # requirements-lock.txt, the exact environment
make eval           # writes results/tables.md and checks it against results/EXPECTED_SHA256
make docker         # the same in a container
python -m digital_twin.evaluate --dataset official --path data/official.jsonl   # when released
```

`results/tables.md` holds every number of sections 2 to 5 in a canonical form; its SHA-256 is
`7533399f3487d60c0de7daee011a9fe27437bf10d58679975c72548f612b55ab`. Runs with 2 and 4 workers gave
the same file. `tests/test_digital_twin.py` runs the same evaluation on a smaller scale, exports
it through the dataset adapter and reads it back to the same decisions. The browser and the
Python testbed share golden vectors for the frame format, the HMAC-SHA256 tag, the SHA-256 frame
digest and the ledger's genesis root, and the chi-square constants (gate, widening, kinematic
gate); the groundlink core's AES-256-GCM seal is its own. The earlier box-gate pipeline remains in
`testbed/` (`python -m testbed.validator --seed 14`) for comparison.
