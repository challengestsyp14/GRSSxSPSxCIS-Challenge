# Roadmap to Phase 1

> Planning record from the start of the project (September 2026), kept as written. The
> design and the results as submitted are documented in deliverables 1 to 6 and in
> [evaluation-report.md](evaluation-report.md).

**Phase 1 deadline: Sunday 8 November 2026 — 51 days from 18 September.**
Preselection announced 10 November. Phase 2 final deadline 11 December 2026.

$$\text{Final Score} = 0.30 \times S_{\text{Phase 1}} + 0.70 \times S_{\text{Phase 2}}$$

Phase 1 is only 30% of the final score, but it is a gate: only 7 teams advance. Treat it as
pass/fail first and score-maximising second.

## Where we stand

| # | Deliverable | Points | Status | Doc |
| --- | --- | --- | --- | --- |
| 1 | Threat model & segment analysis | 15 | Drafted — six-attack catalogue | [1](1-threat-model.md) |
| 2 | Platform / architecture / trust anchor | 15 | Implemented — AES-GCM link + HMAC audit log | [2](2-architecture-trust-anchor.md) |
| 3 | Signal / image processing | 15 | Implemented — six orbit-residual features | [3](3-signal-processing.md) |
| 4 | AI or statistical detection | 20 | Implemented — hybrid Isolation Forest + robust gate | [4](4-detection.md) |
| 5 | Adversarial validation & response | 20 | **Standard scenario done; evasion sweep not started** | [5](5-adversarial-validation.md) |
| 6 | Documentation on official datasets | 5 (+10 feasibility) | **Blocked — datasets not obtained** | [6](6-datasets-reproducibility.md) |

Everything currently runs on synthetic satellite-to-station traffic. **Synthetic results are not submittable
results.** Deliverable 6 blocks 3, 4 and 5 from being reportable, which is why data
acquisition is the critical path.

## The 51 days

| Sprint | Dates | Theme | Exit criterion |
| --- | --- | --- | --- |
| **S0** | Fri 18 Sep – Sun 27 Sep | Foundations & data acquisition | Official datasets in hand and logged in `data/README.md` |
| **S1** | Mon 28 Sep – Sun 11 Oct | Real data end to end | Detector runs on replayed official data, not the generator |
| **S2** | Mon 12 Oct – Sun 25 Oct | Detection quality & adversarial validation | Evasion sweep produces a detectability floor per attack |
| **S3** | Mon 26 Oct – Fri 6 Nov | Report, reproducibility, anonymity | Anonymous report complete, clean clone reproduces every number |
| **Freeze** | Sat 7 Nov – Sun 8 Nov | Submit | Submission sent, no code changes |

Nothing lands in the freeze window that was not already working on 6 November.

## Roles

Five roles, one per member. Task lists and Q&A prep are in [roles.md](roles.md).

| Role | Owns | Deliverables | First task |
| --- | --- | --- | --- |
| **1 · Intake Clerk** | Datasets, loader producing `Reception` records | 6 | Obtain the official datasets |
| **2 · Cryptographic Wax Seal** | AES-GCM link security, audit log | 2 | Nonce-reuse-on-reboot design |
| **3 · Smart Security Guard** | Features and anomaly detector | 3, 4 | Second model family for comparison |
| **4 · Inside Hacker / Tester** | Attacks, tests, evasion sweep | 5 | Evasion sweep harness |
| **5 · Project Manager & Director** | Repo, docs, CI, anonymity, report | 1, 6 | Confirm track scope with organisers |

The Intake Clerk blocks everyone. If that role slips, the whole plan slips, so escalate on
day 1 of a slip, not at the sprint boundary.

## Sprint backlogs

### S0 — Foundations & data acquisition (18–27 Sep)

- Obtain the official reference datasets; log source, version and licence in `data/README.md`
- Write the replay adapter so official data arrives as `Reception` records (`groundlink/simulate.py`)
- Each owner reads `docs/START-HERE.md` and their own deliverable doc, and files one issue
  challenging something in it
- Fill the ownership table in `CONTRIBUTING.md`

### S1 — Real data end to end (28 Sep – 11 Oct)

- Replay adapter delivers official data through the existing interface
- Re-measure Pd / Pfa / latency / AUC on real data — expect the synthetic numbers to fall
- Ground the attack parameters in the dataset's own units instead of the current defaults
- Second detector family implemented and compared against the statistical baseline
- Dashboard replays a sealed record end to end

### S2 — Detection quality & adversarial validation (12–25 Oct)

- **Evasion sweep**: reduce attack strength until detection fails; report the floor per
  attack with a curve, not a single number
- Test the coordinated-transmitter case that defeats the spread-collapse signature
- Test the slow-onset case that stays inside the robust baseline's drift
- Document the response policy: what the system does when it alarms
- Measure and report latency, memory and security overhead

### S3 — Report, reproducibility, anonymity (26 Oct – 6 Nov)

- Write the anonymous report against the scoring rubric, section per deliverable
- Reproducibility pass: fresh clone, fresh environment, every reported number regenerated
  by a single documented command
- **Anonymity pass**: no names, unit names, logos, or identifying repository metadata;
  re-check commit authorship, README, report metadata and any screenshots
- Submit to a repository with a neutral name

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Datasets unavailable or late | Blocks 3 deliverables | Escalate to the organisers by 25 Sep; keep the synthetic path as a fallback and say so explicitly in the report |
| Detection collapses on real data | Deliverable 4 at risk | S1 exists precisely to find this early, with S2 as recovery room |
| Evasion sweep left to the end | 20 points lost | Sweep harness is an S1 task, not an S2 one |
| Anonymity slip | Disqualification risk | Dedicated S3 task plus a pre-submission checklist |

## Phase 2 (if we advance)

10 November to 11 December: a working prototype plus a 7-minute live or replayable attack
demonstration and 3 minutes of Q&A, in English, non-anonymous. `dashboard/` is that demo
surface — sealed record replay, live attack injection, detector firing, chain verification
failing on a tampered log. Rehearse the pitch at least three times against a clock.
