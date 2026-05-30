# merkle-to-words — Agent Context

## Project Overview
Tools for converting a Bitcoin merkle root (256-bit hash) into human-readable words and rhythmic MIDI patterns.

## Files
- `merkle_to_words.py` — Converts merkle root to 21-word BIP-39 phrase
- `merkle_to_midi.py` — Converts merkle root to rhythmic MIDI via merkle tree descent
- `README.md` — Full documentation

## merkle_to_midi.py — Key Design Decisions

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
python3 merkle_to_words.py [hex]     # generate 21-word phrase
python3 merkle_to_midi.py [hex]      # generate rhythmic MIDI
```
Requires: `pip install mido`

## Python Version
Compatible with Python 3.9+. Uses `Optional[Tuple, List]` typing (not `str | None` syntax).
