# merkle-to-words — Project Record

**Web app name:** merkle ensemble · **Living doc** — update §2/§4 in place as features land.
Purpose: one artifact to resume from, decide from, and add features against.

## 1. What this is

Deterministic music from Bitcoin: a block's merkle root derives a rhythm pattern
(frozen in `MIDI-PROTOCOL.md` v1.0.2 + `MIDI-NOTES-PROTOCOL.md` v2.1.0), playable via
Python tools, downloadable as
`.mid`, and performable live in the browser as a 7-instrument ensemble on GitHub Pages.

Three pillars:

- **Protocol** — `MIDI-PROTOCOL.md` (`M2M-RHYTHM/1.0.2`) + `MIDI-NOTES-PROTOCOL.md`
  (`M2M-NOTES/2.1.0`). The contract. Neither implementation is authoritative;
  disagreements are bugs; changes are amendments.
- **Reference tools** — `midi-from-merkle.py` (drums), `notes-from-merkle.py`
  (pitched sketch), `words-from-merkle.py`; cross-language verification via
  `make-fixtures.py` → `tests/verify.mjs`.
- **Player** — `docs/`: derive → place blocks into instrument slots → ensemble
  playback, 808-flavored Web Audio synthesis. Dark, mobile-first, no build step.

## 2. Status snapshot

