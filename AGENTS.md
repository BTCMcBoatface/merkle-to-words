# merkle-to-words — Agent Context

## Project Overview
Tools for converting a Bitcoin merkle root (256-bit hash) into human-readable words and rhythmic MIDI patterns.

## Session handoff (every new session: do this first)
1. **Read `PROJECT.md`** — status snapshot, decision log, roadmap. It is the single
   resume-from artifact; "read first" applies to feature work especially.
2. **Never assume git state** — the owner commits/pushes on their own cadence, often
   outside agent awareness. Run `git status` / `git log` live, every time it matters.
3. **Commit messages**: when a build round is finished, propose exactly ONE short
   commit-message line at the end of the reply (owner commits, or explicitly delegates).
4. Verification gates before declaring done: `node tests/verify.mjs` must print
   PASS (currently 98/98, both protocols); new UI needs the human browser pass.

## Disclosure policy (standing — applies to every artifact an agent writes)
- **Prohibited:** the owner's personally identifying strings — real name (any
  spelling/variant) and personal account handle — in ANY file, code comment, doc,
  commit message, suggestion, or generated content. State the rule generically, as
  here; never enumerate the forbidden strings themselves. Privacy sweeps check the
  working tree, full git history (all blobs, decompressed via
  `git cat-file --batch-all-objects --batch`), commit messages, paths, and `.git`.
- **Fine to disclose:** the `BTCMcBoatface` pseudonym and its gmail — this is the
  publishing identity by choice; do not repeatedly warn about it.
- **Discouraged:** local machine-username strings; keep them out of written artifacts.

## Files
- `words-from-merkle.py` — Converts merkle root to 21-word BIP-39 phrase
- `midi-from-merkle.py` — Converts merkle root to rhythmic MIDI via merkle tree descent
- `notes-from-merkle.py` — Converts merkle root to pitched MIDI melody; shares the MIDI-PROTOCOL.md §7.4 rhythm engine and implements the frozen M2M-NOTES v2.1.0 deterministic pitch rules (disjoint bits 11–18)
- `MIDI-PROTOCOL.md` — Canonical cross-language spec for the MIDI pipeline (v1.0.2, `M2M-RHYTHM`); the contract Python and future JS implementations must both conform to
- `MIDI-NOTES-PROTOCOL.md` — Pitched layer + shoehorn piano roll + mapped export (`M2M-NOTES`, v2.1.0 — **FROZEN Oct 1**; 1/2-bar extents, map capo, ♯-fold view; eighth-cell 240-tick fix)
- `PROJECT.md` — Living project record: status snapshot, decision log, roadmap, and the rules for adding features. Read it first when picking up roadmap/feature work
- `docs/` — Web MIDI ensemble player (GitHub Pages, vanilla ESM; see "Web player" section below)
- `make-fixtures.py` + `tests/` — Golden-vector cross-language sync check (Python reference → JSON fixtures → `node tests/verify.mjs` asserts JS matches)
- `README.md` — Full documentation

## midi-from-merkle.py — Key Design Decisions

### Merkle Tree Descent
- Root = merkle root bytes (32 bytes)
- Left child: `SHA-256(node || 0x00)`, Right child: `SHA-256(node || 0x01)`
- Depth 5 → 32 leaves, left-to-right depth-first order
- Replaces simple bit-slicing; every leaf is a full 256-bit hash with uniform entropy

### Loop Length (first 2 bits of root)
- `00` = 1 bar (4 beats), `01` = 2 bars (8 beats), `10` = 4 bars (16 beats), `11` = 8 bars (32 beats)
- Powers of 2 for musical phrasing convention
- Derived directly from root, not from leaves (structural parameter independent from rhythm)

### Rhythm Mapping (first 11 bits of each leaf)
- Weighted duration table: shorter notes more probable, longer notes rarer
- Sixteenth (21.9%), Eighth (18.0%), Dotted eighth (14.1%), Quarter (12.1%), Eighth triplet (10.2%), Dotted quarter (8.2%), Half (8.2%), Dotted half (7.4%)

### Exact Bar Filling
- Notes placed sequentially until next note would overflow target
- Last note truncated to fill remaining space exactly
- Guarantees total duration == target bar count — no partial bars, clean looping
- **Protocol note:** `MIDI-PROTOCOL.md` §7.4 is authoritative and the script conforms
  (cyclic leaf reuse when exhausted; exact fills stop cleanly, never a zero-length note).
  Committed `.mid` files predate the patch and await regeneration when we choose.

### MIDI Output
- GM drum channel (channel 10, 0-indexed as 9), Acoustic Bass Drum (MIDI note 35)
- 120 BPM fixed, 80% duty cycle (20% gap between notes)
- No native MIDI loop flag — user toggles loop in their player
- File named `merkle_<first-8-chars-of-root>.mid`

