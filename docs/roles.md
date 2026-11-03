# Team roles

> Planning record from the start of the project (September 2026), kept as written. The
> design and the results as submitted are documented in deliverables 1 to 6 and in
> [evaluation-report.md](evaluation-report.md).

Five members, one role each. Every role owns code, a deliverable, and part of the Q&A.
The owner is accountable for the deliverable. That doesn't mean they write it alone.

| # | Role | Owns in the repo | Deliverable |
| --- | --- | --- | --- |
| 1 | **The Intake Clerk** | `data/`, the dataset loader | 6 (data) |
| 2 | **The Cryptographic Wax Seal** | `security.py`, `frames.py`, `audit.py` | 2 |
| 3 | **The Smart Security Guard** | `detector.py`, `station.py`, `channel.py` | 3, 4 |
| 4 | **The Inside Hacker / Tester** | `attacks.py`, `tests/`, evasion sweep | 5 |
| 5 | **The Project Manager & Director** | README, `docs/`, CI, anonymity, report | 1, 6 |

---

## 1 · The Intake Clerk

**The idea.** Space data arrives in messy raw files. You open them, clean up the clutter,
and turn them into neat tables the rest of the program can read.

**Your target.** Everything downstream consumes a list of `Reception` records
(`groundlink/simulate.py`). Today the simulator produces them. Your loader produces the
same records from the official datasets, and then nothing else needs to change.

**Your tasks.**
- [ ] Get the official reference datasets. **This blocks the whole team, so it comes first.**
- [ ] Log each one in `data/README.md`: source, version, licence, what it contains.
- [ ] Write `groundlink/ingest.py`: raw files → cleaned table → `Reception` records.
- [ ] Document every cleaning step (dropped rows, unit conversions, time alignment). Judges
      score reproducibility.
- [ ] Hand member 3 a clean pass to train on, and member 4 one to attack.

**Be ready to answer.** What was wrong with the raw data? What did you drop, and why? How
do you know the cleaning didn't remove real attacks?

---

## 2 · The Cryptographic Wax Seal

**The idea.** Every packet from space gets a tamper-proof seal. If anyone changes a single
digit mid-flight, the seal breaks and the station rejects the packet.

**The one thing to get exactly right.** The seal must use a **secret key**. A plain SHA-256
hash is *not* a seal against a man in the middle: the attacker changes the data and simply
recomputes the hash. Only a keyed seal stops that, because the attacker doesn't have the key.

| Seal | Attacker changes data and… | Result |
| --- | --- | --- |
| Plain SHA-256 | recomputes the hash | ❌ forgery **accepted** |
| HMAC-SHA256 (keyed) | can't compute the tag without the key | ✅ forgery rejected |
| **AES-256-GCM** (what we use) | can't compute the tag, and can't even read the data | ✅ rejected + data hidden |

This is proved in `tests/test_security.py::test_a_plain_hash_is_forgeable_but_the_keyed_seal_is_not`.
SHA-256 is still in the design: inside HMAC for the station's audit log (`audit.py`).

**What's already built.**
- `security.py`: AES-256-GCM seal on every frame, header protected too, anti-replay,
  freshness check.
- `audit.py`: HMAC-SHA256 hash chain over the station's log.
- 14 tests in `tests/test_security.py`.

**Your tasks.**
- [ ] Understand every line of `security.py`. You'll defend it live in Phase 2.
- [ ] **Nonce reuse on reboot.** The nonce comes from the sequence counter. If the
      spacecraft reboots and the counter restarts at 0 under the same key, nonces repeat,
      and with GCM that breaks both secrecy and authentication. Design the fix: a persisted
      counter, or a new key per boot.
- [ ] **Key rotation.** Add a key identifier to the frame header so the station knows which
      key sealed each frame, and keys can change without downtime.
- [ ] **Reordering.** Anti-replay currently demands strictly increasing sequence numbers.
      Real links can reorder frames. Implement a sliding replay window (as IPsec does) and test it.
- [ ] Own the overhead numbers in the report: 16 bytes/frame, microseconds per frame.

**Be ready to answer.** Why not just SHA-256? Why AES-GCM rather than HMAC alone? What
happens if the key leaks? What happens on reboot? Why can't cryptography catch the relay
attack? (The frames are genuine. That's member 3's layer.)

---

## 3 · The Smart Security Guard

**The idea.** An AI model (Isolation Forest) learns what normal satellite signals look like
over time. When something doesn't fit the pattern, it raises a red flag.

**What's already built.**
- `station.py`: turns each frame into six measurements compared against the orbit
  prediction (timing, power, Doppler, gaps).
- `detector.py`: Isolation Forest **plus** a per-measurement gate. The forest alone missed
  roughly three-quarters of delayed frames (65–83% across 10 training seeds): it can't score one far-out value higher than the most extreme
  normal one. The gate fixes that. See `docs/decisions.md`.
- Trained on clean traffic only, with the threshold calibrated for a 1% false-alarm target.

**Your tasks.**
- [ ] Retrain and recalibrate on member 1's real data. Expect scores to drop, and report
      that honestly.
- [ ] Compare against a second model family (e.g. One-Class SVM or an autoencoder) on
      ROC AUC.
- [ ] Measure how false alarms change with the threshold, and pick the operating point.
- [ ] Own deliverables 3 and 4 in the report.

**Be ready to answer.** Why train on clean data only? Why Isolation Forest? Why does it
need the gate? What's your false-alarm rate, and how do you know it holds on new data?

---

## 4 · The Inside Hacker / Tester

**The idea.** Play the bad guy. Attack our own system to prove member 3's detector catches
attacks without crying wolf.

**What's already built.**
- `attacks.py`: six attacks (tamper, inject, replay, relay, delay, jamming), each labelled.
- `tests/`: 59 automated tests.
- The standard scenario catches all six at full strength.

**Your tasks.** This is **20 points and currently the weakest area.**
- [ ] **Evasion sweep.** Turn each attack down step by step (shorter delay, better-disguised
      relay, weaker jammer) until the detector stops catching it. Plot detection rate against
      attack strength. The full plan is in `docs/5-adversarial-validation.md`.
- [ ] Build the strongest realistic attacker: a relay that minimises timing, power *and*
      Doppler signatures at once.
- [ ] Write the response policy: what the station does when each alarm fires.

**Be ready to answer.** Where does your detector stop working? Is that realistic for an
attacker to reach? What happens when both layers are silent?

---

## 5 · The Project Manager & Director

**The idea.** Keep everything organised in an anonymous repository, make it run on a judge's
laptop in a few commands, and produce the final report.

**What's already built.**
- Commit authorship neutral, no names in the repository.
- `README.md` quick start; CI runs tests and the full scenario on every push.
- One document per deliverable in `docs/`, plus roadmap and decision log.

**Your tasks.**
- [ ] Run the Monday / daily / Friday rhythm in `CONTRIBUTING.md`.
- [ ] Track the roadmap. **Phase 1 is due 8 November 2026.**
- [ ] Email the organisers to confirm Track 1 scope: satellite ↔ station data link, or
      navigation signals too (ghassen.ltaif@ieee.org).
- [ ] Before submission: move to a **neutrally named repository** (the current URL is
      identifying) and run the anonymity checklist in `docs/6-datasets-reproducibility.md`.
- [ ] Assemble the report, one section per deliverable, and own deliverable 1 with member 4.

**Be ready to answer.** How do the judges run it? How long does it take? What does it need
installed?
