# 4 · AI / Statistical Detection

> Phase 1 rubric: detector design & evaluation, 20 points.

## Design

Two tiers judge the RF, and they are built to read **different evidence**.

**Physical tier** (`security_detector.py`): the χ² gate on the four residuals against the orbit
and the kinematic range–Doppler test (deliverable 3). Deterministic: its false-alarm rate is
10⁻⁴ by construction.

**Statistical tier** (`isolation_forest_detector.SiteFrameForest`, the same detector as the
site's `linkDetector.ts`): an Isolation Forest of 256 trees, 256 samples a tree, trained on
3,000 clean frames only, flagging at the 1 % contamination point of its training scores. It
never sees an attack while training. Its six features are none of the residuals the χ² tests:

| Feature | Definition | What it sees |
| --- | --- | --- |
| EVM residual | measured EVM − the EVM the link budget predicts, percentage points | jamming, interference under a captor |
| Frame-loss rate | share of the last 10 frame slots with no decoded frame | heavy jamming |
| Arrival jitter | change of the arrival offset since the last decoded frame, µs | relay, delay and replay onsets |
| MAC / nonce failure rate | share of the last 10 decoded frames that failed authentication | forging, tampering, injection, replay |
| Carrier step | change of the carrier residual since the last delivered frame, MHz | hijacking, capture, phase pull |
| Power step | change of the power residual since the last delivered frame, dB | spoofing, capture, jamming |

An Isolation Forest cannot split on a feature that never varied in training (no MAC failure
happens on a clean pass), so the tier also flags any feature beyond the largest value seen in
training: the training-range check. Scores are computed by walking the 256 trees together
(`FastForestScorer`), identical to scikit-learn's to 10⁻¹⁵ and about 100 times faster per packet.

The site adds an anomaly-score gauge: a second forest on six scaled features (Doppler, SNR,
timing, EVM, frame loss, MAC failures), its 0.60 operating point set at a 0.6 % false-alarm rate
on 4,000 calibration samples.

## Why the statistical tier never rejects alone

Its false-alarm rate is measured, not designed, so on its own it only holds a frame for review.
Rejection needs a deterministic tier; quarantine needs two tiers, at least one deterministic.

## Evaluation protocol

`python -m digital_twin.evaluate`, seeds 1 to 6, TerraSAR-X passes over Zaghouan, one packet a
second while the link is up. Each run trains on 3,000 nominal packets, then scores 15,600 held-out
genuine packets mixed with 500 attack bursts (10 attacks × 50 × 30 packets) and 150 bursts of
three below-the-gate jams. Rates are pooled over the six runs with 95 % Wilson intervals.

- **Detection**: an attack packet is flagged when it is anything but delivered clean.
- **False alarms**: genuine packets whose last 10 frame slots hold no attack frame (54,660), not
  delivered. The 38,940 genuine packets in the 10 slots after an attack frame are the
  **hold-over**, reported apart: the failure-rate features still remember the attack there.
- **ROC curves**: the forest score and the χ² ratio, attack packets against clean ones
  (`docs/figures/roc_curves.png`).

## Results

| Metric | Measured, 6 seeds |
| --- | --- |
| Attack packets flagged | 90,000 of 90,000 (unflagged ≤ 4.3 × 10⁻⁵ at 95 %), from the first packet of every burst |
| Genuine packets not delivered | 867 of 54,660 = 1.59 % [1.48, 1.69]: 859 held, 4 rejected, 4 quarantined |
| Genuine packets, hold-over | 48.6 % held, none rejected |
| χ² fired on genuine packets | 4 of 54,660 = 7.3 × 10⁻⁵ (10⁻⁴ by design) |
| Tier correlation on genuine packets | statistical 864, physical 9, both 5: φ = 0.056 |
| Decision time per packet | 0.29–0.30 ms mean, ≤ 0.48 ms p95 |
| Memory | 158 MB peak (Python), 20.7 MB JavaScript heap (browser) |

With the sample-level receiver: 90,000 of 90,000 flagged, 1.30 % [1.21, 1.40] of genuine packets
not delivered, φ = 0.031.

| Traffic | AUC forest | AUC χ² |
| --- | ---: | ---: |
| Frequency hijacking, replay, co-channel capture | 1.000 | 1.000 |
| Stealth spoofing | 0.998 | 1.000 |
| Noise jamming | 0.997 | 1.000 |
| Relay | 0.942 | 1.000 |
| Phase slip | 0.714 | 1.000 |
| Delay | 0.523 | 1.000 |
| Data tampering, injection | 0.48–0.53 | 0.50 |
| Jam at J/N −5.3 dB | 0.779 | 0.977 |
| Jam at J/N −3.1 dB | 0.980 | 1.000 |

Read by column, no tier is enough: the χ² is at chance on tampering and injection, which leave no
RF trace, and the forest on delay, which only moves the range. Each is caught by the tier that
reads it (deliverable 5, ablation).

## Run it

```bash
python -m digital_twin.evaluate --workers 4          # the six seeds, about 1.5 minutes
python -m digital_twin.evaluate --receiver iq        # the same through the modem
make eval                                            # every table and figure, with the hash
```
