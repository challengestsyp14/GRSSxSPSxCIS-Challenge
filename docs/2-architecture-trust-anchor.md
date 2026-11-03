# 2 · Platform, Architecture & Trust Anchor

> Phase 1 rubric: architecture & trust mechanism, 15 points.

## Platform

Everything is emulated in software; nothing transmits or receives RF. The challenge accepts a
software or emulated trust anchor and local laptop execution.

| Part | What it is | Where |
| --- | --- | --- |
| Digital twin | The three tiers end to end on SGP4 passes, the decoder, the decision rule, ten attacks, a sample-level receiver, the seeded evaluation | `digital_twin/` (Python 3.11) |
| Trust anchor | HMAC-SHA256 sealing, the anti-replay window, the SHA-256 hash-chained ledger | `testbed/trust_anchor.py`, `digital_twin/crypto_hash_verifier.py` |
| Live testbed | The same tiers, decoder and rule ported to the browser, attacked live | `dashboard/` (React, TypeScript, Web Crypto) |
| First prototype | AES-256-GCM link and a hybrid detector; kept for comparison, not reported | `groundlink/` |

## Pipeline, frame by frame

```
SPACECRAFT                     RF PATH                       GROUND STATION (GS-ZAG)
──────────                     ───────                       ───────────────────────
CCSDS packet ─► HMAC-SHA256 ─► QPSK, rate-1/2 code ─► (attacker?) ─► decoder (fec.py)
  + SHA-256 digest   (epoch key)                                  │  frame lost below 4.4 dB
  + hardware token                                                ├─► data tier: tag · token · count
  + sequence count                                                ├─► statistical tier: forest
                                                                  ├─► physical tier: χ² · kinematic
                                                                  └─► decision rule (decision.py)
                                                                        │
                       delivered · degraded · held · rejected · quarantined
                                                                        │
                                                    SHA-256 ledger ◄────┴──► analyst
```

| Module | Role |
| --- | --- |
| `digital_twin/ephemeris_loader.py` | CelesTrak element set (live, cached, or built in) and its SHA-256 |
| `digital_twin/propagation.py`, `visibility_calculator.py` | SGP4 state, look angles and passes over Zaghouan |
| `digital_twin/link_budget.py` | Range, Doppler, free space and the ITU-R P.618 atmosphere, SNR, RSSI |
| `digital_twin/ccsds_framing.py` | CCSDS space packet with CRC-16 |
| `digital_twin/crypto_hash_verifier.py` | SHA-256 digest and HMAC-SHA256 tag, constant-time check |
| `digital_twin/fec.py` | The decoder: frame error rate of the CCSDS rate-1/2, K = 7 code |
| `digital_twin/iq_receiver.py` | The sample-level receiver (deliverable 3) |
| `digital_twin/isolation_forest_detector.py` | The statistical tier (deliverable 4) |
| `digital_twin/security_detector.py` | The physical tier: χ² gate and kinematic test |
| `digital_twin/decision.py` | The decision rule, the burst rule, the re-key rule |
| `digital_twin/audit_logger.py`, `testbed/trust_anchor.py` | Hash-chained logs |
| `dashboard/src/sim/*.ts` | Browser ports: `validator.ts`, `physicsEngine.ts`, `linkDetector.ts`, `trustAnchor.ts`, `fec.ts` |

## Trust anchor

**In flight: HMAC-SHA256 on every frame.** The satellite seals each CCSDS packet (header,
secondary header, payload with its hardware token) with HMAC-SHA256 under the key of the current
epoch, plus a SHA-256 digest. The station recomputes the tag in constant time; a single changed
bit fails it, and a guessed tag matches one time in 2²⁵⁶. Noise cannot flip a bit past the
decoder: below its threshold a frame is lost and the CRC says so, it is never delivered with
flipped bits.

**Freshness: the anti-replay window.** The 14-bit CCSDS sequence count is unwrapped and checked
against a 64-count window (`trust_anchor.py`'s `ReplayWindow`). A count is marked as seen only
once its frame authenticates, whatever the other tiers decide, so a replay of any genuine frame
is stale.

**Identity: the hardware token.** Each frame carries the satellite's emulated hardware token
(0x4FE2 for TerraSAR-X); a frame with another token is rejected even with a valid tag.

**At rest: the hash-chained ledger.** Every verdict is a block chained by SHA-256 to the one
before it, from a genesis root; `verify_chain()` names the first edited block. The live testbed
runs it continuously and offers an *Edit block* red-team test.

## Key management

| Key | Where it lives | How it rolls | If it leaks |
| --- | --- | --- | --- |
| Master secret, 256 bits | In flight: loaded into the satellite before launch and into the station's HSM. Here: the browser's emulated HSM at page load; in Python `GROUNDLINK_HMAC_KEY` or fresh per run, never in the source | Never | The data tier is defeated until a new master is loaded; the physical tier still sees a ground transmitter's geometry |
| Downlink key of epoch N | HMAC-SHA256(master, "key-epoch:N") on both sides; never transmitted | Only on evidence of a key holder (below) | That epoch only; the next re-key ends it |
| Uplink key of epoch N | Epoch 0x10000 + N, derived apart in the same HSM | With the downlink key | Commands of that epoch only |
| Spacecraft Ed25519 key | On board; the station holds the public key | Not rolled in the demo | Forged re-key announcements: the key to protect in hardware |

A re-key reaches the satellite as a telecommand carrying only the new epoch number, sealed under
the current uplink key; the spacecraft signs station, epoch and time with Ed25519 and the station
verifies it before switching epoch.

## The decision rule (`decision.py`, ported as `validator.ts`)

| Outcome | When | What happens |
| --- | --- | --- |
| Delivered | No tier flags the frame | To the analyst, chained in the ledger |
| Degraded | The data tier proves it genuine, the kinematic test passes, and the χ² fails only on the power residual | To the analyst, flagged, with a jamming alarm |
| Held | The statistical tier alone | Held for review |
| Rejected | The data tier or the physical tier alone | Dropped, retransmission requested |
| Quarantined | Two tiers at once, at least one deterministic; or an authentication failure when the last 10 decoded frames hold 3 | Link isolated and re-acquired; fallback to GS-MAT under jamming |

Only the deterministic tiers may reject, because their false-alarm rates are known by
construction (10⁻⁴ for the χ² gate, 2⁻²⁵⁶ for a guessed tag); the forest's is measured, not
designed, so on its own it only holds.

**Re-key rule.** The key is changed only when the data tier shows that someone holds it: a valid
tag on a frame with a foreign hardware token, or a valid tag on content never received under a
stale count. A forged tag, a rogue carrier, a replay (content already received), tampering or
jamming never re-keys: the link is quarantined and re-acquired with the epoch unchanged. In the
evaluation no attack holds the key and there were 0 re-keys; `tests/test_digital_twin.py` checks
that a leaked-key frame triggers one and a replay does not.

## One design, two codebases

The browser and the Python testbed share golden vectors for the frame format, the HMAC-SHA256
tag, the SHA-256 frame digest, the ledger's genesis root and the χ² constants (gate, widening,
kinematic gate). The site's statistical tier and the twin's are the same six-feature forest with
the same settings. The evaluation's numbers therefore describe the pipeline the site runs.