### API & Caching
- Fetches latest BTC block from Blockstream API (`GET https://blockstream.info/api/blocks/tip`)
- Returns both `merkle_root` and `id` (block hash)
- Block hash displayed for reference only, not used in derivation
- Falls back to hardcoded default merkle root if API unreachable
- **File-existence check**: if output MIDI already exists, prints "No new block since last run" and exits
- Uses the MIDI file itself as cache — no separate state file

## Commands
```
python3 words-from-merkle.py [hex]     # generate 21-word phrase
python3 midi-from-merkle.py [hex]      # generate rhythmic MIDI
```
Requires: `pip install mido`

## Web player (docs/ — GitHub Pages app)

Vanilla ESM, no build step, dark-mode only, mobile-first. Serves from `docs/`
(Pages: Settings → Pages → Deploy from branch → `main` / `/docs`).
Spec contract: `MIDI-PROTOCOL.md` v1.0.2 (`M2M-RHYTHM`) + `MIDI-NOTES-PROTOCOL.md`
v2.1.0 (`M2M-NOTES`, FROZEN Oct 1); player semantics: render-time instrument
choice lives OUTSIDE the protocol (§11) — blocks always derive E(R) exactly.

| File | Role |
|---|---|
| `docs/js/protocol.js` | §2–§9 derivation (deriveLeaves, rootBitsToBarCount, leafToDuration, fillRhythmToTarget). DOM-free, Node-importable. Mirrors Python fn names. |
| `docs/js/smf.js` | §10 writer WITH running status → downloaded `.mid` is byte-identical to mido reference. Blob download, §10 naming. **v1.6: `writeEnsembleLoopBytes` (⤓ loop) — format 1 (named track per part) or format 0 (single interleaved), division 480, ONE tempo meta (audible BPM), ZERO program changes; `ENSEMBLE_MIDI_MAP` (owner template: lead ch 11 / bass 12 / organ 16; drums Ch13·Keys 36/38/42/46 ⇄ Ch1–4·Split same keys on ch 1–4), note-offs at 80% duty, ons ascending; `ensembleFileName` = `ensemble_<bars>b_<root8|seq>.mid`.** |
| `docs/js/api.js` | Blockstream on-request only: `fetchTip()`, `fetchByHeight(h)`. No polling. |
| `docs/js/synth.js` | 7 Web Audio 808-flavored voices (kick, snare, hats×2, lead, bass, organ). Trigger sig `(ctx,dest,time,dur,vel,midiNote)` — melodic voices consume the pitch resolved by the engine's melody-map layer. **v1.3.0 tone layer:** `TONE_SCHEMA`/`TONE_DEFAULTS` expose each melodic voice's existing constants as params (waveform ∈ 4 built-in osc types, filter cutoff/Q, attack/length cap/release, level; organ = 4 drawbar levels); `toneFor/setTone/resetTone` carry live state; defaults = original hard-coded sounds. **v1.5.0 ∿ modulation:** `getMods/setMods/clearMods/hasMods` store {rate, depth, lo, hi, phase} per slider (lo/hi/depth/phase reserved, defaults = full min↔max); `LFO_RATES` (1·½·♩·♪·♬ = steps/bar — BMP glyphs per v1.6 rule), `lfoCycleTicks`, scalar `modSample` + `attachModEdge` (sine osc → depth gain → AudioParam); triggers take optional 7th arg modCtx {tick, oscFor} |
| `docs/js/notes.js` | M2M-NOTES v2.1.0 implementation: `pitchByte` (disjoint bits 11–18), `deriveScaleParams` (root bits 2–15), degree→MIDI, `foldMidi`, map geometry (1/2/4/8/16-bar extents over a fixed 128-col store; 240-tick eighth cells), `deriveMelody()`, count-prefixed stack codec `encodeCells/decodeCells` (+ legacy v1 decode). Fixture-verified against Python. |
| `docs/js/seq.js` | v1.6 drum-sequencer geometry + codecs (pure, DOM-free): paint events on the **40-tick lattice** (`SEQ_UNIT`; straight 16ths 120t and eighth-triplets 160t coexist exactly), per-lane `ons[]`/`rests[]` (rest = window length in units) over `SEQ_UNITS_MAX=768` (16 bars); `paintStepsPerBar(sel,triplet)` (³ on ♩→6, ♪→12, 16 unavailable), `blockGhostTicks` (RAW exact or explicit quant grid), `laneTimeline` = (ghost ∪ ons) − rest windows, sorted; `encodeLanes/decodeLanes` (&f event codec) + `lanesFromLegacy` (v1.4 &d res-cell → lattice). Customary lane order = VOICES drums (kick ▸ snare ▸ hat·c ▸ hat·o, bottom→top). |
| `docs/js/engine.js` | Master clock (ticks = s×960, tempo = piecewise segments), 0.12 s lookahead scheduler. 7 slots × 1 block, mute flag (cursor-preserving), per-slot transpose, **LIVE `rotateOneStep()`** (parts travel with blocks — timing untouched), melody map `cells[col]` = pitch stacks over a FIXED 128-col store (`paintCell`/`eraseCellPitch` guarded to the active extent; `setMapBars` changes only the looping window — shrink hides the tail, grow restores; `setPolyphony` truncates on off; `mapOffset` capo on sounding painted pitches only), `_pitchStackFor()` (painted+capo stack → source switch → transpose fold; map loops at its extent, synced across parts). Phase policy parameterized (`anchorTick` 0 = anchored; head-start entry); `resyncAllToTop()`; modes independent/master. cycleLen COMPUTED — never hardcoded. **v1.3.0: ONE global reverb knob — `setReverb(0–1)` on a post-compressor send through a synthesized decaying-noise IR (stereo, cached per ctx, no audio asset); whole mix incl. drums; live while playing.** **v1.6 drum ribbons — `seq {sel, triplet, bars, blockQuant, modes, lanes, cursors}`; paint dial = writing-snap ONLY (setPaintSel/setTriplet never touch stored events — FROZEN), block timing separate (setBlockQuant: 0 raw sacrosanct | 480 | 240 | 120); lane mode rhythm ▸ seq; `_seqTimeline` = merged sorted events (lazy, `_seqDirty` flags, invalidated on paint/bars/blockQuant/slot changes); `_scheduleSeq` walks {rep, idx} cursors over the timeline with `_seqRephase` on any grid change; standalone lanes sound (no part needed); seqClearSteps().** **v1.5.0 LFO service — `_lfo(rateSteps)` spawns ONE shared sine oscillator per rate, phase origin = transport tick 0 (start(startTime)), frequency = tps/cycleTicks so it is musically locked; `_resyncLfos()` retunes at every tempo-commit boundary; `_killLfos()` on stop(); modCtx handed to melodic triggers only when `hasMods` — zero cost otherwise.** |
| `docs/js/state.js` | `?v=1&b=height~root64,...&s=slotmap&m=ind|master[&t=][&u=][&p=cells-b64][&q=1|2|4|8|16][&o=p][&h=±capo][&g=m][&e=paint steps/bar incl 6·12][&w=³][&j=seq bars][&k=blockquant ticks][&i=rr|ss.. lane modes][&d|f=drum payloads]` + localStorage mirror. Full roots + map + drum-seq stored → restore derives locally, zero API calls; trailing-empty trim keeps payloads compact; legacy v1 `&p` (64 flat bytes, no `&q`) still decodes; **legacy v1.4 `&d` res-cell arrays auto-remap onto the 40-tick lattice via `lanesFromLegacy`; v1.6 links write `&f` events**; seq-less legacy links get default raw lanes. **Sound settings deliberately NOT here — tone/reverb/favorites/mods are local-only (`tonebank.js`), share links stay arrangement-only. LS_KEY = `m2m-session-v1` (v1.5.0): silently migrates once from the pre-1.5 glyph-corrupted `m2m-rhyth…n-v1` constant.** |
| `docs/js/tonebank.js` | Sound-layer persistence (`m2m-tones-v1` localStorage — clean key since v1.5.0; one-time silent migration from the pre-1.5 `m2m-ton…s-v1` glyph-corrupted constant, no user data lost): live per-voice tone params, **v1.5 ∿ mod state per voice ({rate} required; depth/lo/hi/phase clamped & preserved when present — reserved for future min/max markers)**, named favorites per voice (cap 8, reload one at a time; **favorites capture mods too**), global reverb level. Schema-clamped sanitize on load AND on store; private-mode-safe. |
| `docs/js/ui.js`, `index.html`, `styles.css` | Slots grid + shelf (max 8 blocks; **shelf-by-default** — manual fetches never auto-assign, only first-load demo + LIVE arrivals), drag AND tap-select→tap-slot move, **per-block ▾ assign dropdown (occupied target evicts to shelf)**, **LIVE toggle** (60 s poll while armed, evict-oldest, arrival-only rotation, any manual placement disarms), **snapshots** (named, localStorage, cap 20, appVersion-stamped), **melody map piano roll** (canvas: time→right eighths, pitch↑down 2-octave window + 8vb shifter, drag-paint brush with interpolation, right-drag erase, 1/2/4/8/16-bar extent selector, map capo −1/±0/+1, ♯-fold toggle (view-only), chords checkbox, fill-from-block, clear, source switch), transport bar (play/stop, mode, ⟲ re-align, BPM box, **reverb slider (whole mix, one knob)**, copy link, **two-click ✕ CLEAR** — unassign all to shelf, keeps collection/map/tempo), height fetch + "get latest", per-block ⤓ `.mid` (canonical) + ⤓ `notes` (mapped export). **v1.3.0 "sound" button per melodic slot** — tone panel opens as an INSTRUMENT POPUP anchored under the slot (v1.3.1: `position: absolute`, width `clamp(310px, 70vw, 620px)` = ≥2 card widths so drawbars slide comfortably, max-height 68vh scroll, viewport-clamped by `positionTonePopup()`, ✕/Esc close, transport z-40 stays above it); schema-driven sliders/enum + favorites save/use/✕ + reset; slider input writes live synth params + tonebank, NEVER calls render() mid-drag; slot drag disabled while panel open; `.actions` row wraps so mute/sound/unassign can't overflow the card. **v1.6 drum-sequencer section** (canvas ribbons: 4 lanes, kick row at bottom; TWO split dials — paint seg `1 · ½ · ♩ · ♪ · ♬` + **³ toggle** (writing-snap ONLY, never moves stored notes; ³ = ♩³/♪³ only, ♬ hidden) and **block selector `raw | ¼ | ⅛ | 1/16`** (raw = exact §7.4 onsets, sacrosanct default); tap cycles hit ▸ rest ▸ clear, stroke paints the target, right-drag clears, gutter SEQ/raw pill flips the lane + auto-arm on paint; timeline drawing shows EXACT positions — magenta cell = painted, cyan sliver = block hit at true tick, red window = rest; seq lanes badge "· seq" on the slot card; clear-steps button zeroes events, block untouched). **⤓ loop button** (transport) opens a download popup: Type 0/1 toggle + drums Ch13·Keys ⇄ Ch1–4·Split toggle + summary line → writes the whole audible ensemble as `ensemble_<bars>b_<root8>.mid`. **v1.5.0 ∿ modulation in the tone popup:** per-slider right-click (desktop) / 500 ms long-press (touch, drag-cancelled, double-fire-guarded) toggles oscillation of that dial's full min↔max span; ∿ cycle seg (1 · ½ · ♩ · ♪ · ♬) retimes all of that voice's mods live; modulated rows render magenta with ∿ label; reset clears mods; favorites capture mods. SNAP_KEY = `m2m-snapshots-v1`, silently migrated from pre-1.5 `m2m…s-v1` glyph key. iOS: AudioContext created inside Play gesture. |
| `docs/js/version.js` | `APP_VERSION` single source (player semver: MAJOR = breaking session/export semantics, MINOR = features, PATCH = fixes). Shown in header tag, stamped into snapshots. |

