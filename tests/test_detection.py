import numpy as np
import pytest

from groundlink.attacks import ATTACKS, CRYPTO_VISIBLE, tamper
from groundlink.cli import run
from groundlink.detector import LinkAnomalyDetector
from groundlink.evaluate import roc_auc
from groundlink.simulate import LinkConfig, simulate_pass
from groundlink.station import FEATURE_NAMES, feature_matrix, labels
from tests.conftest import WINDOW


def test_detector_refuses_to_score_before_fitting():
    with pytest.raises(RuntimeError):
        LinkAnomalyDetector().score(np.zeros((1, len(FEATURE_NAMES))))


def test_target_pfa_must_be_a_probability():
    with pytest.raises(ValueError):
        LinkAnomalyDetector(target_pfa=0.0).fit(np.zeros((10, 6)), np.zeros((10, 6)))


def test_false_alarm_rate_holds_on_an_unseen_clean_pass(key, station, detector):
    unseen = feature_matrix(station.process(simulate_pass(key, config=LinkConfig(seed=77))))
    assert detector.alarms(unseen).mean() <= 0.03


@pytest.mark.parametrize("name", sorted(set(ATTACKS) - CRYPTO_VISIBLE))
def test_behaviour_attacks_are_caught_by_the_detector(clean_pass, station, detector, name):
    reports = station.process(ATTACKS[name](clean_pass, WINDOW))
    features, truth = feature_matrix(reports), labels(reports)

    assert detector.alarms(features)[truth == 1].mean() > 0.9


def test_a_pure_content_edit_is_invisible_to_the_detector(clean_pass, station, detector):
    reports = station.process(tamper(clean_pass, WINDOW))
    features, truth = feature_matrix(reports), labels(reports)

    # Tampering changes bytes, not physics: this is why the cryptographic layer exists.
    assert roc_auc(detector.score(features), truth) < 0.65


def test_delay_is_attributed_to_latency(clean_pass, station, detector):
    reports = station.process(ATTACKS["delay"](clean_pass, WINDOW))
    features, truth = feature_matrix(reports), labels(reports)
    row = features[np.flatnonzero(truth)[10]]

    assert detector.explain(row) == "latency_residual_ms"


def test_standard_scenario_catches_every_attack_with_both_layers_combined(key):
    result = run(attacks=list(ATTACKS), window=WINDOW, target_pfa=0.01, seed=0, key=key)

    for row in result["results"]:
        assert row["combined_pd"] > 0.95, row
        assert row["combined_pfa"] < 0.03, row
        assert row["expected_layer"] in row["caught_by"], row

    assert result["audit_log"]["chain_valid"]
    assert result["audit_log"]["edit_detected"]
