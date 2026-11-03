"""
dashboard_ui.py
TSYP 14 Track 1: Secure Ground-Link Testbed
Digital twin, phase 3: Streamlit mission control, the causal-chain inspector.

    streamlit run digital_twin/dashboard_ui.py

Pick a threat vector and a moment in the next pass over Zaghouan. The page walks the causal
chain: what the signal claims, what orbital physics and the ITU-R P.618 link budget say it
must be, the chi-square gap between them, whether its range and Doppler agree with each
other, and each layer's verdict. A full-pass sweep shows the chi-square against its
adaptive gate across the pass, with the threat active in the middle of it.
"""

from __future__ import annotations

import math
import os
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

if __package__ in (None, ""):  # run as a script by Streamlit
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pandas as pd
import streamlit as st

from digital_twin.api_gateway import AUDIT_ENV
from digital_twin.attack_injector import ATTACK_VECTORS
from digital_twin.audit_logger import AuditLogger
from digital_twin.ephemeris_loader import describe
from digital_twin.physics_validator import MasterTelemetryValidator

st.set_page_config(page_title="TSYP 14 Mission Control", layout="wide")


@st.cache_resource
def get_validator() -> MasterTelemetryValidator:
    return MasterTelemetryValidator(
        audit_logger=AuditLogger(os.environ.get(AUDIT_ENV, "security_audit.jsonl"))
    )


@st.cache_data(ttl=600)
def upcoming_pass(_validator: MasterTelemetryValidator, minute: int) -> dict:
    return _validator.next_pass(minute * 60.0)


def utc(t: float) -> str:
    return datetime.fromtimestamp(t, UTC).strftime("%Y-%m-%d %H:%M:%S UTC")


validator = get_validator()
st.title("TSYP 14: Secure Ground-Link Digital Twin")
st.markdown("### Physics-Enforced Communications Security (Causal Chain Inspection)")

