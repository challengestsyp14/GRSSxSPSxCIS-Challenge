from dataclasses import replace

import numpy as np
import pytest

from groundlink.audit import GENESIS, ObservationLog
from groundlink.evaluate import detection_latency, roc_auc

KEY = b"audit-test-key"


def build_log(n: int = 6) -> ObservationLog:
    log = ObservationLog(KEY)
    for i in range(n):
        log.append(float(i), {"status": "ok", "sequence": i})
    return log


def test_empty_key_is_rejected():
    with pytest.raises(ValueError):
        ObservationLog(b"")


def test_sealed_log_verifies_and_chains_from_genesis():
    log = build_log()
    assert log.records[0].prev_digest == GENESIS
    assert log.verify() == (True, "")


@pytest.mark.parametrize(
    ("forge", "expected"),
    [
        (lambda r: r[:2] + [replace(r[2], payload_digest="0" * 64)] + r[3:], "index 2"),
        (lambda r: [r[0], r[2], r[1]] + r[3:], "out of order"),
        (lambda r: [x for x in r if x.index != 3], "out of order"),
    ],
)
def test_edits_reorders_and_deletions_are_caught(forge, expected):
    log = build_log()
    ok, reason = log.verify(forge(list(log.records)))
    assert not ok
    assert expected in reason


def test_roc_auc_bounds():
    assert roc_auc(np.array([0.0, 1.0, 2.0, 3.0]), np.array([0, 0, 1, 1])) == 1.0
    assert roc_auc(np.ones(6), np.array([0, 1] * 3)) == 0.5
    assert np.isnan(roc_auc(np.arange(4.0), np.zeros(4, dtype=int)))


def test_detection_latency():
    labels = np.array([0, 0, 1, 1, 1])
    assert detection_latency(np.array([0, 0, 0, 1, 1]), labels) == 1.0
    assert detection_latency(np.zeros(5, dtype=int), labels) == float("inf")
