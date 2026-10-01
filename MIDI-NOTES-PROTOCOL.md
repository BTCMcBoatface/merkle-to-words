# M2M-NOTES Protocol — v0.1.0-DRAFT

**The pitched layer: deterministic merkle melodies, the shoehorn pitch map, and mapped MIDI export.**

| | |
|---|---|
| Protocol ID | `M2M-NOTES` |
| Version | `0.2.0-DRAFT` — not frozen; **Open Point 1 resolved** (fix), OP2–4 open |
| Depends on | `M2M-RHYTHM v1.0.1` (§2–§9 consumed verbatim: same root → same rhythm, always) |
| Fulfills | `MIDI-PROTOCOL.md` Appendix A reservation |
| Purpose | Assigns meaning to previously *reserved* bits (root 2–15, leaf 11–18), defines the shoehorn map format, and specifies `.mid` exports with pitches |
| Explicitly NOT covered | Player UI, live-mode rotation/polling (render/product layer in `PROJECT.md`), synth voices |

Governance identical to the rhythm protocol: this doc is the contract; implementations are peers;
derivation output change = MAJOR; editorial = PATCH; freeze bumps `0.x → 1.0.0`.

---

## 1. What changes vs. rhythm-only

Rhythm is untouched: leaf derivation (§4), loop length (root 0–1), durations (leaf 0–10),
placement + cyclic reuse + duty cycle (§7) — all consumed **verbatim** from M2M-RHYTHM.
This doc adds one thing: **a pitch for every onset event**. Everything else about a file's
timing/length/deltas is bit-for-bit what §3/§10 define.

Two pitch sources, one file format:

| Source | Determinism | Input |
|---|---|---|
| **MERKLE** (deterministic melody) | root alone | bits consumed per §2–§3 below |
| **SHOEHORN** (user pitch map) | root + user map | grid per §4; may be seeded from MERKLE (§5) |

---

## 2. Bit allocation (instruments the §9 reservations)

| Source | Bits | Field | Was (rhythm §9) | Now |
|---|---|---|---|---|
| root | 2 | octave range flag (0 = 1-octave/8-degree, 1 = 2-octave/15-degree) | reserved | **consumed** |
| root | 3–5 | mode index (0–7, table §3) | reserved | **consumed** |
| root | 6–10 | root note: `((R[0] & 0x03) << 3) \| (R[1] >> 5)` → 0–31, used `% 12` | reserved | **consumed** |
| root | 11–15 | base octave: `(R[1] & 0x1F) % 3 + 2` → {2,3,4} | reserved | **consumed** |
| root | 16–255 | — | unused | unused (descent only) |
| leaf[i] | 11–18 | melodic pitch byte, `PB` | reserved | **consumed** |
| leaf[i] | 19–255 | — | unused | unused |

> ✅ **OPEN POINT 1 — RESOLVED (Sep 30, owner ruling: fix; "young project, we want it right").**
> The reference previously computed the pitch byte as `((leaf[0] & 0x07) << 5) | (leaf[1] >> 3)`
> = global **bits 5–12**, overlapping the duration index (bits 0–10). This violated §9's
> clean reservation and silently correlated every block's melody with its own rhythm.
> `leaf_to_pitch_byte()` is now patched to the true disjoint extraction
> `PB = ((leaf[1] & 0x1F) << 3) | (leaf[2] >> 5)` = bits 11–18. Verified: PB invariant to
> bits 0–10, duration invariant to bits 11–18, rhythm identical between both Python
> scripts on all fixture roots. Pre-fix files in `notes-midi/` are stale (regeneration
> deferred, same queue as `midi-files/`).

---

## 3. MERKLE source — deterministic melody

