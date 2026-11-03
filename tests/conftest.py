import os

import pytest

from groundlink.attacks import Window
from groundlink.detector import LinkAnomalyDetector
from groundlink.simulate import LinkConfig, simulate_pass
from groundlink.station import GroundStation, feature_matrix

WINDOW = Window(200.0, 260.0)


@pytest.fixture(scope="session")
def key() -> bytes:
    return os.urandom(32)


@pytest.fixture(scope="session")
def station(key) -> GroundStation:
    return GroundStation(key)


@pytest.fixture(scope="session")
def clean_pass(key):
    return simulate_pass(key, config=LinkConfig(seed=0))


@pytest.fixture(scope="session")
def detector(key, station) -> LinkAnomalyDetector:
    train = feature_matrix(station.process(simulate_pass(key, config=LinkConfig(seed=1))))
    calibration = feature_matrix(station.process(simulate_pass(key, config=LinkConfig(seed=2))))
    return LinkAnomalyDetector(target_pfa=0.01).fit(train, calibration)
