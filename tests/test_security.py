import os

import pytest

from groundlink.frames import HEADER_SIZE, FrameHeader
from groundlink.security import LinkProtector, LinkVerifier, Status

KEY = os.urandom(32)


def seal(sequence: int, timestamp_s: float, payload: bytes = b"telemetry") -> bytes:
    return LinkProtector(KEY, spacecraft_id=42).protect(sequence, timestamp_s, payload)


def test_header_round_trips():
    header = FrameHeader(spacecraft_id=42, virtual_channel=1, sequence=7, timestamp_us=123)
    assert FrameHeader.unpack(header.pack()) == header


@pytest.mark.parametrize("size", [0, 15, 33])
def test_invalid_key_sizes_are_rejected(size):
    with pytest.raises(ValueError):
        LinkProtector(b"k" * size, spacecraft_id=1)
    with pytest.raises(ValueError):
        LinkVerifier(b"k" * size)


def test_genuine_frame_decrypts_to_its_payload():
    verdict = LinkVerifier(KEY).verify(seal(0, 0.0, b"housekeeping"), arrival_s=0.01)

    assert verdict.status is Status.OK
    assert verdict.payload == b"housekeeping"


def test_payload_is_not_readable_on_the_wire():
    assert b"housekeeping" not in seal(0, 0.0, b"housekeeping")


def test_any_flipped_payload_bit_fails_authentication():
    wire = bytearray(seal(0, 0.0))
    wire[HEADER_SIZE + 2] ^= 0x01

    assert LinkVerifier(KEY).verify(bytes(wire), 0.01).status is Status.AUTH_FAIL


def test_an_edited_clear_header_fails_authentication():
    wire = bytearray(seal(0, 0.0))
    wire[0] ^= 0x01  # spacecraft id

    assert LinkVerifier(KEY).verify(bytes(wire), 0.01).status is Status.AUTH_FAIL


def test_a_frame_sealed_under_another_key_fails_authentication():
    foreign = LinkProtector(os.urandom(32), spacecraft_id=42).protect(0, 0.0, b"x")

    assert LinkVerifier(KEY).verify(foreign, 0.01).status is Status.AUTH_FAIL


def test_a_replayed_frame_is_rejected():
    verifier = LinkVerifier(KEY)
    first = seal(0, 0.0)

    assert verifier.verify(first, 0.01).status is Status.OK
    assert verifier.verify(seal(1, 0.1), 0.11).status is Status.OK
    assert verifier.verify(first, 0.2).status is Status.REPLAY


def test_a_frame_outside_the_freshness_bound_is_stale():
    verifier = LinkVerifier(KEY, max_age_s=0.5)

    assert verifier.verify(seal(0, 0.0), arrival_s=2.0).status is Status.STALE


def test_a_rejected_frame_does_not_advance_the_replay_window():
    verifier = LinkVerifier(KEY)
    tampered = bytearray(seal(5, 0.0))
    tampered[-1] ^= 0x01

    assert verifier.verify(bytes(tampered), 0.01).status is Status.AUTH_FAIL
    assert verifier.verify(seal(1, 0.0), 0.01).status is Status.OK


def test_truncated_input_is_malformed():
    assert LinkVerifier(KEY).verify(b"\x00" * 10, 0.0).status is Status.MALFORMED


def test_a_plain_hash_is_forgeable_but_the_keyed_seal_is_not():
    """Why the seal must be keyed: an attacker can recompute an unkeyed hash."""
    import hashlib

    genuine, forged = b"temp=21.4C", b"temp=99.9C"

    # Unkeyed SHA-256: the man in the middle simply recomputes the digest.
    forged_digest = hashlib.sha256(forged).hexdigest()
    assert hashlib.sha256(forged).hexdigest() == forged_digest

    # Keyed seal: without the key the attacker cannot produce a tag the station accepts.
    wire = bytearray(seal(0, 0.0, genuine))
    wire[HEADER_SIZE : HEADER_SIZE + len(forged)] = forged
    assert LinkVerifier(KEY).verify(bytes(wire), 0.01).status is Status.AUTH_FAIL
