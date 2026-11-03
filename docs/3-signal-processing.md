# 3 · Signal Processing

> Phase 1 rubric: signal / image processing, 15 points.

The station knows the orbit, so for every instant it can predict what the link must look like.
Signal processing turns each reception into **measurements**, then **residuals against that
prediction**, in units of their natural spread.

## The link model

| Quantity | Value | Source |
| --- | --- | --- |
| Orbit | SGP4 on the CelesTrak element set; TerraSAR-X 510–518 km during a pass | `propagation.py` |
| Downlink | 8477.8 MHz, QPSK in a 6 MHz channel, CCSDS rate-1/2 convolutional code | `link_budget.py`, `fec.py` |
| Slant range | 2,397 km at the 2° mask to 514 km overhead | SGP4 + the station's position |
| Doppler | ±199 kHz at the mask | range rate |
| Atmosphere | ITU-R P.618-13 median attenuation: 1.06 dB at 2°, 0.05 dB overhead | `link_budget.py` |
| Received power | −88.8 dBm at the mask to −74.4 dBm overhead | free space + atmosphere |
| Noise floor | −100 dBm | receiver |
| SNR (Es/N0) | 11.2 to 25.6 dB over the pass; the decoder needs 4.4 dB | |

## Two receivers

The evaluation runs every packet through one of two receivers, selected with `--receiver`:

**Measurement model** (`physics_validator.py`, default). The truth plus the natural spread of
each measurement on a clean pass: range 1.6 µs (0.48 km), Doppler 6.1 Hz, power 0.23 dB, phase
1.5°, widened near the horizon by $w(el) = 1 + 2e^{-el/6°}$; the SNR from the receiver's noise
floor estimate (0.1 dB), and the EVM of the constellation from the SNR (and the
signal-to-interference ratio when a second carrier shares the channel).

**Sample-level receiver** (`iq_receiver.py`, `--receiver iq`). The twin builds each frame's
waveform and measures it, as a modem does:

| Stage | What it does |
| --- | --- |
| Transmitter | QPSK at 50 ksym/s, Gray mapped, root-raised-cosine pulses (roll-off 0.35, 8 symbols, 8 samples a symbol); a 64-symbol preamble (the CCSDS sync marker 0x1ACFFC1D four times) and 960 data symbols |
| Channel | The true Doppler (SGP4 plus the oscillator's offset) against the receiver's oscillator, which follows the SGP4 prediction; the true light time against the predicted one as a fractional delay; the carrier phase; Es/N0 from the link budget minus what a jammer adds; AWGN; a second carrier when an attacker shares the channel |
| Acquisition | Modelled at its output: the 200 Hz FFT bin and the whole symbol of the sync marker it locks to |
| Timing | Matched filter, then the preamble correlator, non-coherent, with parabolic interpolation of its peak |
| Symbols | The matched filter shifted by the measured fraction, one sample a symbol |
| Carrier | A data-aided line through the unwrapped phase of the preamble, then a second-order phase-locked loop over the frame, data-aided on the preamble and decision-directed after it |
| SNR | The blind M2M4 moments estimator on the symbol samples |
| EVM | The constellation after the loop against the nearest QPSK point |

At Es/N0 = 15 dB the estimators are unbiased to within 0.04 dB (SNR), 0.02 Hz (Doppler) and
0.02 µs (timing), with spreads of 0.22 dB, 0.12 Hz, 0.18 µs and 0.54° (phase); the EVM matches
$100/\sqrt{\mathrm{SNR}}$ (17.8 %). The χ² spreads are then measured on the training frames:
0.48 km, 6.05 Hz, 0.31 dB, 1.59°. `docs/figures/constellations.png` shows one received frame per
traffic class: the co-channel capture smears the constellation into rings, jamming spreads it.

## The decoder

`fec.py` (ported as `fec.ts`): the CCSDS rate-1/2, K = 7 code with soft-decision Viterbi
decoding, one 1,115-byte frame per packet. Its frame error rate is the union bound on the code's
distance spectrum, with $E_c/N_0 = E_s/N_0 / 2$:

$$\mathrm{FER} \approx 8920 \sum_{d} a_d\, Q\!\left(\sqrt{2 d\, E_c/N_0}\right), \quad a_{10..18} = 11, 38, 193, 1331, 7275$$

It falls from 0.8 at 3 dB to 10⁻³ at 5 dB; the threshold at 1 % is 4.4 dB. Below it a frame is
lost, never delivered with flipped bits, so heavy jamming costs frames, not integrity.

## Residuals: the physical tier

Range (from the frame timing), Doppler, received power and carrier phase are compared with SGP4
and the P.618 budget; each residual is divided by its natural spread and the squares are summed:

$$\chi^2 = \sum_{i=1}^{4} \left(\frac{x_i - \hat{x}_i}{\sigma_i}\right)^2 \le 23.5\, w(el)$$

23.5 is the $1 - 10^{-4}$ quantile of a χ² law with 4 degrees of freedom; $w(el)$ widens the gate
to 57.2 at the 2° mask, 34.0 at 9° and 23.8 at 30°, where scintillation and multipath spread the
residuals. The **kinematic test** checks that the range change since the last trusted frame
equals the integrated Doppler, $\Delta\rho = -(c/f)\int f_d\,dt$, within ±3.89σ; it needs no
ephemeris.

## How much noise can hide

A jammer adds noise J/N dB above the thermal floor and costs the link
$\Delta\mathrm{SNR} = 10\log_{10}(1 + 10^{(J/N)/10})$. It stays under the gate while that cost is
below the power allowance $\sqrt{23.5\, w(el)} \times 0.23$ dB:

| Elevation | $w(el)$ | Gate | Largest hidden SNR loss | Largest hidden J/N |
| --- | ---: | ---: | ---: | ---: |
| 2° (mask) | 2.43 | 57.2 | 1.74 dB | −3.1 dB |
| 9° | 1.45 | 34.0 | 1.34 dB | −4.4 dB |
| 30° | 1.01 | 23.8 | 1.12 dB | −5.3 dB |
| 90° | 1.00 | 23.5 | 1.12 dB | −5.3 dB |

With the sample-level receiver's 0.31 dB power spread the overhead allowance becomes 1.49 dB. At
the mask the SNR drops from 11.2 to 9.5 dB at most, far above the decoder's 4.4 dB: every frame
still decodes and authenticates. The Protection page of the site lets anyone drag this curve and
pick the elevation.

## Run it

```bash
python -m digital_twin.evaluate --receiver iq --seeds 1     # one seed through the modem
python -m pytest tests/test_digital_twin.py -k iq_receiver   # the estimators' test
```
