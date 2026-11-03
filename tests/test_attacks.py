import pytest

from groundlink.attacks import ATTACKS, CRYPTO_VISIBLE, Window, delay, jamming, relay, replay
from groundlink.security import Status
from tests.conftest import WINDOW


def test_empty_window_is_rejected():
    with pytest.raises(ValueError):
        Window(10.0, 10.0)


@pytest.mark.parametrize("name", sorted(ATTACKS))
def test_attacks_do_not_mutate_the_clean_pass(clean_pass, name):
    before = [(r.wire, r.arrival_s, r.label) for r in clean_pass]
    ATTACKS[name](clean_pass, WINDOW)
    assert [(r.wire, r.arrival_s, r.label) for r in clean_pass] == before


@pytest.mark.parametrize("name", sorted(ATTACKS))
def test_attacks_label_frames_and_keep_arrival_order(clean_pass, name):
    received = ATTACKS[name](clean_pass, WINDOW)
    arrivals = [r.arrival_s for r in received]

    assert any(r.label == name for r in received)
    assert arrivals == sorted(arrivals)


@pytest.mark.parametrize("name", sorted(CRYPTO_VISIBLE))
def test_content_attacks_are_rejected_by_cryptography(clean_pass, station, name):
    reports = station.process(ATTACKS[name](clean_pass, WINDOW))
    attacked = [r for r in reports if r.label == name]

    assert attacked
    assert all(r.status is not Status.OK for r in attacked)


@pytest.mark.parametrize("name", sorted(set(ATTACKS) - CRYPTO_VISIBLE))
def test_behaviour_attacks_pass_every_cryptographic_check(clean_pass, station, name):
    reports = station.process(ATTACKS[name](clean_pass, WINDOW))
    attacked = [r for r in reports if r.label == name]

    assert attacked
    assert all(r.status is Status.OK for r in attacked)


def test_replay_duplicates_recorded_frames(clean_pass):
    received = replay(clean_pass, WINDOW, recorded_from_s=0.0)
    replayed = [r for r in received if r.label == "replay"]
    originals = {r.wire for r in clean_pass}

    assert replayed and all(r.wire in originals for r in replayed)


def test_relay_forwards_frames_byte_for_byte(clean_pass):
    relayed = [r for r in relay(clean_pass, WINDOW) if r.label == "relay"]
    originals = {r.wire for r in clean_pass}

    assert relayed and all(r.wire in originals for r in relayed)


def test_delay_shifts_arrival_by_the_configured_amount(clean_pass):
    delayed = {r.wire: r for r in delay(clean_pass, WINDOW, delay_s=0.08) if r.label == "delay"}
    for original in clean_pass:
        if original.wire in delayed:
            assert delayed[original.wire].arrival_s == pytest.approx(original.arrival_s + 0.08)


def test_jamming_degrades_snr_and_drops_frames_below_threshold(clean_pass):
    received = jamming(clean_pass, WINDOW, jam_db=15.0, loss_below_snr_db=3.0)
    in_window = [r for r in clean_pass if WINDOW.contains(r.arrival_s)]
    jammed = [r for r in received if r.label == "jamming"]

    assert len(jammed) <= len(in_window)
    assert all(r.snr_db >= 3.0 for r in jammed)
