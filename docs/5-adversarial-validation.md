# 5 · Adversarial Validation & Response

> Phase 1 rubric: standard scenario & evasion, 20 points.

## Standard scenario

The official scenario has not been published (deliverable 6); this is how each element of the
challenge, as we read it, maps to our runs. `--dataset official --path` scores the official data
through the same tiers and rule when it is released.

| Scenario element | Our attacks | Metrics reported |
| --- | --- | --- |
| Spoofing of the downlink | Stealth spoofing, co-channel capture, frequency hijacking | Packets flagged, time to the first flag |
| Jamming and evasion below the gate | Noise jamming; jams at J/N −12.8, −5.3 and −3.1 dB | SNR lost, frames verifying, frames reaching the analyst |
| Adaptive evasion | An attacker tuning power, Doppler and timing under the gates | Share of frames each tier flags against the attacker's strength |
| Replay, relay, delay | Replay, meaconing relay, 80 ms delay | Packets flagged, by tier |
| Integrity in transit | Data tampering, CCSDS sequence hijack | Packets flagged; burst quarantine |
| Carrier and phase manipulation | Coherent phase slip | Packets flagged, by tier |
| Uplink command integrity | Command tampering, injection, replay | Commands executed |
| Cost of the defence | Every packet | False alarms, decision time, ledger overhead, memory |

**Which functions are called.** The evaluation (`digital_twin/evaluate.py`, `TwinSource._attack`)
applies the four live-demo attacks with the constants of `dashboard/src/sim/signals.ts`; relay,
phase slip and injection call `AerospaceAttackInjector.inject_threat` of `attack_injector.py` with
`DELAY_SPOOFING_MEACONING`, `COHERENT_PHASE_SLIP` and `CCSDS_SEQUENCE_HIJACK`; replay and delay
follow `groundlink/attacks.py`; the co-channel capture is a transmitter 6 dB louder, 4 kHz off the
Doppler track, the genuine carrier still underneath. Uplink threats call
`inject_uplink_threat`.

**Held out.** Phase slip and co-channel capture were added after every gate and the rule were
fixed, and are reported apart; the adaptive attacker was written after that too. Every gate is set
from clean traffic only.

## Results, by attack (6 seeds, pooled)

| Traffic | Data | Statistical | Physical | Delivered | Degraded | Held | Rejected | Quarantined |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Genuine | 0 % | 1.58 % | 0.02 % | 98.41 % | 0.00 % | 1.57 % | 0.01 % | 0.01 % |
| Frequency hijacking | 100 % | 100 % | 100 % | 0 % | 0 % | 0 % | 0 % | 100 % |
| Stealth spoofing | 100 % | 100 % | 100 % | 0 % | 0 % | 0 % | 0 % | 100 % |
| Noise jamming | 16.6 % | 100 % | 100 % | 0 % | 82.6 % | 0 % | 0 % | 17.4 % |
| Data tampering | 100 % | 96.7 % | 0.03 % | 0 % | 0 % | 0 % | 3.3 % | 96.7 % |
| Relay (meaconing) | 0 % | 100 % | 100 % | 0 % | 0 % | 0 % | 0 % | 100 % |
| Phase slip (held out) | 0 % | 3.5 % | 100 % | 0 % | 0 % | 0 % | 96.5 % | 3.5 % |
| Injection | 100 % | 96.7 % | 0.02 % | 0 % | 0 % | 0 % | 3.3 % | 96.7 % |
| Replay | 100 % | 100 % | 100 % | 0 % | 0 % | 0 % | 0 % | 100 % |
| Delay | 0 % | 4.7 % | 100 % | 0 % | 0 % | 0 % | 95.3 % | 4.7 % |
| Co-channel capture (held out) | 100 % | 100 % | 100 % | 0 % | 0 % | 0 % | 0 % | 100 % |

90,000 of 90,000 attack packets flagged, from the first packet of every burst; none reached the
analyst unflagged. Under the uplink threats 0 of 900 hostile telecommands executed.

**Ablation**, attack packets that would reach the analyst unflagged with one tier removed:

| Attack | Without data | Without statistical | Without physical |
| --- | ---: | ---: | ---: |
| Data tampering, injection | 3.3 % | 0 % | 0 % |
| Delay | 0 % | 0 % | 95.3 % |
| Phase slip | 0 % | 0 % | 96.5 % |
| The six others | 0 % | 0 % | 0 % |

Without the data tier only the first frame of each tampering burst passes: the forest's
MAC-failure rate reads the data tier's verdicts on the frames before.

## Evasion below the gate

| Jam | SNR lost | Frames verifying | Physical flags | Held | Reaching the analyst |
| --- | ---: | ---: | ---: | ---: | ---: |
| J/N −12.8 dB (the site's demo) | 0.22 dB | 100 % | 0.1 % | 2.4 % | 97.6 % |
| J/N −5.3 dB (the budget overhead) | 1.12 dB | 100 % | 36.0 % | 10.6 % | 89.4 % |
| J/N −3.1 dB (the budget at the mask) | 1.73 dB | 100 % | 91.9 % | 5.1 % | 94.9 % |

A jammer under the budget is **bounded, not harmless**: it costs at most 1.1 dB of SNR overhead,
1.7 dB at the mask, and corrupts no frame. What changed is what the station does with a genuine
frame whose only anomaly is its power:

| J/N −5.3 dB | Before degraded delivery | After |
| --- | ---: | ---: |
| Delivered clean | 50.3–56.8 % | 53.5 % |
| Delivered, flagged as degraded | 0 % | 36.0 % |
| Held for review | 0 % | 10.6 % |
| Rejected although genuine | 34.7–37.1 % | 0 % |
| Reaching the analyst | 50.3–56.8 % | 89.4 % |

## The adaptive attacker

`python -m digital_twin.adaptive_attacker`: no key, but it knows the orbit, the link budget and
the gates, and tunes its power, its carrier against the predicted Doppler and its timing against
the predicted light time. 100 forged frames a point, each on a clean link, through the
sample-level receiver (`docs/figures/adaptive_capture.png`, `adaptive_alone.png`).

- **Capturing the receiver while the satellite transmits**: below a 4 dB margin over the genuine
  carrier its frames do not decode (0–1 %); from 4 dB they do, and the physical and statistical
  tiers flag 100 % at every margin.
- **Alone on the channel**: the largest single offset the RF tiers flag on at most 5 % of frames is
  +0.42 dB of power, 15.9 Hz of Doppler or 2.7 µs of timing; all three at once, 27 % are flagged.
- **The data tier rejects 100 % of its frames in every case**: none reached the analyst.

## Response

| Trigger | Automatic response |
| --- | --- |
| One authentication failure (tag, token, count) | The frame is dropped and its retransmission requested |
| Physical flag alone | Rejected; retransmission requested |
| Power residual alone, frame authentic, kinematic test passes | Delivered flagged as degraded, with a jamming alarm |
| Statistical flag alone | Held for review |
| Two tiers at once (one deterministic), or 3 authentication failures within 10 frames | Link quarantined and re-acquired; under jamming, fallback routing to GS-MAT (2.8 s after the jam starts on the live testbed) |
| A valid tag on a foreign token, or on new content under a stale count | Re-key: a new epoch, announced under the uplink key and confirmed with Ed25519 |
| Every decision | A block in the SHA-256 hash-chained ledger |

No failure stays silent: every outcome but a clean delivery raises an alarm, and the ledger keeps
the record.

## Run it

```bash
python -m digital_twin.evaluate --workers 4
python -m digital_twin.adaptive_attacker --trials 100
make eval          # both, with the figures and the expected hash
```