Per event *i* (placement order, cyclic leaf reuse per rhythm §7.4 — note *i* reads
`leaf[i mod 32]` and therefore also that leaf's pitch byte):

```
PB        = bits 11–18 of leaf[i mod 32]        (disjoint — fixed, see §2)
degree    = PB mod scaleSize                    (scaleSize = 8 or 15, from root bit 2)
midi      = scale_degree_to_midi(degree, scale) (table below)
clamp     = 21 … 108                            (A0…C8; fold by ±12 while out of range)
```

Modes (index bits 3–5) — semitone intervals from the root:

| idx | mode | intervals |
|---|---|---|
| 0 | ionian | 0 2 4 5 7 9 11 |
| 1 | dorian | 0 2 3 5 7 9 10 |
| 2 | phrygian | 0 1 3 5 7 8 10 |
| 3 | lydian | 0 2 4 6 7 9 11 |
| 4 | mixolydian | 0 2 4 5 7 9 10 |
| 5 | aeolian | 0 2 3 5 7 8 10 |
| 6 | locrian | 0 1 3 5 6 8 10 |
| 7 | **chromatic** | 0 1 2 3 4 5 6 7 8 9 10 11 |

`scale_degree_to_midi(degree, scale)`:

```
root_midi = (base_octave + 1) * 12 + root_note_index
if chromatic:  midi = root_midi + intervals[degree % 12] + 12 * (degree // 12)
else:          midi = root_midi + intervals[degree % 7]  + 12 * (degree // 7)
```

(15-degree ranges cross one octave; degrees 7–14 land above. Frozen from the reference
script @ `5b59f81`; pitch extraction subsequently fixed to the disjoint bits per §2.)

## 4. SHOEHORN source — the pitch map

A user-owned mapping from **time to pitch**, independent of instruments and blocks:

- **Grid:** the 8-bar reference cycle (`cycleTicks = 15360`), quantized to **eighths**
  → **64 cells of 600 ticks**. (OPEN POINT 2: 16th resolution option = 128 cells /
  300 ticks — format-ready by changing `cellTicks` only.)
- **Cell value:** MIDI note 21–108, or empty.
- **Onset pitch:** event with master tick `t` (anchor=0 convention) reads cell
  `floor((t mod 15360) / cellTicks)`. Pitched at onset; sustained events do not
  re-pitch mid-note.
- **Empty cell fall-through** (OPEN POINT 3):
  1. MERKLE source available (event's block is known) → deterministic pitch from §3;
  2. else → the voice's default note (player seam already exists).
- **Per-slot transpose applies AFTER the map** (melodic slots only — percussion
  never pitched, per the standing ruling), then clamps to 21–108.
- Parts with loops shorter than 8 bars read the same global grid at their phase —
  a 2-bar part re-visits cells 0–15, 16–31, … each cycle; maps are authored against
  the cycle, not the part.

## 5. Composition: merkle-fill

`fillMap(block B)`: run B's rhythm events through §3 and write each event's pitch into
its §4 cell; cells with no event under B are left untouched (user paint preserved).
Fill is **replace-cells-that-are-written**, not clear-all. In live mode the player
auto-refills from the newest arriving block (player behavior — the *rule* lives here:
fill output must depend only on B's root + existing map).

## 6. Mapped `.mid` export

Container per rhythm §10 (format 1, single track, division 480, identical tempo/meta,
identical delta sequence — timing is byte-identical to the canonical drum file), with:

- `note_on`/`note_off` on **channel 0**, key = §3/§4 pitch (source-labeled), velocity 80;
- one `program_change` after tempo, program = export preset (OPEN POINT 4: fixed 0
  for v1 vs. GM-per-slot choice list — recommend fixed 0);
- filename: canonical rhythm files keep §10 names; mapped exports use
  `{height}_merkle_{prefix8}_notes.mid`, or `…_shoehorn_{mapid}.mid` where
  `mapid` = first 4 hex of SHA-256 over the map payload (§7) — provenance without
  the URL;
- **the canonical drum download (§10) is untouched** — mapped export is an explicit,
  separate action.

## 7. Session encoding

`&p=` = base64url of 64 bytes (one per eighth cell; 0 = empty, else MIDI note 1–255 →
values 21–108 in practice). Omitted when untouched. A map in a shared URL restores the
melody arrangement exactly — pitch is now part of a session's identity.

## 8. Verification pattern (planned)

Same as rhythm: `make-fixtures.py` gains a NOTES section (deterministic melodies over
the existing 6 roots; shoehorn grid cases incl. fall-through
and transpose stack), `tests/verify.mjs` asserts Python ≡ JS.

## 9. Freeze checklist (0.x → 1.0.0)

- [x] Open Point 1 decided — **fix (Option A), Sep 30 owner ruling**; doc pins disjoint bits 11–18
- [ ] Open Points 2–4 decided (resolution option, fall-through default, program)
- [x] `notes-from-merkle.py` patched to match and cross-checked (PB ⟂ duration proven; rhythm identical between scripts on all 6 fixture roots)
- [ ] Melodic fixtures + verify.mjs extension passing
- [ ] Player paint UI exists and round-trips through `&p=`

*Draft stance notes: everything marked OPEN is a real question, not an oversight.
The two design calls you already made that shaped this doc: shoehorn is
instrument-independent (one global map), and percussion never receives pitch.*

## Changelog

- `0.2.0-DRAFT` — Open Point 1 resolved (owner ruling: fix). §2 pins disjoint bits
  11–18; `leaf_to_pitch_byte()` patched and verified (PB ⟂ duration; rhythm identical
  to `midi-from-merkle.py` on all 6 fixture roots; e2e notes file conformance).
  Remaining: OP2–4 decisions, melodic fixtures, paint UI, then freeze to 1.0.0.
- `0.1.0-DRAFT` — Initial draft: shoehorn grid (64 eighths over the 8-bar cycle),
  fall-through order, merkle-fill composition, mapped `.mid` export format,
  `&p=` session encoding. Open Point 1 raised (pitch extraction overlapped duration bits).
