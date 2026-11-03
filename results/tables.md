# Reproduced tables

## Evaluation, model receiver, seeds [1, 2, 3, 4, 5, 6]

| traffic | n | data | statistical | physical | delivered | degraded | held | rejected | quarantined | rekey |
|---|---|---|---|---|---|---|---|---|---|---|
| NONE | 54660 | 0.00 | 1.58 | 0.02 | 98.41 | 0.00 | 1.57 | 0.01 | 0.01 | 0 |
| NONE_HOLDOVER | 38940 | 0.00 | 48.63 | 0.01 | 51.36 | 0.01 | 48.62 | 0.00 | 0.00 | 0 |
| FREQUENCY_HIJACKING | 9000 | 100.00 | 100.00 | 100.00 | 0.00 | 0.00 | 0.00 | 0.00 | 100.00 | 0 |
| STEALTH_SPOOFING | 9000 | 100.00 | 100.00 | 100.00 | 0.00 | 0.00 | 0.00 | 0.00 | 100.00 | 0 |
| NOISE_JAMMING | 9000 | 16.58 | 100.00 | 100.00 | 0.00 | 82.58 | 0.00 | 0.00 | 17.42 | 0 |
| DATA_TAMPERING | 9000 | 100.00 | 96.72 | 0.03 | 0.00 | 0.00 | 0.00 | 3.27 | 96.73 | 0 |
| RELAY | 9000 | 0.00 | 100.00 | 100.00 | 0.00 | 0.00 | 0.00 | 0.00 | 100.00 | 0 |
| PHASE_SLIP (held out) | 9000 | 0.00 | 3.49 | 100.00 | 0.00 | 0.00 | 0.00 | 96.51 | 3.49 | 0 |
| INJECTION | 9000 | 100.00 | 96.69 | 0.02 | 0.00 | 0.00 | 0.00 | 3.31 | 96.69 | 0 |
| REPLAY | 9000 | 100.00 | 100.00 | 100.00 | 0.00 | 0.00 | 0.00 | 0.00 | 100.00 | 0 |
| DELAY | 9000 | 0.00 | 4.72 | 100.00 | 0.00 | 0.00 | 0.00 | 95.28 | 4.72 | 0 |
| CO_CHANNEL_CAPTURE (held out) | 9000 | 100.00 | 100.00 | 100.00 | 0.00 | 0.00 | 0.00 | 0.00 | 100.00 | 0 |
| JAM_BELOW_GATE_DEMO | 9000 | 0.00 | 2.44 | 0.07 | 97.52 | 0.06 | 2.41 | 0.01 | 0.00 | 0 |
| JAM_AT_STEALTH_LIMIT | 9000 | 0.00 | 17.51 | 35.97 | 53.48 | 35.97 | 10.56 | 0.00 | 0.00 | 0 |
| JAM_AT_MASK_LIMIT | 9000 | 0.00 | 80.59 | 91.93 | 2.93 | 91.92 | 5.13 | 0.01 | 0.00 | 0 |

| traffic | AUC forest | AUC chi-square | unflagged without data / stat / phys |
|---|---|---|---|
| FREQUENCY_HIJACKING | 1.000 | 1.000 | 0.00 / 0.00 / 0.00 |
| STEALTH_SPOOFING | 0.998 | 1.000 | 0.00 / 0.00 / 0.00 |
| NOISE_JAMMING | 0.997 | 1.000 | 0.00 / 0.00 / 0.00 |
| DATA_TAMPERING | 0.483 | 0.502 | 3.27 / 0.00 / 0.00 |
| RELAY | 0.942 | 1.000 | 0.00 / 0.00 / 0.00 |
| PHASE_SLIP | 0.714 | 1.000 | 0.00 / 0.00 / 96.51 |
| INJECTION | 0.531 | 0.498 | 3.31 / 0.00 / 0.00 |
| REPLAY | 1.000 | 1.000 | 0.00 / 0.00 / 0.00 |
| DELAY | 0.523 | 1.000 | 0.00 / 0.00 / 95.28 |
| CO_CHANNEL_CAPTURE | 1.000 | 1.000 | 0.00 / 0.00 / 0.00 |
| JAM_BELOW_GATE_DEMO | 0.548 | 0.561 | 97.52 / 99.93 / 97.56 |
| JAM_AT_STEALTH_LIMIT | 0.779 | 0.977 | 53.48 / 64.03 / 82.49 |
| JAM_AT_MASK_LIMIT | 0.980 | 1.000 | 2.93 / 8.07 / 19.41 |

genuine: statistical 864, physical 9, both 5, of 54660
uplink COMMAND_TAMPERING: 0/300 executed
uplink COMMAND_INJECTION: 0/300 executed
uplink COMMAND_REPLAY: 0/300 executed

