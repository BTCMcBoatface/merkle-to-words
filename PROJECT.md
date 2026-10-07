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
| Player features shipped | **app v1.6.0** (versioned via `docs/js/version.js`, header + snapshots): **drum grid v1.6 — split dials: paint dial is writing-snap ONLY (events on the 40-tick lattice, existing notes frozen; ³ triplets on ♩/♪ only) and block timing gets its own selector (raw = exact §7.4 onsets, sacrosanct default | ¼ | ⅛ | 1/16); rest windows suppress all hits inside their span; timeline drawing shows exact positions** · **⤓ loop export — whole audible ensemble over the LCM-max loop; owner channel map (lead ch 11 / bass ch 12 / organ ch 16; drums Ch13·Keys kick 36 / snare 38 / hat·c 42 / hat·o 46 ⇄ Ch1–4·Split GM keys — toggle at download); NO program changes; Type 0/1 toggle; audible BPM meta; velocity 127; `ensemble_<bars>b_<root8>.mid`** · **∿ tempo-synced sine modulation — right-click/long-press any melodic slider to oscillate its full min↔max span; cycle chooser 1·½·♩·♪·♬ (one complete sine loop per duration, tick-domain so BPM retunes it); live LFO oscillators for filter/Q, per-note sampling for envelope/level/drawbars; mods stored {rate, depth, lo, hi, phase} — depth/lo/hi/phase reserved for future min/max markers; tonebank-local like all sound settings. Also: localStorage keys were silently corrupted since creation (stray “…” glyphs in `m2m-tones-v1`/session/snapshot keys) — corrected to the documented ASCII keys with one-time migration on load, no lost data** | **v1.4 drum ribbons + arm-on-paint**; **sound layer — per-voice tone panels as instrument POPUPS (≥2 card widths / ~70vw; lead: wave/filter-open/close/resonance/attack/length/release/level; bass: wave/cutoff/resonance/attack/length/level; organ: 4 drawbars/attack/length/release/level), named favorites (cap 8/voice) + current settings + whole-mix reverb knob — all localStorage via `tonebank.js`, never session URL/snapshots/files**; blocks-on-request (tip/height, shelf-by-default), 7 slots + shelf (max 8), drag & tap-move, **assign dropdown per block (evict-to-shelf)**, mute, independent/master loop modes, ⟲ re-align, session URL+localStorage mirror, per-block `.mid` download, transpose ±1/±12 (melodic only), BPM box 20–300 (boundary commit), LIVE mode (60 s poll, evict-oldest, arrival-driven rotation), snapshots (cap 20), melody map piano roll (drag-paint, **1/2/4/8/16-bar extents over fixed 128-col store**, mono/chords ≤7, **map capo ±1**, **♯-fold view with hidden-sharp markers**, merkle-fill, mapped export ⤓), **two-click CLEAR** |
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
| App versioning convention (Oct 1) | `docs/js/version.js` single source, shown in header tag, stamped into snapshots. 1.0.0 = first ensemble build (retroactive); 1.1.0 = live/snapshots/piano-roll/shelf/dropdown/clear; 1.2.0 = capo/fold/1-2-bar extents; 1.3.0 = voice tone panels + favorites + global reverb; 1.3.1 = tone panel as instrument popup (≥2 cards) + wrapping actions row (PATCH — layout fix, no semantics change); 1.4.0 = drum ribbons; 1.4.1 = arm-on-paint (PATCH); 1.5.0 = ∿ modulation + localStorage key migration; 1.6.0 = drum split-dials (writing-snap vs block timing) + ⤓ loop export. MAJOR breaks session/export semantics, MINOR adds features, PATCH fixes |
| Tone = expose what the synth already contains (Oct 5, BUILT v1.3.0) | Owner scope: lead/bass/organ dials only, "only what is built in, already there, and modifiable" — waveform (4 built-in osc types), filter cutoff/Q, envelope times, organ drawbars, level; no new signal sources, no LFO effects, drums untouched. TONE_DEFAULTS are the original hard-coded constants: a fresh session sounds exactly like pre-1.3.0 |
| Sound settings are LOCAL-only (Oct 5) | Owner: persistence "based on a user's local browser storage" — current tones + favorites bank (cap 8/voice, reload one at a time) + reverb live in `tonebank.js` localStorage (`m2m-tones-v1`), NOT the session URL and not snapshots; share links stay arrangement-only, downloads stay canonical (§11 render-time rule holds) |
| Reverb = ONE whole-mix knob (Oct 5) | Owner ruling: not per-instrument. Post-compressor send over a synthesized decaying-noise IR (no audio asset, no dependency); drums included; live-adjustable while playing |
| ∿ modulation = full-span sine, tick-locked (Oct 5, BUILT v1.5.0) | Owner spec: right-click/long-press any melodic slider → oscillates min↔max in a sine; cycle duration ∈ {whole, half, quarter, eighth, 16th} = one complete loop (phase 0 at transport tick 0). value(t) = mid + (span×depth/2)·sin(2π·tick/cycle). Filter cutoff/Q ride a real shared sine oscillator summed into the AudioParam (true wobble on sustained notes); envelope/level/drawbar params sample per note. All params modulate off ONE shared clock → instruments wobble in phase. Sine-only per owner |
| Drum dials SPLIT: writing-snap vs block timing (Oct 6, BUILT v1.6.0) | Owner re-design after living with v1.4: "quantization is only for when writing notes" + "block-defined rhythms are sacrosanct and cannot be quantized." Paint dial (whole…16th + ³ toggle) now ONLY sets the snap for new input — existing events never move; the block layer has its own explicit selector (raw = exact §7.4 onsets by default; ¼/⅛/1/16 quantize only when chosen). Math behind the lattice: §7.4 durations (sixteenth 120t … eighth-triplet 160t … dotted values) share a 40-tick common refinement (quarter/12) → paint events stored on it, so straight and triplet grids coexist with zero drift and rest windows suppress exactly. Triplets offered on ♩/♪ only ("nothing finer than eighth-triplets"); ♬ hidden in ³ mode. Legacy links/snapshots (&d res-cell arrays) re-map onto the lattice automatically |
| Ensemble loop export = session state on file, player-side (Oct 6, BUILT v1.6.0) | ⤓ loop writes the AUDIBLE whole arrangement (melody-map pitches w/ capo+transpose baked, raw-or-quantized drum timing per lane incl. standalone ribbons, muted parts absent) over the common-zero loop — all lengths are powers of 2 so LCM = MAX active period (engine's phase-anchor invariant guarantees re-convergence; 1-bar export legit). Owner channel map locked: lead 11 / bass 12 / organ 16; drums Ch13·Keys (36/38/42/46) ⇄ Ch1–4·Split (GM keys) — toggle at download; NO program changes (templates pre-select by channel); nothing beyond notes + tempo meta (audible BPM) + Type-1 track names; velocity 127; `ensemble_<bars>b_<root8>.mid`. Canonical §10 and mapped §6 per-block files unchanged — this is composition export, not protocol output |
| UI glyphs: BMP only (Oct 6) | 𝅝/𝅗𝅥 (U+1D15x, astral plane) render as tofu in browsers/TUIs without music-font coverage — owner-confirmed. All duration dials now `1 · ½ · ♩ · ♪ · ♬` (BMP/Latin-1). Rule: keep UI strings below U+FFFF; emoji 💾 tolerated (color-font ubiquitous) |
| Mods don't box the future (Oct 5, owner directive) | Every mod stored {rate, depth, lo, hi, phase}: lo/hi default to schema min/max and are honored by the math already — future min/max MARKERS plug in by writing lo/hi, zero format/code change. Drum params can join by gaining a `modTarget` field; the engine LFO service is param-name-agnostic |
| Mods = sound layer → tonebank-local (Oct 5) | Follows the established sound-settings ruling: persisted in `m2m-tones-v1` with favorites (favorites capture mods too — "use" restores tone+oscillations together); NOT session URL, downloads canonical. Trigger signature grew an OPTIONAL 7th arg (modCtx) — backwards compatible; unmodulated voices pay nothing (no osc spawned) |
| localStorage keys had stray “…” glyphs since creation (Oct 5, fixed in v1.5.0) | `m2m-ton…s-v1`, `m2m-rhyth…n-v1`, `m2m…s-v1` — copy-paste-corrupted constants (grep truncation baked into source); worked only because readers/writers shared the same broken key. Corrected to documented ASCII (`m2m-tones-v1`/`m2m-session-v1`/`m2m-snapshots-v1`) with one-time silent migration from the legacy keys — existing browsers keep tone/favorites/snapshots/session. Lesson: byte-check string constants, don't trust truncated grep |
| Painting ARMS the lane (Oct 5, BUILT v1.4.1) | Owner browser report: "drum map doesn't seem to be playing" — headless sim proved the engine plays (ghosts/paint/rest/standalone all fire), so it was a discoverability trap: lanes default `rhythm` (raw = prior behavior preserved), and painting cells in rhythm mode is silently ignored. Fix = painting an audible cell (hit/rest) auto-flips that lane to SEQ; gutter now a bold SEQ/raw PILL; status line names the armed lane. Raw stays the default — never changed under the owner's feet, just made obvious how to leave it |
| Drum ribbons QUANTIZE, never re-derive (Oct 5, BUILT v1.4.0) | The sequencer is a view/mapping of §7.4 onsets onto a musical grid (nearest-cell, merge on collision) — E(R) stays the truth; switching back to "raw" plays the un-quantized merkle groove exactly as before. Tri-state cells (inherit/on/rest) so edits can ADD and PUNCH HOLES in the block rhythm; ghost markers show the quantized inheritance like ♯-fold notches showed hidden sharps |
| Ribbon stack = customary keymap order (Oct 5) | Owner: bass & snare at the bottom, low→high — VOICES order already is kick(35)/snare(38)/hat-c(42)/hat-o(46); lanes draw bottom-up from that. Gutter tap flips a lane raw ▸ seq |
| Seq grid is LIVE (Oct 5) | Owner: "quantizable between whole notes and 16th notes and adjustable on the fly" — res/extent switches re-snap painted cells (tick position preserved, nearest new cell, on-beats-rest on collision) and re-phase rolling cursors; quantized block layer recomputes automatically. Fixed 256-col store (16 bars of sixteenths) mirrors the map's fixed-store design |
| Drum seq rides blocks, not replaces them (Oct 5, Q&A) | Q1: block-quantized + editable ribbon; Q2: map-style shared extents (lanes can't drift apart — "no block owns a groove" energy); Q3: seq lanes sound WITHOUT a block (full second performance source); Q4: session URL + snapshots like the melody map (it's composition; packed 4×tri-state fits ~18 bytes of &d for typical edits) |

## 5. Roadmap

### Now
- [ ] Human browser pass (never done — the app has no listener yet): phone + desktop.
      Voices/mix levels, drag vs tap ergonomics, iOS gesture-unlock, LIVE button,
      paint grid, ♯-fold markers + notch visibility, capo readout, extent switching
      (incl. hidden-tail restore on ×2), snapshot flow, mapped export. **New in
      v1.3.0: "sound" panels (slider feel, favorites save/use/✕), reverb knob on
      the transport, tone persistence across refresh, and whether reverb tails
      sound right over the drums.
- [ ] Browser pass for the drum sequencer (v1.4.0): tap-cycle feel (hit ▸ rest ▸
      clear), stroke painting on phone touch, gutter lane-flips live while
      playing, whole→16th morph while playing (cursor re-phase audible?), ghost
      readability at 1/16 over 16 bars, and LIVE rotation re-voicing ribbons.
- [ ] Browser pass for ∿ modulation (v1.5.0): right-click / long-press feel on
      sliders, filter wobble character (depth curve, Q resonance squeal guard),
      multi-param phase coherence across voices, cycle retune on BPM change,
      CPU feel of shared LFO oscillators on phone.
- [ ] Browser pass for v1.6: write-dial changes must visibly move NOTHING (check
      painted + block hits after ♬→³→♪ etc.), block raw-vs-quantize audible on a
      triplet-heavy root, ³ mode hides ♬, rest windows kill wrapped hits, timeline
      sliver positions look right at 1/16×16 bars; ⤓ loop → import into DAW: per-track
      names, channels 11/12/13/16 (or split 1–4), tempo = audible BPM, loop length =
      longest active part, no program changes; play-then-export-then-reload round trip.**
- [x] Commit current build (live mode + snapshots + melody map + NOTES freeze +
      version bumps) — `0ed82ba` pushed Oct 1.
- [ ] Confirm live Pages URL serves the v1.6.0 build (hard-refresh past cache;
      header tag should read `player v1.6.0`).
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
- [x] **Drum sequencer — quantized ribbons (BUILT v1.4.0, Oct 5)** — dedicated section below the
      melody map: 4 lanes in customary kit order (kick bottom ▸ hat·o top), each lane flips
      raw(merkle) ▸ seq; seq plays the block's onsets quantized NEAREST-cell to the live grid
      (whole/half/quarter/8th/16th, extents 1–16 bars, both switchable on the fly — painted
      cells re-snap, block recomputes), with tri-state edits (on adds, rest punches holes);
      lanes sound standalone with no block. Session + snapshots carry it (`&e &j &i &d`,
      count-prefixed lane codec in `docs/js/seq.js`). Pure render-time — §7.4 derivation and
      canonical `.mid` untouched; defaults = pre-1.4.0 behavior.
- [ ] **Multiple melody maps → instruments** (owner's stated future: divergent
      notes/harmonies per instrument; lengths may differ → drift/offset by design).
      Prepared-for: map state is already a self-contained unit with per-map
      `t mod mapTicks` looping; next step is a `maps[]` registry + slot→mapId
      assignment (single global map stays the default degenerate case). Do NOT
      hardcode the one-map assumption into new features.
- [x] **Drum grid split-dials + ⤓ loop export (BUILT v1.6.0, Oct 6)** — paint dial =
      writing-snap only (40-tick event lattice, existing notes frozen, ³ triplets on
      ♩/♪); block timing its own selector (raw sacrosanct | ¼ | ⅛ | 1/16); rest windows
      suppress all inside; exact-position timeline drawing. ⤓ loop = whole audible
      ensemble over LCM-max loop, owner channel map (lead 11/bass 12/organ 16; drums
      Ch13·Keys ⇄ Ch1–4·Split), zero program changes, Type 0/1 toggle at download,
      audible BPM meta. Session: &e (incl 6/12) &w &j &k &i &f; legacy &d auto-remaps.
      BMP-glyph rule adopted (astral 𝅝 𝅗𝅥 → 1 ½). Headless suite: raw/quant/freeze/
      lattice/rest/live/codec-both-forms + SMF byte-walk all ✓; verify.mjs 98/98.
- [x] **Voice tone panels + favorites + reverb (BUILT v1.3.0, Oct 5; popup layout v1.3.1)** — "sound" button per
      melodic slot opens hidden dials (lead 8 params, bass 6, organ 4 drawbars + timing/level);
      panel = instrument popup anchored under the slot (≥2 card widths / ~70vw, capped 620px, ✕/Esc closes,
      actions row wraps — buttons never fall off the card);
      named favorites per voice (cap 8, reload one at a time), current tone + reverb persist in
      localStorage (`tonebank.js`, `m2m-tones-v1`) — never in session URL/snapshots/files.
      Whole-mix reverb = one transport knob over a synthesized IR (post-compressor send,
      live- adjustable, drums included). Defaults == original sounds byte-for-byte behavior;
      protocol untouched (§11). Roadmap "808 tuning knobs" (drums) and per-slot volume/solo
      remain open.
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
