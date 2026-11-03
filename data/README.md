# Reference datasets

Raw data is **not** committed — this directory is gitignored apart from this file.

The challenge requires the official reference datasets for the standard evaluation
scenario. Record each one here as it is obtained:

| Dataset | Source | Version / date | Used for | Local path |
| --- | --- | --- | --- | --- |
| Official reference datasets | TSYP14 organisers | not published as of 3 November 2026 (last checked that day) | the standard scenario | `data/official.jsonl` |

## Running the evaluation on a dataset

The seeded evaluation reads every packet through one adapter, `digital_twin/datasets.py`.
Converting the official data to its format is the only step; no tier or rule changes:

```bash
python -m digital_twin.evaluate --dataset official --path data/official.jsonl --key-hex <key>
```

The file is JSON Lines: a header line, then one line per packet as the station received it.

```json
{"format": "groundlink-records/1", "satellite": "TERRASAR-X", "tle": ["1 31698U …", "2 31698 …"], "tle_sha256": "…"}
{"t": 1793000000.0, "elevation_deg": 12.3, "label": "NONE", "split": "train",
 "link": {"slant_range_km": 1612.4, "doppler_shift_hz": 141800.2, "rssi_dbm": -84.9,
          "snr_db": 15.1, "received_phase_error_deg": 0.7},
 "predicted": null, "packet": {"ccsds_header": {…}, "secondary_header": {…}, "payload": {…},
                                "sha256_hash": "…", "hmac_sha256": "…"}}
```

| Field | Meaning |
| --- | --- |
| `t` | Reception time, Unix seconds |
| `elevation_deg` | Satellite elevation at the station |
| `label` | Ground truth for scoring only (`NONE` for genuine traffic); no tier reads it |
| `split` | `train` for the nominal packets the statistical tier learns from, else `test` |
| `link` | What the receiver measured: range, Doppler, carrier power, SNR, phase error; optionally `evm_pct` (the constellation's EVM) and `light_time_us` (the arrival against the satellite clock), which the statistical tier reads when present |
| `predicted` | The orbit and link-budget prediction; `null` and the twin computes it from the header's element set with SGP4 |
| `packet` | The decoded CCSDS packet with its digest and HMAC tag; `null` when the frame did not decode |

The header's `tle_sha256` is checked against the element set before anything is scored; its
`hw_token` (default `0x4FE2`) is the hardware token the satellite's frames must carry.

`python -m digital_twin.evaluate --export run.jsonl` writes a synthetic run in this format;
`tests/test_digital_twin.py` reads it back through the adapter and checks it reaches the
same decisions, packet for packet.

## Until then

The synthetic traffic of `digital_twin/evaluate.py` (and `groundlink/simulate.py` for the
first prototype) exercises the same pipeline end to end. Real inputs today: the CelesTrak
element sets and the ITU-R P.618-13 atmosphere. Synthetic: the frame payloads and the
RF measurements.
