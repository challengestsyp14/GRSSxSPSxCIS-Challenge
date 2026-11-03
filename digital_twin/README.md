# Secure Ground-Link Digital Twin Testbed (TSYP 14)

An industrial-grade, pure software-defined digital twin architecture designed for secure satellite ground-link operations. This system implements a robust **Three-Tier Defense Architecture** to protect space-to-ground communications against advanced RF and protocol interference.

---

## 🛡️ Three-Tier Security Architecture

1. **Data Layer (Cryptographic Integrity)**
   - Utilizes **SHA-256 hashes** and **HMAC-SHA256 signatures** with constant-time equality validation (`hmac.compare_digest`) to protect uplink commands against tampering and injection.
2. **Statistical Layer (Anomaly Detection)**
   - Employs an unsupervised **Isolation Forest** model auto-bootstrapped on baseline RF metrics to detect subtle statistical outliers in telemetry streams.
3. **Physical Layer ($\chi^2$ Physics Engine)**
   - The core defense mechanism: A deterministic **Chi-Square ($\chi^2$) residual engine** that cross-examines incoming downlink telemetry against real-time SGP4 orbital propagation and ITU-R P.618 path loss models. Features **Elevation-Adaptive Covariance Scaling** to mitigate atmospheric horizon noise and **Kinematic Coupling Validation** to verify Range-Doppler consistency.

---

## 📂 Repository Structure

```text
├── ephemeris_loader.py           # CelesTrak TLE fetching & parsing
├── propagation.py                # SGP4 orbital propagation with J2/J4 harmonics
├── link_budget.py                # ITU-R path loss, slant range & Doppler calculations
├── visibility_calculator.py      # Topocentric coordinate transformation & horizon mask
├── ccsds_framing.py              # CCSDS space packet framing & CRC-16 validation
├── attack_injector.py            # Threat vector simulation (Delay Spoofing, Phase Slips, etc.)
├── crypto_hash_verifier.py       # SHA-256 & HMAC data integrity engine
├── isolation_forest_detector.py  # Unsupervised machine learning statistical detector
├── security_detector.py          # Chi-Square physical residual & kinematic validation engine
├── physics_validator.py          # Master simulation orchestration pipeline
├── audit_logger.py               # Immutable JSON Lines forensic event logging
├── api_gateway.py                # FastAPI backend REST gateway
├── dashboard_ui.py               # Streamlit Mission Control GUI (Causal Chain Inspector)
├── requirements.txt              # Python package dependencies
└── README.md                     # Project documentation
```
