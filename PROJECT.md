# merkle-to-words — Project Record

**Web app name:** merkle ensemble · **Living doc** — update §2/§4 in place as features land.
Purpose: one artifact to resume from, decide from, and add features against.

## 1. What this is

Deterministic music from Bitcoin: a block's merkle root derives a rhythm pattern
(frozen in `MIDI-PROTOCOL.md` v1.0.1), playable via Python tools, downloadable as
`.mid`, and performable live in the browser as a 7-instrument ensemble on GitHub Pages.

Three pillars:

- **Protocol** — `MIDI-PROTOCOL.md` (`M2M-RHYTHM/1.0.1`). The contract. Neither
  implementation is authoritative; disagreements are bugs; changes are amendments.
- **Reference tools** — `midi-from-merkle.py` (drums), `notes-from-merkle.py`
  (pitched sketch), `words-from-merkle.py`; cross-language verification via
  `make-fixtures.py` → `tests/verify.mjs`.
- **Player** — `docs/`: derive → place blocks into instrument slots → ensemble
  playback, 808-flavored Web Audio synthesis. Dark, mobile-first, no build step.

## 2. Status snapshot

| Area | State |
|---|---|
| Protocol v1.0.1 | **Frozen** (1.0.1 editorial; derivation unchanged since 1.0.0 freeze). Golden vectors as doc amendment deferred; fixtures already exist in `tests/`. |
| Python reference | **Conforms** — §7.4 cyclic reuse + exact-fill stop, both scripts; validated over 240 synthetic roots. |
| JS derivation + SMF writer | **Conforms** — `node tests/verify.mjs` PASS 43/43; downloads byte-identical to mido. |
| Player features shipped | blocks-on-request (tip/height), 7 slots + shelf (max 8), drag & tap-move, mute, independent/master loop modes, ⟲ re-align, session URL+localStorage, per-block `.mid` download, **transpose ±1/±12 (melodic slots only)**, **BPM box 20–300 (commits at next boundary)** |
| Needs eyes/ears | Human browser pass never done — phone (iOS audio unlock, tap-to-move) + desktop |
| Pages deploy | Repo public; serve from `main` → `/docs` |
| `midi-files/`, `notes-midi/` archives | Pre-patch patterns; regeneration **deliberately deferred** |
| Git | User commits on their own cadence — check `git status`, never assume |

## 3. Architecture invariants (do not break)

- **Derivation is the protocol, verbatim.** Same root → same `E(R)` in Python and
  JS, forever, under `1.x`.
- **Render-time ≠ protocol.** Voice/slot choice, BPM box, transpose offsets, mute,
  loop mode, mixing — all live *above* `E(R)`. Downloaded files remain canonical
  (§5: ch 9, key 35, 120 BPM). Nothing in the player may alter §2–§9.
- **Transport semantics stay parameterized, not decided-away:** part phase anchor
  (`anchorTick`) per part — anchored default = all parts at bar 0 on Play, power-of-2
  loops re-converge every cycle; head-start entry exists; `resyncAllToTop()`;
  `cycleLen` computed, never hardcoded.
- **Tempo is a piecewise tick↔second map** (segments): continuous at boundaries,
  pending changes commit at the next shared boundary (bar edge / cycle top) so the
  ensemble retimes together and never desyncs.
- **Sessions round-trip through the URL** (`v,b,s,m,t,u` params) + localStorage
  mirror; restored sessions derive locally — zero API calls.
- **Blocks are fetched on request only.** No background polling.

## 4. Decision log

| Decision | Rationale |
|---|---|
| Sync criterion = event-equivalence; SMF bytes matched later anyway | Playback identity is the contract; byte-identity became free via running-status compression — nice for diffing against the archive |
| The doc is the canon (not Python) | Two implementations in two repos' worth of distance; disagreements need an arbiter that isn't either codebase |
| Cyclic leaf reuse on exhaustion | Loop length is *always* exactly 1/2/4/8 bars; 8-bar loops exhaust 32 leaves ~60% of roots — early-stop violated the design intent |
| No zero-length notes (exact fills stop clean) | Spurious `on/off` pair at delta 0 was a reference bug |
| Wrap (reuse) chosen over silence-padding / early-stop | User call: musical continuity over dead air |
| Transpose hidden on percussion | Drum voices are unpitched by synthesis; semitone shifts are meaningless there. 808 *tuning* (kick/snare body) is a different, future sound-design knob |
| BPM = player-only, typed box, applies at next loop boundary, loop may reset | User call; not for beat-matching; files stay 120 BPM |
| 7 slots = the 7 instruments; 8th block parks on shelf | User call ("instruments like a 'slot'") |
| Derive live from tip, single repo `docs/`, same-repo fixtures dir | User calls across planning sessions |
| One block per slot, no stacking; moves are permanent | Ensemble = 7 parts max |
| `1.0.1` editorial bump (Sep 30) | Web player shipped into this repo's `docs/` — §11's "future web repo" wording became stale. Governance path demonstrated: wording fix flows through version discipline, derivation provably untouched (verify.mjs passes unchanged) |
| Live rotation tied to real blocks, not timers (Sep 30) | Owner ruling: "no shuffling without a new block found in real life." Each new chain block advances the arrangement one round-robin step; while LIVE, poll tip ~60 s (overrides manual-only fetch **for LIVE mode only**; manual stays default) and evict oldest at the 8-cap |
| Drag/manual editing exits LIVE | Manual arrangement = user takeover; LIVE can be re-armed at will and resumes rotation **from the current arrangement** (round-robin continues wherever the user left it) |
| Arrangement snapshots | Save named configurations (which block sits in which slot) to restore later — owner request alongside live mode |
| Shoehorn: paint by default + merkle-fill (Sep 30) | Owner ruling; fill follows deterministic rules and auto-refills on live push-shuffle; map is global/instrument-independent, drums never pitched (standing ruling), per-slot transpose stacks after the map |
| Mapped export: spec before build (Sep 30) | Owner ruling → drafted `MIDI-NOTES-PROTOCOL.md`; canonical drum downloads remain untouched; mapped files are an explicit separate export |
| OP1: fix bit overlap, don't canonize (Sep 30) | Owner: "young project, we want it right." `leaf_to_pitch_byte` now reads true disjoint bits 11–18 (was 5–12, overlapping duration). Melody ⟂ rhythm restored; old `notes-midi/` files stale, join deferred-regeneration queue. Draft → 0.2.0-DRAFT |

