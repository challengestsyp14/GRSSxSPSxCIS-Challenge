import numpy as np

from groundlink.channel import PassGeometry
from groundlink.security import Status
from groundlink.simulate import LinkConfig, simulate_pass

GEOMETRY = PassGeometry()


def test_range_is_shortest_overhead():
    t = np.linspace(0, GEOMETRY.duration_s, 601)
    assert np.argmin(GEOMETRY.range_km(t)) == 300
    assert GEOMETRY.range_km(GEOMETRY.closest_approach_s) == GEOMETRY.altitude_km


def test_doppler_crosses_zero_at_closest_approach_and_is_antisymmetric():
    tca = GEOMETRY.closest_approach_s
    assert abs(GEOMETRY.doppler_hz(tca)) < 1e-6
    assert GEOMETRY.doppler_hz(tca - 100) > 0 > GEOMETRY.doppler_hz(tca + 100)
    assert np.isclose(GEOMETRY.doppler_hz(tca - 100), -GEOMETRY.doppler_hz(tca + 100))


def test_received_power_peaks_overhead():
    assert GEOMETRY.rssi_dbm(GEOMETRY.closest_approach_s) == GEOMETRY.rssi_zenith_dbm
    assert GEOMETRY.rssi_dbm(0.0) < GEOMETRY.rssi_zenith_dbm


def test_pass_has_one_frame_per_tick(key):
    config = LinkConfig(frame_rate_hz=5.0)
    receptions = simulate_pass(key, config=config)
    assert len(receptions) == int(GEOMETRY.duration_s * config.frame_rate_hz)
    assert all(r.label == "clean" for r in receptions)


def test_simulation_is_reproducible_for_a_seed(key):
    a = simulate_pass(key, config=LinkConfig(seed=9))
    b = simulate_pass(key, config=LinkConfig(seed=9))
    assert [r.doppler_hz for r in a] == [r.doppler_hz for r in b]


def test_every_clean_frame_passes_the_station(clean_pass, station):
    assert all(report.status is Status.OK for report in station.process(clean_pass))
