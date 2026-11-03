# Seven-minute demo

The path is scripted to the second. If the live dashboard fails, play
`docs/demo/fallback-demo.mp4`, a recording of the same path (2:30), and narrate over it.

Before the session: `cd dashboard && npm ci && npm run dev`, open http://localhost:5173 at
1600 × 900, wait for the 3D scene, close every other tab. Keep `docs/figures/` open in a second
window for minutes 5 and 6.

| Time | Screen | Say |
| --- | --- | --- |
| 0:00 | Live testbed, idle | Who attacks a ground link and why: a rogue carrier, a spoofer that fakes a fade, a relay that flips bits, a jammer that hides in the noise. TerraSAR-X over Zaghouan, every figure from its real element set. |
| 0:40 | Click **Play demo** | Three tiers: data (HMAC-SHA256, nonce window), physical (χ² against SGP4 and the link budget), statistical (Isolation Forest). The demo runs a false alarm, then hijack, tampering, spoofing, jamming, 48 s. |
| 0:55 | False-alarm moment | One tier alone only holds a frame. Nothing is dropped on a single statistical flag. The false-alarm tile reads a few percent here because the demo injects this false alarm into a few dozen genuine frames; the measured rate is 1.6 %. |
| 1:05 | Hijack | Carrier 14.2 MHz off the Doppler track: physical and data tiers fire on the first frame, link quarantined. No frame had a valid tag, so the key is not changed. |
| 1:15 | Tampering | No RF signature at all: the χ² sees nothing, the HMAC breaks. Data tier only. |
| 1:25 | Spoofing | A 3.2 dB "fade" on the Doppler track: 14 σ off the link budget. |
| 1:35 | Jamming | Power collapses; frames that still decode are delivered **flagged as degraded**, the rest are lost, routing falls back to the second station. |
| 1:40 | Click **Change satellite** in the status strip, then close it | The testbed flies any of the 167 satellites: pick one and it switches to that satellite's next pass. |
| 1:45 | Click **Inspect packets**, scroll | One frame through every tier: tag, nonce, the four χ² residuals, the forest's six features, the decision and its reasons. |
| 2:30 | **Protection** page, elevation buttons 2°, 9°, 30°, 90° | Issue 2: the stealth budget depends on elevation (table below). |
| 3:30 | Same page, the jam curve | Issue 3: what a jam under the gate costs, before and after the degraded-delivery rule. |
| 4:30 | `docs/figures/roc_curves.png` | Issue 7: the tiers see different things (φ, ablation). |
| 5:15 | `docs/figures/constellations.png`, `adaptive_*.png` | The receiver at sample level, and an attacker that knows the gates. |
| 6:15 | Terminal: `make eval-quick` output | Every table reproduced from fixed seeds; the hash matches. |
| 6:45 | Back to the live testbed | Close: 90,000 of 90,000 attack packets flagged, none delivered unflagged; 1.6 % of genuine packets held for review. |

## Prepared answers

### Issue 2: "Is the stealth budget the same at every elevation?"

No. Near the horizon the residuals spread more, so the χ² gate widens by
$w(el) = 1 + 2e^{-el/6^\circ}$ and a jammer can hide more noise:

| Elevation | Gate widening | Gate | Largest hidden SNR loss | J/N |
| --- | --- | --- | --- | --- |
| 2° | 2.43 | 57.2 | 1.74 dB | −3.1 dB |
| 9° | 1.45 | 34.0 | 1.34 dB | −4.4 dB |
| 30° | 1.01 | 23.8 | 1.12 dB | −5.3 dB |
| 90° | 1.00 | 23.5 | 1.12 dB | −5.3 dB |

$\Delta\mathrm{SNR}_{\max}(el) = \sqrt{23.5\,w(el)} \times 0.23$ dB. With the sample-level receiver
the measured power spread is 0.31 dB, so the same formula gives 1.49 dB overhead. Every frame
under that budget still authenticates.

### Issue 3: "You call the hidden jam harmless; your own numbers show frames lost."

The word is gone. The jam under the gate is **bounded**, not harmless: at the overhead limit
(J/N −5.3 dB) it costs 1.12 dB of SNR. What changed is what the station does with a genuine frame
whose only anomaly is its power:

| J/N −5.3 dB | Before | After (degraded delivery) |
| --- | --- | --- |
| Delivered clean | 50.3–56.8 % | 53.5 % |
| Delivered, flagged as degraded | 0 | 36.0 % |
| Held for review (statistical tier) | 0 | 10.6 % |
| Rejected (physical tier) | 34.7–37.1 % | 0 % |
| Reaching the analyst | 50.3–56.8 % | 89.4 % |

A frame is delivered as degraded only when its tag and nonce are valid, the kinematic test
passes and the χ² fails on the power residual alone; a jamming alarm is raised.

### Issue 7: "Three tiers, but are they independent?"

They are now built to read different evidence. The statistical tier no longer uses any residual
the χ² tests: its six features are the EVM, the frame-loss rate, the arrival jitter, the
MAC/nonce failure rate and the changes of carrier and power since the last accepted frame. On
54,660 genuine packets the two RF tiers' flags correlate at φ = 0.056 (0.031 with the
sample-level receiver): 864 statistical flags, 9 physical, 5 both. The statistical tier never
quarantines on its own: quarantine needs two tiers, one of them deterministic. And the key is
changed only on evidence that someone holds it (a valid tag on a foreign hardware token, or on
new content under a stale nonce): in the whole evaluation that never happened, so there were 0
re-keys. The ablation shows which tier each attack depends on: without the physical tier, 96.5 %
of phase-slip and 95.3 % of delay packets would pass; without the data tier, 3.3 % of tampering
and injection.
