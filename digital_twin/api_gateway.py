"""
api_gateway.py
TSYP 14 Track 1: Secure Ground-Link Testbed
Digital twin, phase 3: the FastAPI service in front of the master validator.

    uvicorn digital_twin.api_gateway:app

GET  /health             liveness, the satellite flown and where its orbit came from
GET  /orbit              the element set flown: TLE lines, source (CelesTrak or fallback), age
GET  /attack-vectors     the red-team vectors the twin can inject into the downlink
GET  /uplink/threats     the red-team threats against uplink commands
GET  /pass/next          next pass over Zaghouan (rise, culmination, set, max elevation)
GET  /link/attenuation   ITU-R P.618 attenuation exceeded for p % of a year, by contribution
POST /simulate/tick      one tick of the ground link, all three layers and the decision
POST /simulate/pass      a whole pass with a threat window, per-layer detection rates
POST /uplink/command     seal a command, apply an uplink threat, verify it on board
GET  /audit/verify       re-walks the hash-chained audit log from its genesis root

The audit log path comes from GROUNDLINK_AUDIT_LOG (default security_audit.jsonl).
"""

from __future__ import annotations

import logging
import os
import threading
from functools import lru_cache

from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel, Field

from .attack_injector import ATTACK_VECTORS, UPLINK_THREATS
from .audit_logger import AuditLogger
from .ephemeris_loader import describe
from .physics_validator import MasterTelemetryValidator

logger = logging.getLogger("APIGateway")

AUDIT_ENV = "GROUNDLINK_AUDIT_LOG"

app = FastAPI(
    title="TSYP 14 Secure Ground-Link Digital Twin",
    version="1.0.0",
    description="Three-layer verification of TerraSAR-X's X-band downlink: crypto, ML, physics.",
)
_lock = threading.Lock()


@lru_cache(maxsize=1)
def get_validator() -> MasterTelemetryValidator:
    return MasterTelemetryValidator(
        audit_logger=AuditLogger(os.environ.get(AUDIT_ENV, "security_audit.jsonl"))
    )


class TickRequest(BaseModel):
    attack_vector: str = "NONE"
    timestamp: float | None = Field(
        None, description="Unix time; default is the culmination of the next pass"
    )


class PassRequest(BaseModel):
    attack_vector: str = "NONE"
    start: float | None = Field(None, description="Unix time to search from; default now")
    step_s: float = Field(10.0, gt=0.0, le=120.0)
    attack_start: float = Field(0.3, ge=0.0, le=1.0, description="Pass fraction")
    attack_end: float = Field(0.7, ge=0.0, le=1.0, description="Pass fraction")


class UplinkRequest(BaseModel):
    command: dict = Field(default_factory=lambda: {"opcode": "SET_MODE", "mode": "IMAGING"})
    threat: str = "NONE"


def _check_vector(vector: str) -> None:
    if vector not in ATTACK_VECTORS:
        raise HTTPException(
            400, f"unknown attack vector {vector!r}; expected one of {ATTACK_VECTORS}"
        )


@app.get("/health")
def health() -> dict:
    validator = get_validator()
    tle = validator.tle
    return {
        "status": "ok",
        "satellite": tle["sat_name"],
        "norad_id": tle["norad_id"],
        "orbit_source": tle.get("source", "given"),
        "tle_epoch": tle["epoch_utc"],
    }


@app.get("/orbit")
def orbit() -> dict:
    tle = get_validator().tle
    return {**tle, "summary": describe(tle)}


@app.get("/attack-vectors")
def attack_vectors() -> list[str]:
    return list(ATTACK_VECTORS)


@app.get("/uplink/threats")
def uplink_threats() -> list[str]:
    return list(UPLINK_THREATS)


@app.get("/pass/next")
def next_pass(start: float | None = None) -> dict:
    with _lock:
        return get_validator().next_pass(start)


@app.get("/link/attenuation")
def link_attenuation(
    elevation_deg: float = Query(..., ge=0.0, le=90.0),
    p: float = Query(50.0, ge=0.001, le=50.0, description="% of an average year"),
) -> dict:
    return get_validator().link_calc.atmospheric_attenuation(elevation_deg, p)


@app.post("/simulate/tick")
def simulate_tick(request: TickRequest) -> dict:
    _check_vector(request.attack_vector)
    with _lock:
        validator = get_validator()
        timestamp = request.timestamp
        if timestamp is None:
            timestamp = validator.next_pass()["tca_unix"]
        return validator.run_simulation_tick(timestamp, request.attack_vector)


@app.post("/simulate/pass")
def simulate_pass(request: PassRequest) -> dict:
    _check_vector(request.attack_vector)
    if request.attack_end < request.attack_start:
        raise HTTPException(400, "attack_end must not precede attack_start")
    with _lock:
        report = get_validator().run_pass(
            request.attack_vector,
            start=request.start,
            step_s=request.step_s,
            attack_window=(request.attack_start, request.attack_end),
        )
    report["ticks"] = [
        {
            key: tick.get(key)
            for key in ("utc", "elevation_deg", "red_team_vector", "final_decision")
        }
        for tick in report["ticks"]
    ]
    return report


@app.post("/uplink/command")
def uplink_command(request: UplinkRequest) -> dict:
    if request.threat not in UPLINK_THREATS:
        raise HTTPException(
            400, f"unknown uplink threat {request.threat!r}; expected one of {UPLINK_THREATS}"
        )
    with _lock:
        return get_validator().run_uplink_command(request.command, request.threat)


@app.get("/audit/verify")
def audit_verify() -> dict:
    with _lock:
        ok, message = get_validator().audit.verify_log()
    return {"intact": ok, "message": message}
