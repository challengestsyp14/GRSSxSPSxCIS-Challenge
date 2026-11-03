# Reproduce the report: make install, then make eval (every table and figure, with hashes).
PY ?= python3

.PHONY: install test lint eval eval-quick figures docker

install:
	$(PY) -m pip install -r requirements-lock.txt
	$(PY) -m pip install --no-deps -e .

test:
	$(PY) -m pytest

lint:
	ruff check groundlink testbed digital_twin tests
	ruff format --check groundlink testbed digital_twin tests

# Seeds 1 to 6 with both receivers, the adaptive attacker, the figures, results/tables.md and
# its SHA-256 against results/EXPECTED_SHA256.
eval:
	$(PY) -m digital_twin.reproduce

# Seeds 1 and 2 and a lighter attacker, against results/EXPECTED_SHA256_QUICK.
eval-quick:
	$(PY) -m digital_twin.reproduce --quick

figures:
	$(PY) -m digital_twin.figures --eval results/eval-model.json --attacker results/attacker.json
	$(PY) -m digital_twin.figures --eval results/eval-iq.json --out docs/figures/iq

docker:
	docker build -t ground-link-testbed .
	docker run --rm ground-link-testbed
