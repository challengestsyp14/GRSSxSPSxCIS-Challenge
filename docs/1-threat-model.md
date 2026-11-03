# 1 · Threat Model & Segment Analysis

> Phase 1 rubric: threat model & relevance, 15 points.

## Segment

The **ground link** of an Earth-observation mission: the X-band downlink (8477.8 MHz, QPSK,
CCSDS rate-1/2 convolutional code) that carries telemetry from **TerraSAR-X** (NORAD 31698,
≈514 km sun-synchronous) to the **Zaghouan ground station** in Tunisia (GS-ZAG), and the S-band
uplink (2050 MHz) that carries telecommands back. Under jamming, traffic falls back to a second
station, GS-MAT (Matera, Italy).

Every product downstream (imagery, its time stamps, its processing history) inherits what this
link delivers. A corrupted frame accepted here is trusted by everything after it, and the
pipeline keeps running: the *silent failure* the challenge describes.

| In scope | Out of scope |
| --- | --- |
| The RF path between satellite and station, both directions | The sensor and on-board processing |
| What the station decides about each frame and records | The analyst's own systems |
| The integrity of the orbit data the station predicts with | Key theft, insiders, a compromised spacecraft or station host |

## Assets

| Asset | Property to protect | Consequence of loss |
| --- | --- | --- |
| Telemetry frames in flight | Integrity, origin, freshness | False or stale data reaches the analyst as genuine |
| Frame order and sequence counts | No replay, no reordering | Old state presented as current |
| Link availability | Frames arrive at all | Silent gaps in the record |
| Telecommands | Only mission control's commands execute | The spacecraft obeys an attacker (e.g. DISABLE_TRANSMITTER) |
| The decision ledger | Tamper-evident history of every verdict | Provenance cannot be proven after the fact |
| The analyst's trust | Every delivered frame is genuine or flagged | A wrong decision made from data nobody flagged |

## Adversary

- **Capability:** a transmitter in radio view of GS-ZAG, built from commodity software-defined
  radio. It can receive, record, block, delay, relay, modify and transmit on the downlink and
  uplink channels, at a power and frequency of its choosing.
- **Knowledge:** the frame format, the public orbit (CelesTrak element sets), the link budget and
  our detector's design, gates included.
- **Does not have:** the HMAC key. Key compromise is out of scope; the re-key rule (deliverable
  2) still answers the evidence of one.
- **Goal:** make the station accept false or stale data, or lose data, without an alarm.

## Trust assumptions

- The key is provisioned securely before the pass and never crosses the air.
- The station host is not compromised.
- The CelesTrak element sets are correct. They reach the site through its own relay without an
  integrity check, so each set's SHA-256 and epoch age are written to the ledger and a set
  older than 3 days is flagged as stale. A stale orbit drifts the χ² prediction; the kinematic
  test of range against Doppler needs no orbit and still holds.

## Attack catalogue

| Attack | Goal | What the attacker does | Tier expected to catch it | Source in the code |
| --- | --- | --- | --- | --- |
| Stealth spoofing | Pass forged frames as the satellite's | A transmitter on the Doppler track, 3.2 dB low, forging tags and reusing counts from node 0x99A2 | Data; physical (14σ in power) | `dashboard/src/sim/signals.ts` (spoof) |
| Co-channel capture | Take over the receiver on its own channel | A transmitter 6 dB louder, 4 kHz off the Doppler track, forging SAFE_HOLD telemetry | Data; physical; statistical (EVM) | `digital_twin/evaluate.py` |
| Frequency hijacking (sanity check) | Capture a receiver that re-tunes to a rogue carrier | A louder carrier 14.2 MHz above the channel | Physical (no orbit makes that Doppler); data | `signals.ts` (hijack) |
| Noise jamming | Deny the link | Broadband noise, J/N +9.1 dB | Physical (power); statistical; the decoder | `signals.ts` (jam) |
| Below-the-gate jamming | Degrade the link without an alarm | Noise at J/N −12.8, −5.3 or −3.1 dB | Bounded by the χ² budget (deliverable 5) | `evaluate.py` (EVASION) |
| Data tampering | Alter telemetry content | A relay flips one payload bit after the satellite sealed the frame | Data (HMAC) | `dashboard/src/sim/engine.ts` (tamper) |
| Sequence injection | Make the analyst see SAFE_HOLD | A forged CCSDS packet, CRC and SHA-256 recomputed, RF shaped like the satellite | Data (HMAC) | `attack_injector.py` CCSDS_SEQUENCE_HIJACK |
| Replay | Re-inject genuine frames recorded earlier | A recorder and a transmitter, frames 1 to 3 minutes old | Data (stale count); physical (stale Doppler) | `groundlink/attacks.py` (replay) |
| Relay (meaconing) | Forward genuine frames over its own path | A repeater adding 72.5 km of path and 3 dB | Physical (range, range–Doppler); statistical | `attack_injector.py` DELAY_SPOOFING_MEACONING |
| Delay | Release genuine frames late | Store and forward, 80 ms | Physical (timing) | `groundlink/attacks.py` (delay) |
| Coherent phase slip | Walk the receiver's phase loop off the carrier | A carrier-locked transmitter slipping 47° and pulling 18 Hz | Physical (phase) | `attack_injector.py` COHERENT_PHASE_SLIP |
| Uplink tampering, injection, replay | Make the spacecraft execute a hostile command | An uplink transmitter; a recorder for replay | On-board data check: tag, then sequence count | `attack_injector.py`, `engine.ts` |
| Adaptive attacker | Stay under every gate | Tunes power, Doppler and timing against a white-box copy of the station | All three tiers; the data tier always | `digital_twin/adaptive_attacker.py` |

## The central finding

Relay, delay, phase slip and jamming deliver **genuine, untouched frames**: every cryptographic
check passes while the attacker controls the path. Tampering and injection leave **no RF
trace**: the physics sees nothing. So no single tier can be enough (the ablation in deliverable
5 measures it), and the design has three that read different evidence:

1. **Data tier**: is the content genuine and fresh? (HMAC-SHA256, SHA-256 digest, hardware token,
   anti-replay window.)
2. **Physical tier**: did the frame arrive the way the orbit says it must? (χ² against SGP4 and
   the ITU-R P.618 link budget, and the range–Doppler kinematic test.)
3. **Statistical tier**: does the link behave like a clean pass in what the χ² does not test?
   (EVM, frame loss, arrival jitter, MAC failure rate, sudden changes.)

## Residual risk

| Risk | Why it survives | Bound or answer |
| --- | --- | --- |
| A jammer under the stealth budget | It costs less SNR than the χ² gate's width | Bounded: at most 1.12 dB of SNR overhead, 1.74 dB at the 2° mask; every frame still authenticates |
| An attacker alone on the channel, tuned to the orbit | It can hide small offsets in one dimension | +0.42 dB, 15.9 Hz or 2.7 µs flag on at most 5 % of its frames; the data tier rejects 100 % of them |
| Genuine frames just after an attack | The forest's failure-rate features remember the attack for 10 frames | Held for review (48.6 %), never rejected; reported apart from the false-alarm rate |
| A stale or wrong element set | The χ² prediction drifts | Flagged after 3 days; the kinematic test needs no orbit |
| Key theft | Forged frames pass the data tier | Out of scope; a valid tag on a foreign token or on new content under a stale count triggers a re-key, and the physical tier still sees a ground transmitter's geometry |