**Cross-language sync check (the protocol made this mechanical):**
- `make-fixtures.py` (needs mido — run under the venv or `pip install mido`):
  generates `tests/fixtures.json` = 6 golden vectors from the Python reference
  (1/2/4-bar, 8-bar truncating, 8-bar WRAPPED, 2-bar EXACT-FILL edge) + rhythm SMF byte
  reference + **M2M-NOTES layer per fixture** (scale params, pitchBytes, melody32) +
  mapped-SMF byte reference for the wrapped root.
- `node tests/verify.mjs` → asserts JS E(R)/melody + both SMF writers match fixtures.
  Current status: **PASS, 98/98 checks** (M2M-RHYTHM/1.0.2 + M2M-NOTES/2.0.0).
- App smoke: all 13 assets serve 200 over `python3 -m http.server -d docs 8123`
  (localhost = secure context, WebCrypto OK); modules import clean in Node;
  ui.js syntax-checked. Desktop-browser interactive pass NOT yet done (no browser
  connected in session) — do one visual check on a phone/desktop after deploy.

**Useful environment bits:**
- venv with mido: `/private/var/folders/tl/5jxw_v5n7h3830kxhch81yd80000gp/T/opencode/.venv-m2m/bin/python` (temp; recreate with `python3 -m venv && pip install mido` if gone).
- Both Python scripts patched & verified against protocol (§7.4 cyclic reuse + no zero-length notes); `midi-files/`/`notes-midi/` archives intentionally untouched (regeneration deferred by user).
- Uncommitted so far (user hasn't asked for commits): protocol doc, script patches, web player, fixtures.

## Python Version
Compatible with Python 3.9+. Uses `Optional[Tuple, List]` typing (not `str | None` syntax).
