# Reproduced tables

## Evaluation, model receiver, seeds [1, 2]

| traffic | n | data | statistical | physical | delivered | degraded | held | rejected | quarantined | rekey |
|---|---|---|---|---|---|---|---|---|---|---|
| NONE | 18220 | 0.00 | 1.34 | 0.02 | 98.66 | 0.00 | 1.33 | 0.01 | 0.01 | 0 |
| NONE_HOLDOVER | 12980 | 0.00 | 48.44 | 0.00 | 51.56 | 0.00 | 48.44 | 0.00 | 0.00 | 0 |
| FREQUENCY_HIJACKING | 3000 | 100.00 | 100.00 | 100.00 | 0.00 | 0.00 | 0.00 | 0.00 | 100.00 | 0 |
| STEALTH_SPOOFING | 3000 | 100.00 | 100.00 | 100.00 | 0.00 | 0.00 | 0.00 | 0.00 | 100.00 | 0 |
| NOISE_JAMMING | 3000 | 16.67 | 100.00 | 100.00 | 0.00 | 82.47 | 0.00 | 0.00 | 17.53 | 0 |
| DATA_TAMPERING | 3000 | 100.00 | 96.70 | 0.07 | 0.00 | 0.00 | 0.00 | 3.30 | 96.70 | 0 |
| RELAY | 3000 | 0.00 | 100.00 | 100.00 | 0.00 | 0.00 | 0.00 | 0.00 | 100.00 | 0 |
| PHASE_SLIP (held out) | 3000 | 0.00 | 3.93 | 100.00 | 0.00 | 0.00 | 0.00 | 96.07 | 3.93 | 0 |
| INJECTION | 3000 | 100.00 | 96.70 | 0.00 | 0.00 | 0.00 | 0.00 | 3.30 | 96.70 | 0 |
| REPLAY | 3000 | 100.00 | 100.00 | 100.00 | 0.00 | 0.00 | 0.00 | 0.00 | 100.00 | 0 |
| DELAY | 3000 | 0.00 | 4.53 | 100.00 | 0.00 | 0.00 | 0.00 | 95.47 | 4.53 | 0 |
| CO_CHANNEL_CAPTURE (held out) | 3000 | 100.00 | 100.00 | 100.00 | 0.00 | 0.00 | 0.00 | 0.00 | 100.00 | 0 |
| JAM_BELOW_GATE_DEMO | 3000 | 0.00 | 2.17 | 0.00 | 97.83 | 0.00 | 2.17 | 0.00 | 0.00 | 0 |
| JAM_AT_STEALTH_LIMIT | 3000 | 0.00 | 13.83 | 36.07 | 56.23 | 36.07 | 7.70 | 0.00 | 0.00 | 0 |
| JAM_AT_MASK_LIMIT | 3000 | 0.00 | 74.30 | 92.03 | 3.57 | 92.03 | 4.40 | 0.00 | 0.00 | 0 |

| traffic | AUC forest | AUC chi-square | unflagged without data / stat / phys |
|---|---|---|---|
| FREQUENCY_HIJACKING | 1.000 | 1.000 | 0.00 / 0.00 / 0.00 |
| STEALTH_SPOOFING | 0.999 | 1.000 | 0.00 / 0.00 / 0.00 |
| NOISE_JAMMING | 0.999 | 1.000 | 0.00 / 0.00 / 0.00 |
| DATA_TAMPERING | 0.481 | 0.507 | 3.30 / 0.00 / 0.00 |
| RELAY | 0.942 | 1.000 | 0.00 / 0.00 / 0.00 |
| PHASE_SLIP | 0.723 | 1.000 | 0.00 / 0.00 / 96.07 |
| INJECTION | 0.547 | 0.496 | 3.30 / 0.00 / 0.00 |
| REPLAY | 1.000 | 1.000 | 0.00 / 0.00 / 0.00 |
| DELAY | 0.528 | 1.000 | 0.00 / 0.00 / 95.47 |
| CO_CHANNEL_CAPTURE | 1.000 | 1.000 | 0.00 / 0.00 / 0.00 |
| JAM_BELOW_GATE_DEMO | 0.546 | 0.565 | 97.83 / 100.00 / 97.83 |
| JAM_AT_STEALTH_LIMIT | 0.774 | 0.977 | 56.23 / 63.93 / 86.17 |
| JAM_AT_MASK_LIMIT | 0.979 | 0.999 | 3.57 / 7.97 / 25.70 |

genuine: statistical 244, physical 3, both 2, of 18220
uplink COMMAND_TAMPERING: 0/100 executed
uplink COMMAND_INJECTION: 0/100 executed
uplink COMMAND_REPLAY: 0/100 executed

## Evaluation, iq receiver, seeds [1, 2]

