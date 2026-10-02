# M2M-MIDI Protocol — v1.0.2

**A normative specification for deriving a rhythmic MIDI pattern from a Bitcoin merkle root.**

| | |
|---|---|
| Protocol ID | `M2M-RHYTHM` |
| Version | `1.0.2` |
| Status | Frozen (`1.0.x` is backwards-compatible forever) |
| Derived from | `midi-from-merkle.py` in `btcmcboatface/merkle-to-words` (commit `5b59f81`) |
| Reference status | `midi-from-merkle.py` **conforms** — §7.4 patch applied post-`5b59f81`; archived `.mid` files predate the patch. `notes-from-merkle.py` uses the same patched rhythm engine (see Appendix A) |
| Intended consumers | Python reference tools; the JavaScript player in `docs/` (live) |
| Scope | Drum-rhythm pipeline **only**. Pitched output is reserved for `M2M-NOTES` (Appendix A). |

---

## 1. Purpose and governance

This document is **the contract**. Python and JavaScript implementations are peers that both
conform to it; neither implementation is authoritative over the other.

- A discrepancy between an implementation and this document is an **implementation bug**.
- A discrepancy between two implementations where this document is silent is a **spec gap**:
  resolve it by amending this document, never by silently picking a side.
- Historical reference divergences, resolved normatively by §7.4 (both were
  implementation bugs; **the Python has been patched and now conforms**):
  1. `midi-from-merkle.py` at `5b59f81` **stopped when its 32 leaves ran out**, leaving
     most 8-bar loops short of the target (§7.4). Fixed by cyclic leaf reuse.
  2. When the selected durations hit `targetTicks` **exactly before the leaves ended**,
     it appended a spurious **zero-length note** (it entered the truncation branch with
     `remaining = 0`). Fixed by terminating immediately at `remaining = 0`.
- Versioning (`MAJOR.MINOR.PATCH`):
  - **PATCH** — editorial clarification only; derived output is identical in every case.
  - **MINOR** — new optional fields or modes; existing derivations unchanged.
  - **MAJOR** — any change to the output of a valid input. A pattern derived under
    `1.x` must remain derivable, and identical in its event stream, forever under `1.x`.
- Because GitHub Pages content may be cached for years, every derivation should be
  taggable with its version string. `1.0.0` roots stay playable by `1.x` players.

Key words **MUST**, **SHOULD**, **MAY** are used in the normative sense.

### Conformance levels

| Level | Requirement |
|---|---|
| **Derivation-conformant** | Implements §2–§9; for any root `R`, produces the identical ordered event stream `E(R)` (§3). |
| **Full-conformant** | Derivation-conformant **and** emits an SMF file (§10) whose decoded event stream equals `E(R)`. |

A web synthesizer that renders directly from `E(R)` without ever serializing a file only
needs derivation conformance.

---

## 2. Input

```
R : 32 raw bytes — the merkle root
```

Canonical external form is **64 lowercase hex characters**. A conformant decoder:

