#!/usr/bin/env python3
"""
notes-from-merkle.py
--------------------
Converts a Bitcoin merkle root (256-bit hex value) into a pitched MIDI melody
using merkle tree descent to derive leaf hashes.

HOW IT WORKS:
-------------
1. Takes a 64-char hex merkle root (or fetches the latest BTC block's merkle root)
2. Derives 2^D leaf hashes via binary tree descent:
   - Left child:  SHA-256(node_bytes || 0x00)
   - Right child: SHA-256(node_bytes || 0x01)
   - Recurses to depth D (default 5), yielding 32 leaves
3. The first 2 bits of the merkle root determine loop length (1, 2, 4, or 8 bars)
4. Each leaf yields both a duration and a pitch:
   - Bits 0-10 (11 bits) → note duration via weighted lookup table
   - Bits 11-18 (8 bits, 0-255) → scale degree via modular reduction
5. Scale parameters derived from merkle root:
   - Bit 2: octave range (0 = 1 octave [0-7], 1 = 2 octaves [0-14])
   - Bits 3-5: mode index (Ionian, Dorian, Phrygian, Lydian, Mixolydian, Aeolian, Locrian, Chromatic)
   - Bits 6-10: root note (5 bits mod 12 → C through B)
   - Next byte: base octave (byte mod 3 + 2 → octaves 2, 3, or 4)
6. Notes are placed sequentially, filling the target bar count exactly
   - If the last note would overflow, it is truncated to fill remaining space
   - If the 32 leaves run out first (8-bar loops), the duration/pitch sequence
     cycles from leaf 0 (leaf[i mod 32]) until the target is filled exactly
     (rhythm rules normative in MIDI-PROTOCOL.md §7.4; see MIDI-PROTOCOL.md
     Appendix A — M2M-NOTES is not yet spec-frozen)
7. Output uses Acoustic Grand Piano (GM program 0, channel 0)
8. Exports as a MIDI file at 120 BPM, 80% duty cycle

MODES:
------
Index | Mode       | Semitone intervals from root
------|------------|----------------------------
  0   | Ionian     | 0, 2, 4, 5, 7, 9, 11
  1   | Dorian     | 0, 2, 3, 5, 7, 9, 10
  2   | Phrygian   | 0, 1, 3, 5, 7, 8, 10
  3   | Lydian     | 0, 2, 4, 6, 7, 9, 11
  4   | Mixolydian | 0, 2, 4, 5, 7, 9, 10
  5   | Aeolian    | 0, 2, 3, 5, 7, 8, 10
  6   | Locrian    | 0, 1, 3, 5, 6, 8, 10
  7   | Chromatic  | 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11

CLI:
----
python3 notes-from-merkle.py                          # fully deterministic
python3 notes-from-merkle.py <64-char-hex-string>     # specific merkle root
python3 notes-from-merkle.py --mode dorian             # override mode
python3 notes-from-merkle.py --mode phrygian --root E  # override mode + root
"""

import sys
import json
import hashlib
import urllib.request
from pathlib import Path
from typing import Optional, Tuple, List

try:
    import mido
except ImportError:
    print("Error: 'mido' library is required. Install it with: pip install mido")
    sys.exit(1)


# ── Constants ────────────────────────────────────────────────────────────────

NOTES_OUTPUT_DIR = "notes-midi"

MERKLE_ROOT_HEX_LENGTH = 64

DEFAULT_DEPTH = 5
NUM_LEAVES = 2 ** DEFAULT_DEPTH

LATEST_BLOCK_API = "https://blockstream.info/api/blocks/tip"

DEFAULT_MERKLE_ROOT = "2e0f4eb72a525d443b731dce006d728a2f3575768a9e475fc1b4c66016475600"

TEMPO_BPM = 120
MICROSECONDS_PER_BEAT = int(60_000_000 / TEMPO_BPM)

TICKS_PER_QUARTER = 480

DUTY_CYCLE = 0.8

NOTE_VELOCITY = 80