chi-square sigmas (seed 1): doppler_shift_hz 6.0451, received_phase_error_deg 1.5934, rssi_dbm 0.3068, slant_range_km 0.4751

| traffic | n | data | statistical | physical | delivered | degraded | held | rejected | quarantined | rekey |
|---|---|---|---|---|---|---|---|---|---|---|
| NONE | 18220 | 0.00 | 1.31 | 0.03 | 98.68 | 0.00 | 1.30 | 0.02 | 0.01 | 0 |
| NONE_HOLDOVER | 12980 | 0.00 | 48.47 | 0.02 | 51.53 | 0.01 | 48.46 | 0.00 | 0.01 | 0 |
| FREQUENCY_HIJACKING | 3000 | 100.00 | 100.00 | 100.00 | 0.00 | 0.00 | 0.00 | 0.00 | 100.00 | 0 |
| STEALTH_SPOOFING | 3000 | 100.00 | 100.00 | 99.93 | 0.00 | 0.00 | 0.00 | 0.00 | 100.00 | 0 |
| NOISE_JAMMING | 3000 | 16.67 | 100.00 | 100.00 | 0.00 | 78.50 | 0.00 | 0.00 | 21.50 | 0 |
| DATA_TAMPERING | 3000 | 100.00 | 96.70 | 0.03 | 0.00 | 0.00 | 0.00 | 3.30 | 96.70 | 0 |
| RELAY | 3000 | 0.00 | 4.67 | 100.00 | 0.00 | 0.00 | 0.00 | 95.33 | 4.67 | 0 |
| PHASE_SLIP (held out) | 3000 | 0.00 | 3.97 | 100.00 | 0.00 | 0.00 | 0.00 | 96.03 | 3.97 | 0 |
| INJECTION | 3000 | 100.00 | 96.67 | 0.03 | 0.00 | 0.00 | 0.00 | 3.33 | 96.67 | 0 |
| REPLAY | 3000 | 100.00 | 100.00 | 100.00 | 0.00 | 0.00 | 0.00 | 0.00 | 100.00 | 0 |
| DELAY | 3000 | 0.00 | 4.73 | 100.00 | 0.00 | 0.00 | 0.00 | 95.27 | 4.73 | 0 |
| CO_CHANNEL_CAPTURE (held out) | 3000 | 100.00 | 100.00 | 100.00 | 0.00 | 0.00 | 0.00 | 0.00 | 100.00 | 0 |
| JAM_BELOW_GATE_DEMO | 3000 | 0.00 | 2.07 | 0.00 | 97.93 | 0.00 | 2.07 | 0.00 | 0.00 | 0 |
| JAM_AT_STEALTH_LIMIT | 3000 | 0.00 | 20.10 | 15.53 | 68.03 | 15.53 | 16.43 | 0.00 | 0.00 | 0 |
| JAM_AT_MASK_LIMIT | 3000 | 0.00 | 70.23 | 63.97 | 12.13 | 63.97 | 23.90 | 0.00 | 0.00 | 0 |

| traffic | AUC forest | AUC chi-square | unflagged without data / stat / phys |
|---|---|---|---|
| FREQUENCY_HIJACKING | 1.000 | 1.000 | 0.00 / 0.00 / 0.00 |
| STEALTH_SPOOFING | 0.998 | 1.000 | 0.00 / 0.00 / 0.00 |
| NOISE_JAMMING | 0.996 | 1.000 | 0.00 / 0.00 / 0.00 |
| DATA_TAMPERING | 0.472 | 0.512 | 3.30 / 0.00 / 0.00 |
| RELAY | 0.522 | 1.000 | 0.00 / 0.00 / 95.33 |
| PHASE_SLIP | 0.723 | 1.000 | 0.00 / 0.00 / 96.03 |
| INJECTION | 0.538 | 0.497 | 3.33 / 0.00 / 0.00 |
| REPLAY | 1.000 | 1.000 | 0.00 / 0.00 / 0.00 |
| DELAY | 0.520 | 1.000 | 0.00 / 0.00 / 95.27 |
| CO_CHANNEL_CAPTURE | 1.000 | 1.000 | 0.00 / 0.00 / 0.00 |
| JAM_BELOW_GATE_DEMO | 0.558 | 0.563 | 97.93 / 100.00 / 97.93 |
| JAM_AT_STEALTH_LIMIT | 0.870 | 0.931 | 68.03 / 84.47 / 79.90 |
| JAM_AT_MASK_LIMIT | 0.961 | 0.995 | 12.13 / 36.03 / 29.77 |

genuine: statistical 238, physical 5, both 2, of 18220
uplink COMMAND_TAMPERING: 0/100 executed
uplink COMMAND_INJECTION: 0/100 executed
uplink COMMAND_REPLAY: 0/100 executed