## 5. Roadmap

### Now
- [ ] Human browser pass: phone + desktop — listen to voices/mix levels, drag vs
      tap ergonomics, iOS gesture-unlock, status-line readability.
- [ ] Commit current transpose + BPM work; confirm live Pages URL serves the new build.
- [ ] One real public session link shared as the canonical smoke target.

### Next features — design settled by owner rulings (Sep 30); awaiting build order
- [ ] **Live mode ("conductor")** — LIVE toggle; while on, poll tip ~60 s (polling
      allowed **only** in LIVE; manual fetch stays the default elsewhere). New block →
      evict-oldest at the 8-cap → auto-place on the next boundary → **all placed
      blocks rotate one round-robin step**. Rotation happens ONLY on real arrivals —
      no timer shuffles. Drag/unassign exits LIVE; re-arming resumes rotation from
      wherever the user's arrangement now stands. Engine seams (quantized entry,
      computed cycleLen, re-align, slot permutation) all exist.
- [ ] **Arrangement snapshots** — named saves of block↔slot (+mode/bpm/transpose;
      map later) in localStorage; restore from a list; URL sharing stays independent.
- [ ] **Shoehorn pitch map (player half)** — paint UI over the 64 eighth-cell grid
      (M2M-NOTES §4), `&p=` session round-trip (§7), schedule-time
      `pitchFor(t mod cycle)` lookup at the existing `voice.trigger(...midiNote)`
      seam, per-slot transpose stacks after the map, drums never pitched.
      Playback-only; export waits for the freeze.
- [ ] **merkle-fill** — `fillMap(block)` per M2M-NOTES §5 (writes event cells, leaves
      user paint elsewhere intact); auto-refill from newest block during LIVE.
      Reference side DONE (OP1 fixed, notes-script patched + verified); remaining
      gate is the JS `fillMap()` implementation + draft freeze.
- [ ] More instruments beyond the seven (user: "we can add more later").
- [ ] Re-voicing: per-slot instrument dropdown vs today's fixed 7 slots.
- [ ] Optional 808 tuning knobs (kick pitch/body, snare tone) — sound design, not transpose.
- [ ] Mix controls: master volume; per-slot volume/solo.

### Later / structural
- [ ] **M2M-NOTES freeze (0.2.0-DRAFT → 1.0.0)** — draft exists:
      `MIDI-NOTES-PROTOCOL.md` (fills Appendix A). OP1 RESOLVED (bit-overlap fix +
      reference patch, verified). Remaining: OP2–4 rulings (grid resolution option,
      empty-cell fall-through default, export program), melodic fixtures in
      `make-fixtures.py` + verify.mjs extension, player paint UI round-trip —
      then freeze.
- [ ] Protocol amendment: golden test vectors appendix (mechanical now — fixtures
      exist; formalize into the doc).
- [ ] Regenerate `midi-files/` (and `notes-midi/`) under conformance; decide
      whether pre-patch files are replaced or kept as history.
- [ ] CI: GitHub Action running `node tests/verify.mjs` on push — machine-checked
      JS↔Python sync forever.
- [ ] Revisit 8th slot if a future voice deserves it.

## 6. How to add a feature (keeps the protocol honest)

1. Does it change the **derived event stream** (rhythm/timing/pitches for a given
   root)? → Amend `MIDI-PROTOCOL.md` first per its §1 governance; then implement in
   Python **and** JS; then fixtures verify.
2. Purely **render-time** (sound, tempo display, mixing, UI)? → Player work; no
   protocol touch; downloads stay canonical; add to §5 when it lands.
3. Assigns **new meaning to reserved bits** (root 2–18, leaf 11–18)? → That is
   M2M-NOTES territory; freeze its doc before second implementations.

## 7. Where things live

| Path | Role |
|---|---|
| `MIDI-PROTOCOL.md` | Frozen spec (M2M-RHYTHM/1.0.1) |
| `MIDI-NOTES-PROTOCOL.md` | Pitched layer + shoehorn map + mapped export — v0.2.0-DRAFT (OP1 resolved; OP2–4 open) |
| `make-fixtures.py`, `tests/` | Cross-language verification |
| `docs/` | GitHub Pages player |
| `AGENTS.md` | Agent onboarding + build-state details |
| `sync_merkle_mid.command` | Personal Dropbox↔Ableton sync (unrelated to protocol) |
| `midi-files/`, `notes-midi/` | `.mid` archives (pre-patch) |