DURATION_TABLE = [
    ("sixteenth",        TICKS_PER_QUARTER // 4,   0,    447),
    ("eighth",           TICKS_PER_QUARTER // 2,   448,  815),
    ("dotted eighth",    int(TICKS_PER_QUARTER * 0.75), 816,  1103),
    ("quarter",          TICKS_PER_QUARTER,        1104, 1351),
    ("eighth triplet",   int(TICKS_PER_QUARTER * 2 / 3), 1352, 1559),
    ("dotted quarter",   int(TICKS_PER_QUARTER * 1.5), 1560, 1727),
    ("half",             TICKS_PER_QUARTER * 2,    1728, 1895),
    ("dotted half",      int(TICKS_PER_QUARTER * 3),   1896, 2047),
]

MODES = {
    "ionian":     [0, 2, 4, 5, 7, 9, 11],
    "dorian":     [0, 2, 3, 5, 7, 9, 10],
    "phrygian":   [0, 1, 3, 5, 7, 8, 10],
    "lydian":     [0, 2, 4, 6, 7, 9, 11],
    "mixolydian": [0, 2, 4, 5, 7, 9, 10],
    "aeolian":    [0, 2, 3, 5, 7, 8, 10],
    "locrian":    [0, 1, 3, 5, 6, 8, 10],
    "chromatic":  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
}

MODE_ORDER = ["ionian", "dorian", "phrygian", "lydian", "mixolydian", "aeolian", "locrian", "chromatic"]

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


# ── Block fetching ───────────────────────────────────────────────────────────

def fetch_latest_block() -> Tuple[Optional[str], Optional[str], Optional[int]]:
    try:
        print(f"Fetching latest BTC block from:\n  {LATEST_BLOCK_API}\n")
        req = urllib.request.Request(LATEST_BLOCK_API)
        req.add_header("User-Agent", "merkle-to-words/1.0")
        with urllib.request.urlopen(req, timeout=10) as response:
            blocks = json.loads(response.read().decode("utf-8"))
            if blocks and "merkle_root" in blocks[0] and "id" in blocks[0] and "height" in blocks[0]:
                return blocks[0]["merkle_root"], blocks[0]["id"], blocks[0]["height"]
    except Exception as e:
        print(f"Could not fetch latest block: {e}")
    return None, None, None


# ── Merkle tree descent ──────────────────────────────────────────────────────

def derive_leaves(merkle_root_hex: str, depth: int = DEFAULT_DEPTH) -> List[str]:
    root_bytes = bytes.fromhex(merkle_root_hex)

    def descend(node_bytes: bytes, current_depth: int) -> List[str]:
        if current_depth == depth:
            return [node_bytes.hex()]

        left_bytes = hashlib.sha256(node_bytes + b"\x00").digest()
        right_bytes = hashlib.sha256(node_bytes + b"\x01").digest()

        return descend(left_bytes, current_depth + 1) + descend(right_bytes, current_depth + 1)

    return descend(root_bytes, 0)


# ── Loop length determination ────────────────────────────────────────────────

def root_bits_to_bar_count(merkle_root_hex: str) -> Tuple[int, int, str]:
    first_byte = int(merkle_root_hex[:2], 16)
    first_two_bits = first_byte >> 6
    bar_map = {0: 1, 1: 2, 2: 4, 3: 8}
    bars = bar_map[first_two_bits]
    bits_str = f"{first_two_bits:02b}"
    return bars, bars * 4, bits_str


# ── Duration mapping ─────────────────────────────────────────────────────────

def leaf_to_duration(leaf_hex: str) -> Tuple[str, int]:
    leaf_bytes = bytes.fromhex(leaf_hex)
    first_byte = leaf_bytes[0]
    second_byte = leaf_bytes[1]
    index = (first_byte << 3) | (second_byte >> 5)

    for name, ticks, min_idx, max_idx in DURATION_TABLE:
        if min_idx <= index <= max_idx:
            return name, ticks

    return DURATION_TABLE[-1][0], DURATION_TABLE[-1][1]


# ── Pitch extraction ─────────────────────────────────────────────────────────

def leaf_to_pitch_byte(leaf_hex: str) -> int:
    leaf_bytes = bytes.fromhex(leaf_hex)
    first_byte = leaf_bytes[0]
    second_byte = leaf_bytes[1]
    bits_11_to_18 = ((first_byte & 0x07) << 5) | (second_byte >> 3)
    return bits_11_to_18


# ── Scale parameter derivation ───────────────────────────────────────────────

def derive_scale_params(merkle_root_hex: str) -> dict:
    root_bytes = bytes.fromhex(merkle_root_hex)
    first_byte = root_bytes[0]
    second_byte = root_bytes[1]
    third_byte = root_bytes[2]

    bit_2 = (first_byte >> 5) & 0x01
    mode_index = (first_byte >> 2) & 0x07
    root_note_index = ((first_byte & 0x03) << 3) | (second_byte >> 5)
    base_octave = (second_byte & 0x1F) % 3 + 2

    octave_range = 1 if bit_2 == 0 else 2
    scale_size = 8 if octave_range == 1 else 15

    mode_name = MODE_ORDER[mode_index]
    root_note_name = NOTE_NAMES[root_note_index % 12]

    return {
        "octave_range": octave_range,
        "scale_size": scale_size,
        "mode_index": mode_index,
        "mode_name": mode_name,
        "mode_intervals": MODES[mode_name],
        "root_note_index": root_note_index % 12,
        "root_note_name": root_note_name,
        "base_octave": base_octave,
    }


def scale_degree_to_midi(degree: int, scale_params: dict) -> int:
    intervals = scale_params["mode_intervals"]
    base_octave = scale_params["base_octave"]
    root_note_index = scale_params["root_note_index"]

    is_chromatic = scale_params["mode_name"] == "chromatic"

    if is_chromatic:
        interval = intervals[degree % 12]
        octave_offset = 12 * (degree // 12)
    else:
        interval = intervals[degree % 7]
        octave_offset = 12 * (degree // 7)

    root_midi = (base_octave + 1) * 12 + root_note_index
    return root_midi + interval + octave_offset


# ── Rhythm filling ───────────────────────────────────────────────────────────

def fill_rhythm_to_target(
    durations: List[Tuple[str, int]],
    target_ticks: int
) -> List[Tuple[str, int, bool]]:
    """
    Fill notes sequentially until the target is reached exactly.

    Follows MIDI-PROTOCOL.md §7.4 (same rules as the drum rhythm pipeline):

    - Placement walks the periodic sequence durations[i % L]. If the 32 leaves
      run out before the target is filled (common for 8-bar loops), placement
      wraps around to the first leaf and continues.
    - Truncation rule: the first note whose duration would overflow the
      remaining space is truncated to fill it exactly and terminates the
      sequence.
    - Exact rule: a note landing exactly on the target terminates the sequence
      un-truncated. A zero-length note is never appended.

    Guarantees: sum of returned tick counts == target_ticks exactly.
    """
    notes = []
    accumulated = 0
    n = len(durations)

    if n == 0:
        return notes

    i = 0
    while accumulated < target_ticks:
        name, ticks = durations[i % n]
        remaining = target_ticks - accumulated

        if ticks > remaining:
            # Note would overflow — truncate to fill remaining space exactly
            notes.append((name, remaining, True))
            break
        else:
            # Note fits within the remaining space — use it as-is
            notes.append((name, ticks, False))
            accumulated += ticks

        i += 1

    return notes


# ── MIDI generation ──────────────────────────────────────────────────────────

def generate_midi(
    notes: List[Tuple[str, int, bool, int]],
    output_path: str
):
    mid = mido.MidiFile(ticks_per_beat=TICKS_PER_QUARTER)
    track = mido.MidiTrack()
    mid.tracks.append(track)

    track.append(mido.MetaMessage("set_tempo", tempo=MICROSECONDS_PER_BEAT, time=0))
    track.append(mido.Message("program_change", channel=0, program=0, time=0))

    for name, total_ticks, was_truncated, midi_note in notes:
        note_on_ticks = int(total_ticks * DUTY_CYCLE)
        gap_ticks = total_ticks - note_on_ticks

        track.append(mido.Message(
            "note_on",
            note=midi_note,
            velocity=NOTE_VELOCITY,
            channel=0,
            time=0
        ))

        track.append(mido.Message(
            "note_off",
            note=midi_note,
            velocity=0,
            channel=0,
            time=note_on_ticks
        ))

        if gap_ticks > 0:
            track.append(mido.Message(
                "note_off",
                note=midi_note,
                velocity=0,
                channel=0,
                time=gap_ticks
            ))

    mid.save(output_path)
    print(f"\nMIDI file saved to: {output_path}")


# ── Display ──────────────────────────────────────────────────────────────────

def display_results(
    merkle_root_hex: str,
    block_hash: str,
    bar_count: int,
    target_beats: int,
    first_two_bits: str,
    notes: List[Tuple[str, int, bool, int]],
    leaves: List[str],
    scale_params: dict,
):
    print("=" * 70)
    print("MERKLE ROOT → PITCHED MIDI MELODY (merkle tree descent)")
    print("=" * 70)
    print(f"\nInput merkle root:\n  {merkle_root_hex}")
    print(f"Block hash (reference):\n  {block_hash}\n")

    print(f"Loop length: first 2 bits = '{first_two_bits}' → {bar_count} bar(s) ({target_beats} beats)")
    print(f"Tree depth: {DEFAULT_DEPTH}")
    print(f"Leaves derived: {len(leaves)}\n")

    print("Scale parameters:")
    print(f"  Mode:       {scale_params['mode_name']} (index {scale_params['mode_index']})")
    print(f"  Root note:  {scale_params['root_note_name']}")
    print(f"  Base octave: {scale_params['base_octave']}")
    print(f"  Octave range: {scale_params['octave_range']} ({scale_params['scale_size']} degrees)\n")

    notes_used = len(notes)
    last_truncated = notes[-1][2] if notes else False
    truncated_note = " (last note truncated to fit)" if last_truncated else ""
    wrapped = notes_used - len(leaves)
    wrap_note = f" (cycled {wrapped} wrapped)" if wrapped > 0 else ""
    print(f"Notes used: {notes_used} of {len(leaves)}{wrap_note}{truncated_note}\n")

    print("Leaf hashes (first 16 chars) → Duration → Scale degree → MIDI note:")
    print("-" * 85)
    for i, (name, ticks, was_truncated, midi_note) in enumerate(notes, start=1):
        leaf = leaves[(i - 1) % len(leaves)]
        leaf_short = leaf[:16]
        beats = ticks / TICKS_PER_QUARTER
        marker = " ← truncated" if was_truncated else (" ← wrapped" if i > len(leaves) else "")
        note_name = NOTE_NAMES[midi_note % 12]
        note_octave = (midi_note // 12) - 1
        print(f"  {i:>2}. {leaf_short}... → {name:<16} ({beats:.3g} beats) → {note_name}{note_octave} (MIDI {midi_note}){marker}")

    total_beats = sum(t for _, t, _, _ in notes) / TICKS_PER_QUARTER
    total_bars = total_beats / 4
    print(f"\nTotal duration: {total_beats:.2f} beats ({total_bars:.2f} bars in 4/4)")


# ── CLI parsing ──────────────────────────────────────────────────────────────

def parse_args(argv: List[str]) -> Tuple[Optional[str], Optional[str], Optional[str]]:
    mode_override = None
    root_override = None
    merkle_arg = None

    i = 0
    while i < len(argv):
        if argv[i] == "--mode" and i + 1 < len(argv):
            mode_override = argv[i + 1].strip().lower()
            if mode_override not in MODES:
                print(f"Error: unknown mode '{mode_override}'. Choose from: {', '.join(MODES.keys())}")
                sys.exit(1)
            i += 2
        elif argv[i] == "--root" and i + 1 < len(argv):
            root_override = argv[i + 1].strip().upper()
            if root_override not in NOTE_NAMES:
                print(f"Error: unknown root note '{root_override}'. Choose from: {', '.join(NOTE_NAMES)}")
                sys.exit(1)
            i += 2
        else:
            merkle_arg = argv[i].strip().lower()
            i += 1

    return merkle_arg, mode_override, root_override


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    merkle_arg, mode_override, root_override = parse_args(sys.argv[1:])

    block_hash = "N/A"
    block_height = None

    if merkle_arg is not None:
        merkle_root_hex = merkle_arg
        block_hash = "N/A"
        block_height = None
        print(f"Using merkle root from command line argument.")
    else:
        merkle_root_hex, block_hash, block_height = fetch_latest_block()
        if merkle_root_hex is None:
            print(f"Could not fetch latest block. Falling back to default merkle root.")
            merkle_root_hex = DEFAULT_MERKLE_ROOT
            block_hash = "N/A"
            block_height = None
        else:
            print(f"Using latest BTC block merkle root.")

    if len(merkle_root_hex) != MERKLE_ROOT_HEX_LENGTH:
        raise ValueError(
            f"Expected a {MERKLE_ROOT_HEX_LENGTH}-character hex string, "
            f"got {len(merkle_root_hex)} characters."
        )
    int(merkle_root_hex, 16)

    scale_params = derive_scale_params(merkle_root_hex)

    if mode_override is not None:
        scale_params["mode_name"] = mode_override
        scale_params["mode_intervals"] = MODES[mode_override]
        scale_params["mode_index"] = MODE_ORDER.index(mode_override)

    if root_override is not None:
        scale_params["root_note_name"] = root_override
        scale_params["root_note_index"] = NOTE_NAMES.index(root_override)

    bar_count, target_beats, first_two_bits = root_bits_to_bar_count(merkle_root_hex)

    mode_name = scale_params["mode_name"]
    root_note_name = scale_params["root_note_name"]

    suffix = f"merkle_{merkle_root_hex[:8]}_{root_note_name.lower()}_{mode_name}_{bar_count}_bar"

    if block_height is not None:
        output_name = f"{block_height}_{suffix}.mid"
    else:
        output_name = f"{suffix}.mid"

    notes_dir = Path(NOTES_OUTPUT_DIR)
    notes_dir.mkdir(exist_ok=True)

    output_path = notes_dir / output_name

    if output_path.exists():
        print(f"\nNo new block since last run. MIDI file already exists: {output_path}")
        print(f"Delete the file or use a different merkle root to regenerate.")
        sys.exit(0)

    print(f"\nDeriving {NUM_LEAVES} leaf hashes via merkle tree descent (depth={DEFAULT_DEPTH})...")
    leaves = derive_leaves(merkle_root_hex, DEFAULT_DEPTH)

    durations = [leaf_to_duration(leaf) for leaf in leaves]
    pitch_bytes = [leaf_to_pitch_byte(leaf) for leaf in leaves]
    scale_degrees = [pb % scale_params["scale_size"] for pb in pitch_bytes]

    target_ticks = target_beats * TICKS_PER_QUARTER

    rhythm_notes = fill_rhythm_to_target(durations, target_ticks)

    # Wrap-aware assembly: note i derives from leaf[i % 32] (MIDI-PROTOCOL.md §7.4),
    # so its scale degree must come from the same wrapped leaf, not zip-truncated 1:1.
    notes = []
    for i, (name, ticks, was_truncated) in enumerate(rhythm_notes):
        degree = scale_degrees[i % len(scale_degrees)]
        midi_note = scale_degree_to_midi(degree, scale_params)
        notes.append((name, ticks, was_truncated, midi_note))

    display_results(
        merkle_root_hex, block_hash, bar_count, target_beats,
        first_two_bits, notes, leaves, scale_params
    )

    generate_midi(notes, str(output_path))


if __name__ == "__main__":
    main()