## Adaptive attacker, seed 1, iq receiver

capture_curve:
- 0.5 dB, 0 Hz, 0 us: physical 1.000, statistical 1.000, data 1.000, decoded 0.000
- 1 dB, 0 Hz, 0 us: physical 1.000, statistical 1.000, data 1.000, decoded 0.000
- 1.5 dB, 0 Hz, 0 us: physical 1.000, statistical 1.000, data 1.000, decoded 0.000
- 2 dB, 0 Hz, 0 us: physical 1.000, statistical 1.000, data 1.000, decoded 0.000
- 3 dB, 0 Hz, 0 us: physical 1.000, statistical 1.000, data 1.000, decoded 0.000
- 4 dB, 0 Hz, 0 us: physical 1.000, statistical 1.000, data 1.000, decoded 0.933
- 5 dB, 0 Hz, 0 us: physical 1.000, statistical 1.000, data 1.000, decoded 1.000
- 6 dB, 0 Hz, 0 us: physical 1.000, statistical 1.000, data 1.000, decoded 1.000
- 8 dB, 0 Hz, 0 us: physical 1.000, statistical 1.000, data 1.000, decoded 1.000

power_curve:
- 0 dB, 0 Hz, 0 us: physical 0.000, statistical 0.000, data 1.000, decoded 1.000
- 0.25 dB, 0 Hz, 0 us: physical 0.000, statistical 0.000, data 1.000, decoded 1.000
- 0.5 dB, 0 Hz, 0 us: physical 0.000, statistical 0.167, data 1.000, decoded 1.000
- 0.75 dB, 0 Hz, 0 us: physical 0.000, statistical 0.133, data 1.000, decoded 1.000
- 1 dB, 0 Hz, 0 us: physical 0.000, statistical 0.467, data 1.000, decoded 1.000
- 1.25 dB, 0 Hz, 0 us: physical 0.033, statistical 0.533, data 1.000, decoded 1.000
- 1.5 dB, 0 Hz, 0 us: physical 0.167, statistical 0.633, data 1.000, decoded 1.000
- 2 dB, 0 Hz, 0 us: physical 0.867, statistical 0.867, data 1.000, decoded 1.000
- 3 dB, 0 Hz, 0 us: physical 1.000, statistical 1.000, data 1.000, decoded 1.000

doppler_curve:
- 0 dB, 0 Hz, 0 us: physical 0.000, statistical 0.000, data 1.000, decoded 1.000
- 0 dB, 5 Hz, 0 us: physical 0.000, statistical 0.033, data 1.000, decoded 1.000
- 0 dB, 10 Hz, 0 us: physical 0.000, statistical 0.067, data 1.000, decoded 1.000
- 0 dB, 15 Hz, 0 us: physical 0.000, statistical 0.033, data 1.000, decoded 1.000
- 0 dB, 20 Hz, 0 us: physical 0.100, statistical 0.000, data 1.000, decoded 1.000
- 0 dB, 25 Hz, 0 us: physical 0.067, statistical 0.067, data 1.000, decoded 1.000
- 0 dB, 30 Hz, 0 us: physical 0.433, statistical 0.067, data 1.000, decoded 1.000
- 0 dB, 40 Hz, 0 us: physical 0.800, statistical 0.033, data 1.000, decoded 1.000
- 0 dB, 60 Hz, 0 us: physical 1.000, statistical 0.067, data 1.000, decoded 1.000

timing_curve:
- 0 dB, 0 Hz, 0 us: physical 0.000, statistical 0.000, data 1.000, decoded 1.000
- 0 dB, 0 Hz, 0.5 us: physical 0.000, statistical 0.000, data 1.000, decoded 1.000
- 0 dB, 0 Hz, 1 us: physical 0.000, statistical 0.000, data 1.000, decoded 1.000
- 0 dB, 0 Hz, 1.5 us: physical 0.000, statistical 0.067, data 1.000, decoded 1.000
- 0 dB, 0 Hz, 2 us: physical 0.000, statistical 0.000, data 1.000, decoded 1.000
- 0 dB, 0 Hz, 2.5 us: physical 0.000, statistical 0.033, data 1.000, decoded 1.000
- 0 dB, 0 Hz, 3 us: physical 0.067, statistical 0.000, data 1.000, decoded 1.000
- 0 dB, 0 Hz, 4 us: physical 0.000, statistical 0.033, data 1.000, decoded 1.000
- 0 dB, 0 Hz, 6 us: physical 0.133, statistical 0.033, data 1.000, decoded 1.000

under the gate, power_db: 0.2812 (RF tiers 0.033)
under the gate, doppler_hz: 15 (RF tiers 0.033)
under the gate, timing_us: 4.5 (RF tiers 0.033)
all three at once: RF tiers 0.167, data 1.000