1. Applies `trim` and `lowercase` to user-supplied input. **MAY** accept an `0x` prefix.
2. **MUST** reject any input that is not exactly 32 bytes after decoding.
3. **MUST NOT** normalize endianness. Root bytes appear in API/display order
   (Blockstream's `merkle_root` string); byte 0 is the first byte of that string and
   **bit 0 is the most-significant bit of byte 0**. No endianness conversion is ever
   applied — the string as served is taken literally.

Source of `R`: `GET https://blockstream.info/api/blocks/tip` → JSON `merkle_root`
(the response also exposes `id` and `height`; **neither is used in derivation**). The API
is not part of the protocol: any source of a valid 32-byte root is equally conformant.
Offline roots, manually typed roots, and historical roots are first-class inputs.

---

## 3. Canonical event stream E(R)

The protocol output is a **stream of MIDI events**, not a file. Every conformant
implementation must produce the identical stream for identical `R`. Two implementations
are in sync when their `E(R)` streams are equal field-for-field, in order.

```
E(R) = [
  SetTempo(usPerQuarter),
  for each note N in NoteStream(R):          # N defined in §7
    NoteOn(channel, key, velocity)           # delta 0 from the previous event
    NoteOff(channel, key, 0)                 # delta N.soundingTicks
    NoteOff(channel, key, 0)                 # delta N.gapTicks   (omitted iff gapTicks == 0)
]
```

Constants: tempo §5/§6, channel/key/velocity §5, per-note tick values §7.3–§7.4.

**Loop guarantee (normative):** `Σ N.durationTicks = targetTicks` exactly, for every root
(§7.4). Pattern duration is always exactly 1, 2, 4, or 8 bars. No zero-length notes are
ever emitted (§7.4).

---

## 4. Leaf derivation — `deriveLeaves(R, D)`

Binary tree descent with domain-separated SHA-256, fixed depth **D = 5** → **L = 32 leaves**:

```
node₀        = R
left(node)   = SHA-256(node ‖ 0x00)
right(node)  = SHA-256(node ‖ 0x01)
```

Recurse D levels; collect leaves in **left-to-right depth-first** order (left subtree
fully before right subtree). Level 0 has 1 node, level 5 has 32.

| Rule | Specification |
|---|---|
| Tag bytes | Single byte: `0x00` = left, `0x01` = right. No length prefix, no other values. |
| Leaf identity | `leaf[i]` = the 32-byte hash at position *i* in the ordered sequence, `0 ≤ i < 32`. |
| Non-consumption | Nodes are **never** truncated or reinterpreted as integers. |
| Full recovery | Leaves **MUST** be recomputed from `R`. Nothing beyond `R` is needed; there is no state file. |
| Reuse | Wrapped placement (§7.4) re-reads `leaf[i mod 32]` — identical bytes, identical duration. |

Exactly 32 leaves are derived for **every** root, regardless of loop length.

---

## 5. Fixed structural constants

These are **not** merkle-derived. Changing any of them is a MAJOR-version event.

| Constant | Value | Notes |
|---|---|---|
| `usPerQuarter` | 500000 | = 120.0 BPM exactly |
| `PPQ` | 480 | ticks per quarter note |
| `barTicks` | 1920 | 4 beats × 480, 4/4, implicit time signature |
| `channel` | 9 | GM percussion (called "channel 10" in 1-indexed GM prose) |
| `key` | 35 | GM Acoustic Bass Drum |
| `velocity` | 80 | note-on velocity; every note-off velocity is 0 |
| `polyphony` | monophonic | a second `NoteOn` never occurs before the previous note's final `NoteOff` |
| `D` (depth) | 5 | → 32 leaves |
| `L` (leaves) | 32 | |
| `durationBits` | 11 | per leaf |
| `dutyCycle` | 0.8 | §7.3 |

---

## 6. Loop length — root bits 0–1

`k = R[0] >>> 6` (the two most-significant bits of the first byte).

| k (binary) | bars | beats | targetTicks |
|---|---|---|---|
| `00` | 1 | 4 | 1920 |
| `01` | 2 | 8 | 3840 |
| `10` | 4 | 16 | 7680 |
| `11` | 8 | 32 | 15360 |

```
bars        = 2^k
targetTicks = bars × 1920
```

**Bit discipline:** root bits 0–1 are consumed *only* for loop length, and are **not**
excluded from tree descent (the full 32-byte root feeds `deriveLeaves`). Loop length is a
structural parameter taken from the root directly, never from a leaf.

---

## 7. Rhythm

### 7.1 Duration index — leaf bits 0–10

For leaf `F` (32 bytes):

```
durationIndex = (F[0] << 3) | (F[1] >>> 5)      # 0 … 2047
```

`F[0]` supplies bits 0–7; the top 3 bits of `F[1]` supply bits 8–10.

### 7.2 Weighted duration table

Ranges are **inclusive**; the table is exhaustive (0–2047 fully covered, no overlap).

| durationName | ticks | indexMin | indexMax | width | probability |
|---|---|---|---|---|---|
| sixteenth | 120 | 0 | 447 | 448 | 21.875% |
| eighth | 240 | 448 | 815 | 368 | 18.0% |
| dotted eighth | 360 | 816 | 1103 | 288 | 14.0625% |
| quarter | 480 | 1104 | 1351 | 248 | 12.109375% |
| eighth triplet | 320 | 1352 | 1559 | 208 | 10.15625% |
| dotted quarter | 720 | 1560 | 1727 | 168 | 8.203125% |
| half | 960 | 1728 | 1895 | 168 | 8.203125% |
| dotted half | 1440 | 1896 | 2047 | 152 | 7.421875% |

**Table invariants (normative):** every index maps to exactly one row; all `ticks` are
multiples of 40; every row satisfies `0 < ticks ≤ targetTicks` for the smallest loop.
`noteTicks` is **looked up from this table, never computed** — e.g. eighth triplet is
`320`, which only coincides with `480·⅔`-style arithmetic by luck at PPQ 480. The table
is the source of truth.

### 7.3 Note placement and duty cycle

Notes are placed **strictly sequentially** from `leaf[0]`. The position of note *i* is
determined solely by the durations of notes 0…i−1:

```
remaining = targetTicks − accumulatedTicks

if noteTicks ≤ remaining:   durationTicks = noteTicks     truncated = false
else:                       durationTicks = remaining       truncated = true    # terminates the sequence

soundingTicks = floor(durationTicks × 0.8)
gapTicks      = durationTicks − soundingTicks
```

`floor` is integer truncation toward zero (inputs are always positive). Work in **integer
ticks only** — never floating beats or seconds (§8).

Duty-cycle values at PPQ 480 (all table durations are multiples of 40, so `0.8 × d` is an
exact integer for every reachable `d`; the floor never actually discards anything in v1):

| durationTicks | sounding | gap |
|---|---|---|
| 120 | 96 | 24 |
| 240 | 192 | 48 |
| 320 | 256 | 64 |
| 360 | 288 | 72 |
| 480 | 384 | 96 |
| 720 | 576 | 144 |
| 960 | 768 | 192 |
| 1440 | 1152 | 288 |

`gapTicks > 0` for every note of every v1 pattern (truncated durations remain multiples
of 40 — see §8 A4).

### 7.4 Termination, truncation, and cyclic leaf reuse

Generation walks the **infinite periodic sequence** `noteTicks_i = duration(leaf[i mod 32])`,
`i = 0, 1, 2, …`, applying §7.3 to each note:

1. **Truncation rule.** The first note whose `noteTicks > remaining` is shortened to
   `durationTicks = remaining`, marked `truncated`, and **terminates the sequence**. Its
   `durationName` remains the one selected by its index — only the tick count shrinks.
2. **Exact rule.** If a note lands with `remaining = 0` (`noteTicks == remaining`), it is
   placed un-truncated and the sequence terminates.
3. **Loop guarantee.** One of rules 1 or 2 always fires before `i` can grow without
   bound: `accumulatedTicks` strictly increases by at least 120 per note while
   `remaining > 0`. Hence `Σ durationTicks = targetTicks` for **every** root.
4. **No zero-length notes.** The sequence stops the instant `remaining = 0`; a note is
   never appended with `durationTicks = 0`.
5. **Reuse is rare but real.** For 8-bar loops the mean 32-leaf sum (~14.6k ticks)
   falls below 15360, so wrapped reuse of leaves 0, 1, … occurs for **~62% of roots**
   (measured). For 1- and 2-bar loops exhaustion is impossible (minimum Σ = 32 × 120 =
   3840 covers the 1920/3840 targets); for 4-bar it is theoretically possible but practically negligible
   (requires nearly every leaf short; 0/200 sampled roots, z ≈ −3.3). `noteCount ≤ 32`
   holds except when reuse has begun; hard cap is `targetTicks ÷ 120` = 128.

> **Reference divergence — resolved.** `midi-from-merkle.py` at `5b59f81` differed from
> this protocol in two places, both verified empirically against the committed archive:
> 1. It walked `leaf[0…31]` once and **stopped on exhaustion** — 8-bar loops ended short
>    for ~62% of roots (e.g. `953321_merkle_cdbf2ee9.mid`: 12,480 of 15,360 ticks).
> 2. When durations landed on the target **exactly** with leaves remaining, it appended a
>    spurious **zero-length note** (seen in `955877_merkle_7be11c59.mid`'s trailing
>    `on/off` pair at delta 0).
>
> `fill_rhythm_to_target()` has since been patched: notes place from `leaf[i mod 32]`
> until rule 1 or 2 fires, with an immediate clean stop at `remaining = 0`. Verified:
> `Σ durationTicks == targetTicks` and zero-length-free across 240 synthetic roots
> (60 per loop length), output unchanged for every root the old code already filled,
> and one 8-bar wrapped root verified end-to-end as a full-conformant SMF (§10).
> Archived `.mid` files predating the patch remain non-conformant until regenerated.

### 7.5 Worked example (traversal sketch)

Root with `k = 10`: `bars = 4`, `targetTicks = 7680`. For each `i = 0, 1, 2, …`:
compute `durationIndex` from `leaf[i mod 32]` (§7.1), look up `noteTicks` (§7.2), apply
§7.3, until remaining = 0. Expected note counts: 1-bar 4–7, 2-bar 7–10, 4-bar 12–23
(all observed in the committed archive); 8-bar 29–~45 (upper range only under §7.4
reuse; the archive's conforming cases end 29–32). (A golden-fixture set is a planned
amendment, not part of v1.0.0 normative text.)

---

## 8. Integer semantics (binding on all languages)

| # | Rule | JS note |
|---|---|---|
| A1 | All timing arithmetic is in **integer ticks**. Beat/second values are display-only. | Do not accumulate in `Number` fractions. |
| A2 | All shifts operate on **byte values 0–255**, unsigned, MSB-first bit numbering. | `F[1] >>> 5` is exact via `Uint8Array` (values < 2³¹). |
| A3 | `(F[0] << 3) \| (F[1] >>> 5)` fits in 11 bits. | JS signed 32-bit `<<` is safe: max result 2047. |
| A4 | `soundingTicks = floor(durationTicks × 0.8)`, multiply-then-floor. Every reachable `durationTicks` is a multiple of 40 (targets and all table durations are), so `0.8·d` is exact and the floor is a no-op — the **floor form is still normative** for forward compatibility. | Equivalent exact integer forms: `d - d/5`, or `(d*4 - (d*4) % 5) / 5`. Floating `Math.floor(d*0.8)` is exact at these magnitudes (< 2⁵³). |
| A5 | Seconds conversion, if needed at all: `seconds = ticks ÷ PPQ × usPerQuarter ÷ 10⁶`, i.e. exactly `ticks ÷ 960` at the v1 constants. | The only legitimate use of real numbers: playback scheduling. |
| A6 | `bars = 2^k`, `k ∈ {0,1,2,3}` — exact. | `1 << k`. |
| A7 | Hex decode: two chars per byte, high nibble first, case-insensitive. | `parseInt(pair, 16)` per byte is conformant. |

---

## 9. Bitfield allocation map (v1.0.0)

Every bit of the root and of each leaf has an explicit status. An implementation **MUST
NOT** derive any output from a bit marked *unused* or *reserved*.

| Source | Bits | Field | Status |
|---|---|---|---|
| root | 0–1 | loop length `k` | **consumed** |
| root | 2–18 | — | **reserved** for `M2M-NOTES` scale parameters (Appendix A); **unused** in rhythm v1 |
| root | 19–255 | — | unused (participate in descent hashing only) |
| leaf[i] | 0–10 | `durationIndex` | **consumed** |
| leaf[i] | 11–18 | — | **reserved** for `M2M-NOTES` degree mapping (Appendix A); **unused** in rhythm v1 |
| leaf[i] | 19–255 | — | unused (informational only) |

Root bits 0–1 also participate in the descent hash — consumption does not mean exclusion.
Future versions **MUST NOT** reassign bits already marked consumed, and **SHOULD NOT**
assign new meaning to reserved bits without a MAJOR bump.

---

## 10. Standard MIDI File mapping

Required only by **full-conformant** implementations (anyone serializing `.mid`). The
byte-level description below is what `mido` writes today; a JS implementation must be
**event-equivalent** (§1 conformance) and **MAY** choose a simpler container as long as
the decoded `E(R)` matches.

**Container:**

| Field | Value |
|---|---|
| Header | `MThd`, length 6, **format 1** (mido's default — reference files are type 1 with a single track), **1 track**, division **480** (ticks/quarter; bit 15 clear, not SMPTE) |
| Track | `MTrk`, length = track-chunk byte count |
| Event order | `set_tempo` first (delta 0), then note events per §3, then EOT |
| EOT | delta **0**, `FF 2F 00` (verified across the committed archive) |
| Written meta events | tempo `FF 51 03 07 A1 20` only. Time-signature meta (`FF 58`) is **not** written; players infer 4/4. |

**Events (channel messages use running status optionally; every delta is a VLQ):**

| Event | Bytes (no running status) | Meaning |
|---|---|---|
| Note on | `99 23 50` | channel 9, key 35, velocity 80 |
| Note off | `89 23 00` | channel 9, key 35, velocity 0 |

Per note with `d = durationTicks`, `s = floor(0.8d)`, `g = d − s` (`g > 0` always in v1):

```
delta 0     → 99 23 50          # note on
delta s     → 89 23 00          # note off after sounding
delta g     → 89 23 00          # trailing note-off holding the gap (the §3 third event)
```

**Delta bounds:** the largest single delta is `1152` (dotted-half `s`) — verified across
the archive. All deltas therefore encode in **1–2 VLQ bytes**. VLQ: 7 bits per byte,
MSB set on all but the last, big-endian. Reference encodings:
`24 → 18`, `48 → 30`, `64 → 40`, `72 → 48`, `96 → 60`, `144 → 81 10`, `192 → 81 40`,
`256 → 82 00`, `288 → 82 20`, `384 → 83 00`, `576 → 84 40`, `768 → 86 00`,
`1152 → 89 00`.

**Example fragment** — one quarter note (`d=480, s=384, g=96`):

```
00 99 23 50  83 00 89 23 00  60 89 23 00
```

**File naming (convention, non-normative):**
`{height}_merkle_{first 8 hex chars of root}.mid`, or `merkle_{prefix}.mid` when height is
unknown. The root prefix alone identifies the derivation; height is provenance only.

---

## 11. Scope exclusions (v1.0.0)

The protocol deliberately does **not** define: player/transport behavior, browser synth
voices or sound mapping, fetch/caching policy, CORS, manifest or playlist indexes, audio
encoding, visualizations, or pitched output (Appendix A). Those belong to the web player
in this repo (`docs/`) and its future revisions; nothing in them may alter §2–§9.

---

## Appendix A — Reserved: `M2M-NOTES` (pitched output, future)

`notes-from-merkle.py` in this repo demonstrates a pitched companion mode. §9 reserves
space for it so rhythm v1 is never invalidated:

- **Reused unchanged:** leaf derivation (§4), loop length (§6), duration table +
  placement + cyclic reuse (§7), tempo/PPQ/duty constants (§5). For the same root, a
  notes pattern's rhythm is identical to rhythm v1.
- **Additional root bits 2–18:** scale mode (3 bits), root note (6 bits), base octave
  (5 bits), octave-range flag (1 bit, leaf-adjacent layout per current script).
- **Additional leaf bits 11–18:** per-note melodic degree.
- Channel 0 (melodic) replaces channel 9; key becomes note-dependent; a `program_change`
  opens the track.

Status: **superseded — frozen elsewhere.** `M2M-NOTES v1.0.0` (`MIDI-NOTES-PROTOCOL.md`,
Oct 1) is the canon for the pitched layer: its §2–§3 pin the scale/pitch rules sketched
above (with the OP1 fix: truly disjoint leaf bits 11–18), §4–§5 define the shoehorn map,
§6 defines mapped exports. Cross-language conformance **is** claimed and fixture-checked.
Rhythm only: `notes-from-merkle.py` shares the patched §7.4 engine (cyclic reuse,
clean exact-fill stop) and derives pitch of a wrapped note from the same wrapped leaf
(`degree[i mod 32]`), so notes-pattern rhythm is identical to rhythm v1 for any root.

## Appendix B — Reference implementation map

| Spec section | `midi-from-merkle.py` symbol |
|---|---|
| §4 | `derive_leaves()` |
| §6 | `root_bits_to_bar_count()` |
| §7.1–§7.2 | `leaf_to_duration()`, `DURATION_TABLE` |
| §7.3–§7.4 | `fill_rhythm_to_target()` — conforms (cyclic leaf reuse + clean exact-fill stop, patched post-`5b59f81`) |
| §5, §10 | `generate_midi()`, constants block |
| §2 | `fetch_latest_block()`, validation in `main()` |

## Changelog

- `1.0.0` — Initial freeze from `midi-from-merkle.py` @ `5b59f81`, validated against the
  committed `midi-files/` archive (31 files, SMF-parsed). Normative decisions over the
  script: cyclic leaf reuse guaranteeing exact bar count (§7.4, resolves the 8-bar
  exhaustion found in 6 of 7 archived 8-bar files), no-zero-length-notes rule (§7.4,
  resolves the trailing artifact in `955877_merkle_7be11c59.mid`), explicit VLQ/delta
  bounds (§10), integer-semantics clauses (§8). Format type confirmed as 1 (mido default).
  Reference patched to conform after freeze (see §7.4 resolution note); spec rules
  themselves unchanged.
- `1.0.1` — editorial only: the web player now lives in this repo (`docs/`), so §11
  wording updated from "future web repo" to the in-repo app. No rule change; derivation
  and event streams are byte-identical to `1.0.0` (fixture tags re-stamped;
  `node tests/verify.mjs` passes unchanged).
- `1.0.2` — editorial only: Appendix A updated to point at the now-FROZEN
  `M2M-NOTES v1.0.0` (`MIDI-NOTES-PROTOCOL.md`); header consumer line reflects the live
  player. Rhythm rules §2–§10 untouched; fixtures re-verified (98 checks incl. NOTES).