## Evaluation, iq receiver, seeds [1, 2, 3, 4, 5, 6]

chi-square sigmas (seed 1): doppler_shift_hz 6.0451, received_phase_error_deg 1.5934, rssi_dbm 0.3068, slant_range_km 0.4751

| traffic | n | data | statistical | physical | delivered | degraded | held | rejected | quarantined | rekey |
|---|---|---|---|---|---|---|---|---|---|---|
| NONE | 54660 | 0.00 | 1.29 | 0.02 | 98.70 | 0.00 | 1.28 | 0.01 | 0.01 | 0 |
| NONE_HOLDOVER | 38940 | 0.00 | 48.44 | 0.01 | 51.56 | 0.01 | 48.43 | 0.00 | 0.01 | 0 |
| FREQUENCY_HIJACKING | 9000 | 100.00 | 100.00 | 100.00 | 0.00 | 0.00 | 0.00 | 0.00 | 100.00 | 0 |
| STEALTH_SPOOFING | 9000 | 100.00 | 100.00 | 99.96 | 0.00 | 0.00 | 0.00 | 0.00 | 100.00 | 0 |
| NOISE_JAMMING | 9000 | 16.87 | 100.00 | 100.00 | 0.00 | 78.66 | 0.00 | 0.00 | 21.34 | 0 |
| DATA_TAMPERING | 9000 | 100.00 | 96.70 | 0.04 | 0.00 | 0.00 | 0.00 | 3.29 | 96.71 | 0 |
| RELAY | 9000 | 0.00 | 4.83 | 100.00 | 0.00 | 0.00 | 0.00 | 95.17 | 4.83 | 0 |
| PHASE_SLIP (held out) | 9000 | 0.00 | 3.63 | 100.00 | 0.00 | 0.00 | 0.00 | 96.37 | 3.63 | 0 |
| INJECTION | 9000 | 100.00 | 96.70 | 0.03 | 0.00 | 0.00 | 0.00 | 3.30 | 96.70 | 0 |
| REPLAY | 9000 | 100.00 | 100.00 | 100.00 | 0.00 | 0.00 | 0.00 | 0.00 | 100.00 | 0 |
| DELAY | 9000 | 0.00 | 4.76 | 100.00 | 0.00 | 0.00 | 0.00 | 95.24 | 4.76 | 0 |
| CO_CHANNEL_CAPTURE (held out) | 9000 | 100.00 | 100.00 | 100.00 | 0.00 | 0.00 | 0.00 | 0.00 | 100.00 | 0 |
| JAM_BELOW_GATE_DEMO | 9000 | 0.00 | 2.01 | 0.08 | 97.92 | 0.08 | 2.00 | 0.00 | 0.00 | 0 |
| JAM_AT_STEALTH_LIMIT | 9000 | 0.00 | 21.07 | 15.46 | 66.97 | 15.46 | 17.58 | 0.00 | 0.00 | 0 |
| JAM_AT_MASK_LIMIT | 9000 | 0.00 | 72.46 | 62.87 | 11.88 | 62.86 | 25.26 | 0.01 | 0.00 | 0 |

| traffic | AUC forest | AUC chi-square | unflagged without data / stat / phys |
|---|---|---|---|
| FREQUENCY_HIJACKING | 1.000 | 1.000 | 0.00 / 0.00 / 0.00 |
| STEALTH_SPOOFING | 0.997 | 1.000 | 0.00 / 0.00 / 0.00 |
| NOISE_JAMMING | 0.996 | 1.000 | 0.00 / 0.00 / 0.00 |
| DATA_TAMPERING | 0.482 | 0.503 | 3.29 / 0.00 / 0.00 |
| RELAY | 0.512 | 1.000 | 0.00 / 0.00 / 95.17 |
| PHASE_SLIP | 0.713 | 1.000 | 0.00 / 0.00 / 96.37 |
| INJECTION | 0.532 | 0.497 | 3.30 / 0.00 / 0.00 |
| REPLAY | 1.000 | 1.000 | 0.00 / 0.00 / 0.00 |
| DELAY | 0.519 | 1.000 | 0.00 / 0.00 / 95.24 |
| CO_CHANNEL_CAPTURE | 1.000 | 1.000 | 0.00 / 0.00 / 0.00 |
| JAM_BELOW_GATE_DEMO | 0.560 | 0.558 | 97.92 / 99.92 / 97.99 |
| JAM_AT_STEALTH_LIMIT | 0.872 | 0.928 | 66.97 / 84.54 / 78.93 |
| JAM_AT_MASK_LIMIT | 0.963 | 0.994 | 11.88 / 37.13 / 27.54 |

genuine: statistical 703, physical 12, both 3, of 54660
uplink COMMAND_TAMPERING: 0/300 executed
uplink COMMAND_INJECTION: 0/300 executed
uplink COMMAND_REPLAY: 0/300 executed

