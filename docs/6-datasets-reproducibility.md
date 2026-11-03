# 6 · Documentation, Official Datasets & Reproducibility

> Phase 1 rubric: clarity & reproducibility, 5 points; feasibility, affordability & local
> execution, 10 points.

## Official reference datasets

The challenge asks for the official reference datasets of the standard evaluation scenario. When
we last checked, on **3 November 2026**, the organisers had not published them. The evaluation is
ready for them: every packet is read through one adapter, `digital_twin/datasets.py`, and the
official set runs with no code change:

```bash
python -m digital_twin.evaluate --dataset official --path data/official.jsonl --key-hex <key>
```

The format (JSON Lines, a header with the element set and its SHA-256, then one record per packet
with its time, elevation, label, measured link, prediction and decoded packet) is documented in
[`data/README.md`](../data/README.md). `tests/test_digital_twin.py` exports a synthetic run in
that format and reads it back to the same decisions, packet for packet.

| Data | Real or synthetic |
| --- | --- |
| Orbits | Real: CelesTrak GP element sets, 167 Earth-observation satellites; a TerraSAR-X set is built in for offline runs |
| Atmosphere | Real: ITU-R P.618-13 median attenuation at Zaghouan |
| Frame payloads, RF measurements, attacks | Synthetic, seeded |

The figures describe the testbed, not a real link, and will be re-measured on the official data.

## Reproducing every number

```bash
make install       # the exact environment: requirements-lock.txt (Python 3.11)
make eval          # seeds 1-6 with both receivers, the adaptive attacker, the figures
make eval-quick    # seeds 1 and 2, a lighter attacker
make test          # 147 Python tests
make docker        # the same evaluation in a container, no Python on the machine
```

`make eval` writes `results/tables.md`, every number of the report in a canonical form (counts,
rates and areas; no timings), the JSON behind it and `docs/figures/*.png`, then checks the
SHA-256 of `results/tables.md` against `results/EXPECTED_SHA256`:

| Run | Time on 4 cores | Expected SHA-256 |
| --- | --- | --- |
| `make eval` | about 8 minutes | `7533399f3487d60c0de7daee011a9fe27437bf10d58679975c72548f612b55ab` |
| `make eval-quick` | about 3.5 minutes | `cbfdc3d8bc4cbd8bfe8dc35b37b7bbeb63d04a06f3cb41eed0de6be69b340629` |

Everything is seeded and offline (the built-in element set). Runs with 2 and 4 workers give the
same file; a clean copy of the repository reproduces the quick hash.

The live testbed:

```bash
cd dashboard
npm ci
npm run dev        # http://localhost:5173, offline on the built-in orbit snapshot
npm test           # 64 tests
```

## Feasibility & affordability

| Requirement | How it is met |
| --- | --- |
| No purchase | Software trust anchor (HMAC-SHA256, SHA-256 chain, Ed25519 in Web Crypto); no SDR, no hardware |
| Local laptop execution | The whole testbed runs in a browser; the six-seed evaluation takes about 1.5 minutes on 4 cores |
| Decision time | 0.3 ms per packet in Python; the browser keeps up with 3.1 frames a second |
| Memory | 158 MB peak for the Python evaluation; 20.7 MB of JavaScript heap for the live dashboard |
| Open dependencies | numpy, scipy, scikit-learn, sgp4, cryptography; React, three.js, satellite.js; all open source |
| No network needed | Offline, the site flies a built-in orbit snapshot and the twin a built-in element set |

## Documentation map

| Document | What it covers |
| --- | --- |
| [README.md](../README.md) | What the testbed is, how to run it, the repository layout |
| [1 · Threat model](1-threat-model.md) | Segment, assets, adversary, attack catalogue, residual risk |
| [2 · Architecture & trust anchor](2-architecture-trust-anchor.md) | Pipeline, modules, HMAC, replay window, ledger, keys, decision and re-key rules |
| [3 · Signal processing](3-signal-processing.md) | Link model, the two receivers, decoder, χ² residuals, stealth budget |
| [4 · Detection](4-detection.md) | The statistical tier, protocol, results, ROC |
| [5 · Adversarial validation](5-adversarial-validation.md) | Standard scenario, attacks, evasion, adaptive attacker, response |
| [6 · Datasets & reproducibility](6-datasets-reproducibility.md) | This document |
| [evaluation-report.md](evaluation-report.md) | Every measured number, with intervals |
| [evaluation-guide.md](evaluation-guide.md) | A guided tour of the site for evaluators |
| [demo-script.md](demo-script.md) | The seven-minute demo, with prepared answers |
| `Secure-Ground-Link-Testbed-Documentation.pdf` | All the documents above, with the dataset format, in one PDF |

## Anonymity

- [x] No names, unit names or logos in the code, the documents, the report or the figures
- [x] Every commit authored by "TSYP14 Team" with a neutral address
- [x] Report metadata limited to its title; fonts embedded, no author field
- [x] No screenshots with user names, paths or browser profiles
- [x] No hosted address of the site in the documents: it runs locally