| Area | State |
|---|---|
| Protocols | Rhythm `M2M-RHYTHM/1.0.2` **frozen** (1.0.1/1.0.2 editorial; derivation unchanged since 1.0.0). Pitched `M2M-NOTES/2.1.0` **frozen Oct 1** — 2.0.0 piano-roll MAJOR (own-length looping map, mono + ≤7 chords, drag brush) then 2.1.0 MINOR/PATCH: 1/2-bar extents over a fixed 128-col store (non-destructive shrink/grow), map capo, ♯-fold view; eighth cell corrected to 240 ticks (frozen text's "600" was a typo). Fixtures in `tests/`. |
| Python reference | **Conforms** — §7.4 cyclic reuse + exact-fill stop, both scripts; disjoint bits 11–18 pitch fix (OP1); validated over 240 synthetic roots. |
| JS derivation + SMF writers | **Conforms** — `node tests/verify.mjs` PASS 98/98 (rhythm + NOTES: melody32, scale params, pitchBytes, mapped-SMF bytes); canonical downloads byte-identical to mido. |
| Player features shipped | **app v1.2.0** (versioned via `docs/js/version.js`, header + snapshots): blocks-on-request (tip/height, shelf-by-default), 7 slots + shelf (max 8), drag & tap-move, **assign dropdown per block (evict-to-shelf)**, mute, independent/master loop modes, ⟲ re-align, session URL+localStorage, per-block `.mid` download, transpose ±1/±12 (melodic only), BPM box 20–300 (boundary commit), LIVE mode (60 s poll, evict-oldest, arrival-driven rotation), snapshots (cap 20), melody map piano roll (drag-paint, **1/2/4/8/16-bar extents over fixed 128-col store**, mono/chords ≤7, **map capo ±1**, **♯-fold view with hidden-sharp markers**, merkle-fill, mapped export ⤓), **two-click CLEAR** |
| Needs eyes/ears | Human browser pass never done — phone (iOS audio unlock, tap-to-move, live/paint ergonomics) + desktop |
| Pages deploy | Repo public; serve from `main` → `/docs` |
| `midi-files/`, `notes-midi/` archives | Pre-patch patterns; regeneration **deliberately deferred** |
| Git | Owner commits/pushes on their own cadence — check `git status`, never assume. Remote is SSH (`git@github.com:BTCMcBoatface/…`), verified working Oct 1. Commit identity from `~/.gitconfig` (persona — intentional, not a leak). Agents propose one-line commit messages; owner executes unless explicitly delegated. |

## 3. Architecture invariants (do not break)

- **Derivation is the protocol, verbatim.** Same root → same `E(R)` in Python and
  JS, forever, under `1.x`.
- **Render-time ≠ protocol.** Voice/slot choice, BPM box, transpose offsets, mute,
  loop mode, mixing, LIVE rotation, melody-map painting + merkle-fill — all live
  *above* `E(R)`. Canonical downloaded files remain
  (§5: ch 9, key 35, 120 BPM). Nothing in the player may alter §2–§9.
- **Transport semantics stay parameterized, not decided-away:** part phase anchor
  (`anchorTick`) per part — anchored default = all parts at bar 0 on Play, power-of-2
  loops re-converge every cycle; head-start entry exists; `resyncAllToTop()`;
  `cycleLen` computed, never hardcoded.
- **Tempo is a piecewise tick↔second map** (segments): continuous at boundaries,
  pending changes commit at the next shared boundary (bar edge / cycle top) so the
  ensemble retimes together and never desyncs.
- **Sessions round-trip through the URL** (`v,b,s,m,t,u,p,q,o,h,g` params) +
  localStorage mirror; restored sessions derive locally — zero API calls.
- **Melody maps stay OBJECTS, not globals** (future-proofing the owner's
  multi-map direction): one map is attached to the ensemble today, but all map
  state (cells, extent, capo, polyphony, source) is a single self-contained unit
  that can be cloned/assigned per instrument later; per-map `t mod mapTicks`
  math already yields natural phase drift between maps of different lengths.
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
| OP2: eighths only | v1 grid = 64 cells × 600 ticks over the 15360-tick cycle. 16ths remain a future format-compatible option (change `cellTicks` only) |
| OP3: melody-source switch, not a fixed fallback | Owner refined: **MERKLE on** → empty-cell notes sing the block's deterministic melody; **MERKLE off** → empty cells use the voice default. Painted cells override in both modes. The "fill" button just materializes the current source into cells as a starting sketch |
| OP4: mapped export = fixed program 0 | File is a melody sketch; user picks sound in their DAW |
| Build order: live → shoehorn → fill/freeze | Live+snapshots are spec-independent and immediate payoff; paint unlocks the freeze checklist; fill is the last spec-consumer |
| Disclosure policy (Oct 1, moved to AGENTS.md) | Real-name strings prohibited in every agent-written artifact (full history/pack sweeps verified clean pre-public); BTCMcBoatface persona + gmail intentionally public; machine usernames discouraged. Canonical text lives in AGENTS.md "Disclosure policy" |
| Commit-message practice (Oct 1, in AGENTS.md handoff) | Build rounds end with exactly one proposed short commit line; owner handles git unless explicitly delegating |
| M2M-NOTES 1.0.0 freeze (Oct 1) | Both published gates green (melodic fixtures 98/98; paint round-trip). Rhythm doc → 1.0.2 editorial (Appendix A superseded by pointer). Pitched derivation immutable under 1.x from here |
| M2M-NOTES 2.0.0 — same-day MAJOR amendment (Oct 1) | Interaction review found the v1 fixed 8-bar-cycle grid wrong: map must be a piano roll (time→, pitch↑↓) with its OWN selectable length (4/8/16 bars, default 4), looping in sync across all instruments ("no block owns a melody"), mono default with optional ≤7-pitch chord stacks per column, drag-painted brush (mousedown paints, held stroke covers, no palette — cells take their row's pitch). Output-affecting ⇒ MAJOR per §1. No external users existed; the bump is honest, not convenient. Lesson logged: interaction-review brand-new UIs before freezing |
| No auto-assign outside LIVE (Oct 1, BUILT v1.1.0) | Blocks join the shelf and are placed by hand. Only two exceptions: first-load demo (tip → Bass Drum once) and LIVE arrivals (auto-place + rotation, mechanically necessary). Manual get-latest/fetch-height land shelf-only with a status hint |
| Reassign = evict-to-shelf, not swap (Oct 1) | Owner ruling: moving block A onto occupied B sends B to the shelf (stays in collection). Deterministic, never double-books an instrument |
| ✕ is Clear, two-click armed (Oct 1) | Owner reframing: "clear" not "reset" — stops transport, disarms LIVE, returns every block to the shelf; collection, map, tempo, transposes survive; no refetch, no demo. Second click within 3.5 s required ("clear?") |
| Map extent model, not resize-reslice (Oct 1) | Fixed 128-col (16-bar) store; the length selector chooses the LOOPING window (1/2/4/8/16, baseline 4). ÷2/×2 non-destructive (tail hides, returns) — also future-proofs per-instrument maps whose lengths differ |
| Capo = map-level, sounding-only (Oct 1) | Owner chose map-wide ±1 over per-note/view-offset: painted data immutable, applied at schedule + painted-export, fallbacks never capoed, clamped ±11. ♯-fold is a view filter (hidden sharps = notch markers), never serialized |
| Eighth-cell arithmetic: 240, not 600 (Oct 1) | The frozen 2.0.0 text's "600 ticks" contradicted its own math (15360/64 = 240); shipped code inherited it — back third of every map was unreachable. Found via real-eighth-timing test. Lesson: property tests must use MUSIC times, not code arithmetic. Spec PATCH-corrected |
| App versioning convention (Oct 1) | `docs/js/version.js` single source, shown in header tag, stamped into snapshots. 1.0.0 = first ensemble build (retroactive); 1.1.0 = live/snapshots/piano-roll/shelf/dropdown/clear; 1.2.0 = capo/fold/1-2-bar extents. MAJOR breaks session/export semantics, MINOR adds features, PATCH fixes |

## 5. Roadmap

### Now
- [ ] Human browser pass (never done — the app has no listener yet): phone + desktop.
      Voices/mix levels, drag vs tap ergonomics, iOS gesture-unlock, LIVE button,
      paint grid, ♯-fold markers + notch visibility, capo readout, extent switching
      (incl. hidden-tail restore on ×2), snapshot flow, mapped export.
- [x] Commit current build (live mode + snapshots + melody map + NOTES freeze +
      version bumps) — `0ed82ba` pushed Oct 1.
- [ ] Confirm live Pages URL serves the v1.2.0 build (hard-refresh past cache;
      header tag should read `player v1.2.0`).
- [ ] One real public session link shared as the canonical smoke target.

### Shipped (Oct 1) — awaiting only the browser pass above
- [x] **Live mode ("conductor")** — LIVE toggle; polls tip ~60 s ONLY while armed;
      new block → evict-oldest at cap → rotate placement one round-robin step (parts
      travel with blocks — timing untouched, only voices change) → auto-place on next
      boundary. First tick after arming baselines the height (no rotate-on-arm).
      Drag/unassign/remove exits LIVE; re-arming resumes from current arrangement.
- [x] **Arrangement snapshots** — named saves (blocks, slots, mode, bpm, transpose,
      map, source) in localStorage, capped at 20; save/use/delete chips.
- [x] **Shoehorn melody map (piano roll, v2)** — canvas: time left→right eighths,
      pitch vertical (2-octave window, default C2–B3, ◀/▶ octave shifter); mousedown
      paints and a held drag covers every crossed cell at its row's pitch (stroke
      interpolation); right-drag removes that pitch. The map loops at its OWN length
      (4/8/16 bars, default 4), synced across every instrument. Monophonic by default
      (repaint replaces); checkbox enables chord stacks ≤7, played together at the
      merkle rhythm's timings. `_pitchStackFor()` at schedule time; per-slot transpose
      folds last; drums structurally never pitched. Session round-trip
      `&p`(count-prefixed cells)/`&q`/`&o`/`&g`; legacy v1 links still decode.
- [x] **merkle-fill** — "fill from block" materializes a block's deterministic melody
      into map columns, wrapping at map length (mono: last write wins; chords: union,
      cap 7), leaving untouched cells as user paint (M2M-NOTES §5).
- [x] **Mapped export** — "⤓ notes" per block: same timing deltas as canonical file,
      channel 0, program 0; painted cells override, else the block's merkle melody
      (voice defaults never enter files). Byte-checked against the notes-script
      mido output in fixtures.
- [x] **M2M-NOTES FROZEN — v1.0.0, amended v2.0.0 then v2.1.0 same day (Oct 1)** — OP1–4
      ruled; melodic fixtures + verify.mjs extension (98 checks) + round-trip passing;
      piano-roll rework bumped MAJOR per §1; same-day MINOR+PATCH (extents/capo/fold,
      240-tick cell fix); rhythm doc 1.0.2 (editorial: Appendix A → superseded pointer).

### Next features — discuss when ready
- [x] **Shelf-by-default + assign dropdown + clear (BUILT v1.1.0)** — manual fetches
      land on the shelf; every block card carries a ▾ dropdown (shelf / any instrument);
      occupied targets EVICT to the shelf (owner ruling — no swap). ✕ became a two-click
      armed CLEAR: unassign everything to the shelf, keep collection + map + tempo,
      stop transport, disarm LIVE; no refetch/demo. First-load demo and LIVE auto-place
      remain the only automatic assignments (owner ruling). Snapshots stamp appVersion.
- [ ] **Multiple melody maps → instruments** (owner's stated future: divergent
      notes/harmonies per instrument; lengths may differ → drift/offset by design).
      Prepared-for: map state is already a self-contained unit with per-map
      `t mod mapTicks` looping; next step is a `maps[]` registry + slot→mapId
      assignment (single global map stays the default degenerate case). Do NOT
      hardcode the one-map assumption into new features.
- [ ] More instruments beyond the seven (user: "we can add more later").
- [ ] Re-voicing: per-slot instrument dropdown vs today's fixed 7 slots.
- [ ] Optional 808 tuning knobs (kick pitch/body, snare tone) — sound design, not transpose.
- [ ] Mix controls: master volume; per-slot volume/solo.
- [ ] Live-mode polish: rotation counter display, poll-interval option, arrival sound.
- [ ] Mobile melody-map treatment (owner-flagged Oct 1, deferred): the piano roll needs
      a popup / modular panel on phones rather than an inline section — part of the
      broader "doesn't work on mobile yet" pass. Keep map state in engine unchanged;
      this is a layout/interaction layer so it does not box in the multi-map future.

### Later / structural
- [ ] Protocol amendment: golden test vectors appendix (mechanical now — fixtures
      exist; formalize into the docs).
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
| `MIDI-PROTOCOL.md` | Frozen spec (M2M-RHYTHM/1.0.2) |
| `MIDI-NOTES-PROTOCOL.md` | Pitched layer + shoehorn piano roll + mapped export — **v2.1.0 FROZEN (Oct 1)** |
| `make-fixtures.py`, `tests/` | Cross-language verification |
| `docs/` | GitHub Pages player |
| `AGENTS.md` | Agent onboarding + build-state details |
| `sync_merkle_mid.command` | Personal Dropbox↔Ableton sync (unrelated to protocol) |
| `midi-files/`, `notes-midi/` | `.mid` archives (pre-patch) |
