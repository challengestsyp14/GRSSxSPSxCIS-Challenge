# Start here

A ten-minute introduction: what the testbed is, how it decides, how to run it, and where each
part of the work is documented.

## 1. What it is

TSYP14 Track 1, the **Secure Ground-Link Testbed**. A satellite, TerraSAR-X, sends its telemetry
down to a ground station in Zaghouan, Tunisia, by radio; the station sends telecommands back. An
attacker with commodity radio equipment can interfere with that link. The testbed protects the
data on the link, detects the interference, and proves both with measured numbers.

The challenge cares most about **silent failure**: the station keeps working while it quietly
accepts bad data. Here every frame either reaches the analyst genuine, reaches it flagged, or
raises an alarm; none is accepted silently.

```
   TerraSAR-X                                                     GS-ZAG (Zaghouan)
  ┌──────────┐     X-band downlink, 8477.8 MHz  ──────────────►  ┌──────────────────┐
  │  frames  │                                                   │ decoder          │
  │  sealed  │     S-band uplink, 2050 MHz      ◄──────────────  │ data tier        │
  └──────────┘                    ▲                              │ statistical tier │
                           ┌──────┴──────┐                       │ physical tier    │
                           │  attacker   │ spoof · capture ·     │ decision rule    │
                           └─────────────┘ jam · tamper · inject │ ledger           │
                                           replay · relay · delay└──────────────────┘
```

## 2. How a frame is judged

1. **The decoder** (CCSDS rate-1/2 code) loses a frame below 4.4 dB of SNR; it never hands on a
   corrupted one.
2. **The data tier** checks the HMAC-SHA256 tag (noise cannot forge it), the hardware token and
   the sequence count (a replay is stale).
3. **The physical tier** compares range, Doppler, power and phase with what the orbit (SGP4) and
   the link budget (ITU-R P.618) predict, in a χ² gate, and checks that range and Doppler agree.
4. **The statistical tier**, an Isolation Forest trained on clean passes, reads what the χ² does
   not test: the constellation's error, lost frames, arrival jitter, failed tags, sudden changes.
5. **The decision rule**: delivered, degraded (genuine frame on a jammed link, flagged), held
   (statistical tier alone), rejected (a deterministic tier), quarantined (two tiers, or a burst
   of failures). The key is changed only if someone is shown to hold it.

## 3. Run it

| What | Command |
| --- | --- |
| The live testbed | `cd dashboard && npm ci && npm run dev`, then http://localhost:5173 |
| Every table of the report | `make install && make eval` (about 8 minutes, checks the expected hash) |
| A quick check | `make eval-quick` (about 3.5 minutes) |
| The tests | `make test` (147 Python) and `cd dashboard && npm test` (64) |

Nothing needs the network: the site flies a built-in orbit snapshot, the evaluation a built-in
element set.

On the site, every page shares the same top bar: **Live testbed** (the whole ground link on one
screen, scaled to the window), **Signals** (167 satellites and their passes over Zaghouan),
**Noise attacks**, **Protection** (the stealth budget by elevation) and **Slides** (the explainer
as still slides). Press **Play demo** on the testbed to see the four downlink attacks in 48 s.

## 4. Where everything is documented

| Deliverable | Document |
| --- | --- |
| 1 · Threat model & segment analysis | [1-threat-model.md](1-threat-model.md) |
| 2 · Platform, architecture & trust anchor | [2-architecture-trust-anchor.md](2-architecture-trust-anchor.md) |
| 3 · Signal processing | [3-signal-processing.md](3-signal-processing.md) |
| 4 · AI / statistical detection | [4-detection.md](4-detection.md) |
| 5 · Adversarial validation & response | [5-adversarial-validation.md](5-adversarial-validation.md) |
| 6 · Documentation, datasets & reproducibility | [6-datasets-reproducibility.md](6-datasets-reproducibility.md) |

The measured numbers are in [evaluation-report.md](evaluation-report.md); a guided tour of the site
in [evaluation-guide.md](evaluation-guide.md); the seven-minute demo in
[demo-script.md](demo-script.md). All of these documents, with the dataset format and the README,
are also in one PDF: `docs/Secure-Ground-Link-Testbed-Documentation.pdf`.

## 5. The numbers that matter

| Measure | Six seeded runs |
| --- | --- |
| Attack packets flagged | 90,000 of 90,000, from the first packet of every burst |
| Corrupted frames reaching the analyst | 0 |
| Genuine packets held for review or rejected | 1.59 % (1.30 % through the sample-level receiver) |
| Hostile telecommands executed | 0 of 900 |
| Decision time | 0.3 ms per packet |

All traffic is synthetic (the orbits and the atmosphere are real); the figures will be
re-measured on the official reference datasets when they are published.

## Glossary

| Term | Meaning |
| --- | --- |
| Frame | One packet of satellite data, sealed with its own tag |
| HMAC-SHA256 tag | A code computed from the frame and a secret key; any change breaks it |
| Replay window | The record of recent sequence counts; an old count is refused |
| χ² (chi-square) gate | The sum of the squared, normalised gaps between what was measured and what the orbit predicts |
| Stealth budget | The most noise a jammer can add before the χ² gate fires: about 1.1 dB of SNR overhead, 1.7 dB at the 2° mask |
| EVM | Error vector magnitude: how far the received symbols sit from where QPSK puts them |
| Isolation Forest | A detector that learns what clean traffic looks like and flags what is easy to isolate from it |
| Quarantine | Isolating the link and re-acquiring it after two tiers fire, or a burst of failures |
| GS-MAT | The fallback ground station in Matera, used when Zaghouan is jammed |