pass_info = upcoming_pass(validator, int(time.time() // 60))
duration_min = pass_info["duration_s"] / 60.0

# Sidebar control
st.sidebar.header("Threat Injection Control")
attack_choice = st.sidebar.selectbox("Select Threat Vector", ATTACK_VECTORS)
minutes = st.sidebar.slider(
    "Minutes into the pass",
    0.0,
    round(duration_min, 2),
    round((pass_info["tca_unix"] - pass_info["aos_unix"]) / 60.0, 2),
    0.25,
)
st.sidebar.caption(
    f"Next pass over Zaghouan: rises {utc(pass_info['aos_unix'])}, "
    f"{duration_min:.1f} min, max elevation {pass_info['max_elevation_deg']:.1f} deg."
)
st.sidebar.caption(f"Orbit: {describe(validator.tle)}.")
run_tick = st.sidebar.button("Run Simulation Pass")
run_sweep = st.sidebar.button("Sweep the whole pass")

if run_tick:
    st.session_state["tick"] = validator.run_simulation_tick(
        pass_info["aos_unix"] + minutes * 60.0, attack_choice
    )

res = st.session_state.get("tick")
if res and res["link_available"]:
    phys = res["security_result"]
    kinematic = phys["kinematic_coupling"]

    # Causal chain, steps 1 and 2
    col1, col2, col3, col4 = st.columns(4)
    with col1:
        st.metric("Elevation Angle", f"{res['elevation_deg']:.2f}°")
        st.metric("Adaptive Threshold", f"{phys['adaptive_threshold']:.1f}")
    with col2:
        st.metric("Chi-Square Metric", f"{phys['chi_square_value']:.1f}")
        st.metric("Dominant residual", phys["dominant_residual"])
    with col3:
        z = f"{kinematic['z_score']:+.1f} sigma" if kinematic["available"] else "no reference"
        st.metric("Range-Doppler coupling", z)
        st.metric("Atmospheric loss (ITU-R P.618)", f"{res['atmospheric_loss_db']:.2f} dB")
    with col4:
        st.metric("Final decision", res["final_decision"])
        st.metric("CCSDS sequence", res["sequence_count"])

    if phys["physical_breach_detected"]:
        st.error(f"VERDICT: {phys['verdict']} - PACKET REJECTED")
    else:
        st.success(f"VERDICT: {phys['verdict']} - PACKET VERIFIED")

    st.markdown("### Claim vs. Reality Inspection (Cause & Effect)")
    sigma = phys["normalized_residuals"]
    claims = pd.DataFrame(
        {
            "Parameter": ["Slant range (km)", "Doppler (Hz)", "RSSI (dBm)", "Carrier phase (deg)"],
            "Signal claim (data)": [
                res["claimed_range_km"],
                res["claimed_doppler_hz"],
                res["claimed_rssi_dbm"],
                res["claimed_phase_error_deg"],
            ],
            "SGP4 physics (reality)": [
                res["expected_range_km"],
                res["expected_doppler_hz"],
                res["expected_rssi_dbm"],
                res["expected_phase_error_deg"],
            ],
            "Discrepancy (sigma)": [
                sigma["slant_range_km"],
                sigma["doppler_shift_hz"],
                sigma["rssi_dbm"],
                sigma["received_phase_error_deg"],
            ],
        }
    )
    if kinematic["available"]:
        claims.loc[len(claims)] = [
            f"Range change over {kinematic['interval_s']:.0f} s (km)",
            kinematic["range_change_km"],
            kinematic["doppler_range_change_km"],
            kinematic["z_score"],
        ]
        st.caption(
            "Last row: the range change claimed since the last trusted measurement against "
            "the change the measured Doppler implies (kinematic coupling, no orbit needed)."
        )
    st.dataframe(claims.round(3), hide_index=True)

    st.markdown("### Three independent layers")
    chi_square_verdict = "PHYSICS_VIOLATION" if phys["chi_square_breach"] else "PHYSICS_CONSISTENT"
    layers = pd.DataFrame(
        {
            "Layer": [
                res["crypto_result"]["layer"],
                res["ml_result"]["layer"],
                phys["layer"],
                "Physical Layer (Kinematic Coupling)",
            ],
            "Verdict": [
                res["crypto_result"]["verdict"],
                res["ml_result"]["verdict"],
                chi_square_verdict,
                kinematic["verdict"],
            ],
        }
    )
    st.dataframe(layers, hide_index=True)
    if res["reasons"]:
        st.caption("Why: " + "; ".join(res["reasons"]))
elif res:
    st.info("The satellite is below the 2° elevation mask at that moment: no link.")

if run_sweep:
    report = validator.run_pass(attack_choice, start=pass_info["aos_unix"])
    rows = [t for t in report["ticks"] if t["link_available"]]
    chart = pd.DataFrame(
        {
            "minutes into pass": [(t["timestamp"] - pass_info["aos_unix"]) / 60.0 for t in rows],
            "log10 chi-square": [
                math.log10(max(t["security_result"]["chi_square_value"], 1e-3)) for t in rows
            ],
            "log10 adaptive gate": [
                math.log10(t["security_result"]["adaptive_threshold"]) for t in rows
            ],
        }
    ).set_index("minutes into pass")
    st.markdown("### Full pass: chi-square against the adaptive gate")
    st.line_chart(chart)
    clean = f"clean ticks held {report['clean_held']:.0%}, rejected {report['clean_rejected']:.0%}."
    if report["attack_ticks"]:
        st.caption(
            f"Threat active from 30% to 70% of the pass. Stopped {report['attack_stopped']:.0%}"
            f" of attack ticks (crypto {report['crypto_flagged']:.0%}, physics "
            f"{report['physics_flagged']:.0%}, ML {report['ml_flagged']:.0%}); " + clean
        )
    else:
        st.caption("No threat injected: " + clean)

ok, message = validator.audit.verify_log()
(st.sidebar.success if ok else st.sidebar.error)(message)
