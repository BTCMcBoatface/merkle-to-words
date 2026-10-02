# merkle-to-words — Agent Context

## Project Overview
Tools for converting a Bitcoin merkle root (256-bit hash) into human-readable words and rhythmic MIDI patterns.

## Files
- `words-from-merkle.py` — Converts merkle root to 21-word BIP-39 phrase
- `midi-from-merkle.py` — Converts merkle root to rhythmic MIDI via merkle tree descent
- `notes-from-merkle.py` — Converts merkle root to pitched MIDI melody; shares the MIDI-PROTOCOL.md §7.4 rhythm engine and implements the now-frozen M2M-NOTES v1.0.0 pitch rules (disjoint bits 11–18)
- `MIDI-PROTOCOL.md` — Canonical cross-language spec for the MIDI pipeline (v1.0.2, `M2M-RHYTHM`); the contract Python and future JS implementations must both conform to
- `MIDI-NOTES-PROTOCOL.md` — Pitched layer + shoehorn pitch map + mapped export (`M2M-NOTES`, v1.0.0 — **FROZEN Oct 1**; OP1 bit-overlap fixed, all rulings in, 98-check fixtures)
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
v1.0.0 (`M2M-NOTES`, FROZEN Oct 1); player semantics: render-time instrument
choice lives OUTSIDE the protocol (§11) — blocks always derive E(R) exactly.

| File | Role |
|---|---|
| `docs/js/protocol.js` | §2–§9 derivation (deriveLeaves, rootBitsToBarCount, leafToDuration, fillRhythmToTarget). DOM-free, Node-importable. Mirrors Python fn names. |
| `docs/js/smf.js` | §10 writer WITH running status → downloaded `.mid` is byte-identical to mido reference. Blob download, §10 naming. |
| `docs/js/api.js` | Blockstream on-request only: `fetchTip()`, `fetchByHeight(h)`. No polling. |
| `docs/js/synth.js` | 7 Web Audio 808-flavored voices (kick, snare, hats×2, lead, bass, organ). Trigger sig `(ctx,dest,time,dur,vel,midiNote)` — melodic voices consume the pitch resolved by the engine's melody-map layer. |
| `docs/js/notes.js` | M2M-NOTES v1.0.0 implementation: `pitchByte` (disjoint bits 11–18), `deriveScaleParams` (root bits 2–15), degree→MIDI, `foldMidi` 21–108, grid constants, `deriveMelody()`. Fixture-verified against Python. |
| `docs/js/engine.js` | Master clock (ticks = s×960, tempo = piecewise segments), 0.12 s lookahead scheduler. 7 slots × 1 block, mute flag (cursor-preserving), per-slot transpose, **LIVE `rotateOneStep()`** (parts travel with blocks — timing untouched), melody-map `_pitchFor()` (painted cell → source switch → transpose fold). Phase policy parameterized (`anchorTick` 0 = anchored; head-start entry); `resyncAllToTop()`; modes independent/master. cycleLen COMPUTED — never hardcoded. |
| `docs/js/state.js` | `?v=1&b=height~root64,...&s=slotmap&m=ind|master[&t=][&u=][&p=b64url-map][&g=m]` + localStorage mirror. Full roots + map stored → restore derives locally, zero API calls. |
| `docs/js/ui.js`, `index.html`, `styles.css` | Slots grid + shelf (max 8 blocks, 8th parks on shelf), drag AND tap-select→tap-slot move, **LIVE toggle** (60 s poll while armed, evict-oldest, arrival-only rotation, any manual placement disarms), **snapshots** (named, localStorage, cap 20), **melody-map paint panel** (palette + fill-from-block + clear + source switch), transport bar (play/stop, mode, ⟲ re-align, BPM box, copy link, ✕ reset), height fetch + "get latest", per-block ⤓ `.mid` (canonical) + ⤓ `notes` (mapped export). iOS: AudioContext created inside Play gesture. |

**Cross-language sync check (the protocol made this mechanical):**
- `make-fixtures.py` (needs mido — run under the venv or `pip install mido`):
  generates `tests/fixtures.json` = 6 golden vectors from the Python reference
  (1/2/4-bar, 8-bar truncating, 8-bar WRAPPED, 2-bar EXACT-FILL edge) + rhythm SMF byte
  reference + **M2M-NOTES layer per fixture** (scale params, pitchBytes, melody32) +
  mapped-SMF byte reference for the wrapped root.
- `node tests/verify.mjs` → asserts JS E(R)/melody + both SMF writers match fixtures.
  Current status: **PASS, 98/98 checks** (M2M-RHYTHM/1.0.2 + M2M-NOTES/1.0.0).
- App smoke: all 10 assets serve 200 over `python3 -m http.server -d docs 8123`
  (localhost = secure context, WebCrypto OK); modules import clean in Node;
  ui.js syntax-checked. Desktop-browser interactive pass NOT yet done (no browser
  connected in session) — do one visual check on a phone/desktop after deploy.

**Useful environment bits:**
- venv with mido: `/private/var/folders/tl/5jxw_v5n7h3830kxhch81yd80000gp/T/opencode/.venv-m2m/bin/python` (temp; recreate with `python3 -m venv && pip install mido` if gone).
- Both Python scripts patched & verified against protocol (§7.4 cyclic reuse + no zero-length notes); `midi-files/`/`notes-midi/` archives intentionally untouched (regeneration deferred by user).
- Uncommitted so far (user hasn't asked for commits): protocol doc, script patches, web player, fixtures.

## Python Version
Compatible with Python 3.9+. Uses `Optional[Tuple, List]` typing (not `str | None` syntax).
