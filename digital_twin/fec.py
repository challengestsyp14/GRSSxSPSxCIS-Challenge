"""
fec.py
TSYP 14 Track 1: Secure Ground-Link Testbed
Digital twin: the forward error correction the downlink assumes, and the frames it loses.

The testbed assumes the CCSDS 131.0-B convolutional code: rate 1/2, constraint length 7
(generators 171 and 133 octal), soft-decision Viterbi decoding, QPSK, one 1115-byte
transfer frame (8,920 information bits) per packet. The SNR the station measures in its
6 MHz channel is taken as Es/N0 (one symbol per hertz), so each coded bit carries
Ec/N0 = Es/N0 / 2.

Above the decoding threshold the code corrects every error and the frame arrives bit-exact;
below it the decoder fails and the frame is lost, detected by the frame CRC. A frame is
therefore either delivered intact or not at all: noise never flips a bit the HMAC would see.
The frame error rate is the union bound on the first-event error probability of the code,
times the frame length:

    FER = min(1, N * sum_d a_d * Q(sqrt(2 d Ec/N0)))

with the code's distance spectrum a_d (d_free = 10). It falls from about 0.8 at 3 dB to
about 1e-3 at 5 dB of Es/N0: the link's 11.2 dB at the 2 deg mask is far above it, a jam
that takes 9.6 dB away is not.
"""

from __future__ import annotations

import math

#: First-event error weights a_d of the rate-1/2, K = 7 code, d = 10 to 18.
DISTANCE_SPECTRUM = {10: 11, 12: 38, 14: 193, 16: 1331, 18: 7275}
#: Information bits per packet: one 1115-byte CCSDS transfer frame.
FRAME_INFO_BITS = 1115 * 8


def q_function(x: float) -> float:
    """Tail probability of the standard normal law."""
    return 0.5 * math.erfc(x / math.sqrt(2.0))


def frame_error_rate(es_n0_db: float, info_bits: int = FRAME_INFO_BITS) -> float:
    """Probability the Viterbi decoder fails on a frame at Es/N0 = `es_n0_db` dB."""
    ec_n0 = 10.0 ** (es_n0_db / 10.0) / 2.0
    p_event = sum(a * q_function(math.sqrt(2.0 * d * ec_n0)) for d, a in DISTANCE_SPECTRUM.items())
    return min(1.0, info_bits * p_event)


def decoding_threshold_db(target_fer: float = 0.01) -> float:
    """Es/N0 at which the frame error rate falls to `target_fer`, by bisection."""
    low, high = -5.0, 15.0
    for _ in range(100):
        mid = 0.5 * (low + high)
        if frame_error_rate(mid) > target_fer:
            low = mid
        else:
            high = mid
    return 0.5 * (low + high)