## Adaptive attacker, seed 1, iq receiver

capture_curve:
- 0.5 dB, 0 Hz, 0 us: physical 1.000, statistical 1.000, data 1.000, decoded 0.000
- 1 dB, 0 Hz, 0 us: physical 1.000, statistical 1.000, data 1.000, decoded 0.000
- 1.5 dB, 0 Hz, 0 us: physical 1.000, statistical 1.000, data 1.000, decoded 0.000
- 2 dB, 0 Hz, 0 us: physical 1.000, statistical 1.000, data 1.000, decoded 0.000
- 3 dB, 0 Hz, 0 us: physical 1.000, statistical 1.000, data 1.000, decoded 0.010
- 4 dB, 0 Hz, 0 us: physical 1.000, statistical 1.000, data 1.000, decoded 0.940
- 5 dB, 0 Hz, 0 us: physical 1.000, statistical 1.000, data 1.000, decoded 1.000
- 6 dB, 0 Hz, 0 us: physical 1.000, statistical 1.000, data 1.000, decoded 1.000
- 8 dB, 0 Hz, 0 us: physical 1.000, statistical 1.000, data 1.000, decoded 1.000

power_curve:
- 0 dB, 0 Hz, 0 us: physical 0.000, statistical 0.010, data 1.000, decoded 1.000
- 0.25 dB, 0 Hz, 0 us: physical 0.000, statistical 0.010, data 1.000, decoded 1.000
- 0.5 dB, 0 Hz, 0 us: physical 0.000, statistical 0.090, data 1.000, decoded 1.000
- 0.75 dB, 0 Hz, 0 us: physical 0.000, statistical 0.230, data 1.000, decoded 1.000
- 1 dB, 0 Hz, 0 us: physical 0.040, statistical 0.430, data 1.000, decoded 1.000
- 1.25 dB, 0 Hz, 0 us: physical 0.130, statistical 0.520, data 1.000, decoded 1.000
- 1.5 dB, 0 Hz, 0 us: physical 0.250, statistical 0.490, data 1.000, decoded 1.000
- 2 dB, 0 Hz, 0 us: physical 0.640, statistical 0.980, data 1.000, decoded 1.000
- 3 dB, 0 Hz, 0 us: physical 0.980, statistical 1.000, data 1.000, decoded 1.000

doppler_curve:
- 0 dB, 0 Hz, 0 us: physical 0.000, statistical 0.010, data 1.000, decoded 1.000
- 0 dB, 5 Hz, 0 us: physical 0.000, statistical 0.010, data 1.000, decoded 1.000
- 0 dB, 10 Hz, 0 us: physical 0.010, statistical 0.020, data 1.000, decoded 1.000
- 0 dB, 15 Hz, 0 us: physical 0.000, statistical 0.020, data 1.000, decoded 1.000
- 0 dB, 20 Hz, 0 us: physical 0.080, statistical 0.050, data 1.000, decoded 1.000
- 0 dB, 25 Hz, 0 us: physical 0.140, statistical 0.060, data 1.000, decoded 1.000
- 0 dB, 30 Hz, 0 us: physical 0.390, statistical 0.100, data 1.000, decoded 1.000
- 0 dB, 40 Hz, 0 us: physical 0.810, statistical 0.050, data 1.000, decoded 1.000
- 0 dB, 60 Hz, 0 us: physical 0.990, statistical 0.150, data 1.000, decoded 1.000

timing_curve:
- 0 dB, 0 Hz, 0 us: physical 0.020, statistical 0.010, data 1.000, decoded 1.000
- 0 dB, 0 Hz, 0.5 us: physical 0.000, statistical 0.000, data 1.000, decoded 1.000
- 0 dB, 0 Hz, 1 us: physical 0.000, statistical 0.040, data 1.000, decoded 1.000
- 0 dB, 0 Hz, 1.5 us: physical 0.000, statistical 0.020, data 1.000, decoded 1.000
- 0 dB, 0 Hz, 2 us: physical 0.000, statistical 0.020, data 1.000, decoded 1.000
- 0 dB, 0 Hz, 2.5 us: physical 0.010, statistical 0.020, data 1.000, decoded 1.000
- 0 dB, 0 Hz, 3 us: physical 0.000, statistical 0.050, data 1.000, decoded 1.000
- 0 dB, 0 Hz, 4 us: physical 0.030, statistical 0.090, data 1.000, decoded 1.000
- 0 dB, 0 Hz, 6 us: physical 0.190, statistical 0.220, data 1.000, decoded 1.000

under the gate, power_db: 0.4219 (RF tiers 0.030)
under the gate, doppler_hz: 15.94 (RF tiers 0.030)
under the gate, timing_us: 2.719 (RF tiers 0.030)
all three at once: RF tiers 0.270, data 1.000
