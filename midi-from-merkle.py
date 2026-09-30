#!/usr/bin/env python3
"""
midi-from-merkle.py
-------------------
Converts a Bitcoin merkle root (256-bit hex value) into a rhythmic MIDI pattern
using merkle tree descent to derive leaf hashes.

HOW IT WORKS:
-------------
1. Takes a 64-char hex merkle root (or fetches the latest BTC block's merkle root)
2. Derives 2^D leaf hashes via binary tree descent:
   - Left child:  SHA-256(node_bytes || 0x00)
   - Right child: SHA-256(node_bytes || 0x01)
   - Recurses to depth D (default 5), yielding 32 leaves
3. The first 2 bits of the merkle root determine loop length (1, 2, 4, or 8 bars)
4. Each leaf's first 11 bits map to a note duration via a weighted lookup table
5. Notes are placed sequentially, filling the target bar count exactly
   - If the last note would overflow, it is truncated to fill remaining space
   - If the 32 leaves run out first (8-bar loops), the duration sequence
     cycles from leaf 0 until the target is filled exactly
   - This guarantees the MIDI loops cleanly with no partial bars
     (normative rules: MIDI-PROTOCOL.md §7.4)
6. Output uses GM drum channel (channel 10) with Acoustic Bass Drum (MIDI 35)
7. Exports as a MIDI file at 120 BPM, 80% duty cycle

DESIGN DECISIONS:
-----------------
- Percussion (not pitched): Uses GM drum channel so notes map to drum sounds.
  Acoustic Bass Drum (note 35) gives a clean, punchy rhythmic feel.
- Loop length from root bits: First 2 bits → powers of 2 (1, 2, 4, 8 bars).
  This follows musical phrasing convention and avoids awkward odd-bar loops.
- Last-note truncation: Guarantees exact bar count for clean looping.
  Without this, the rhythm would end mid-bar and loop awkwardly.
- Cyclic leaf reuse (MIDI-PROTOCOL.md §7.4): an 8-bar loop often needs more
  than 32 notes; exhausted leaves wrap around (leaf[i mod 32]) until the
  target is filled exactly. Exact fills stop cleanly — never a zero-length note.
- Fixed tempo/time signature: No merkle bits consumed for structural parameters.
  Tempo is always 120 BPM, time signature is always 4/4.
- API fallback: Fetches latest BTC block by default, falls back to hardcoded
  merkle root if the API is unreachable. Works both online and offline.
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

# Directory where MIDI files are saved
MIDI_OUTPUT_DIR = "midi-files"

# A merkle root is always 64 hex characters (256 bits)
MERKLE_ROOT_HEX_LENGTH = 64

# Tree depth for merkle descent: 2^5 = 32 leaves
DEFAULT_DEPTH = 5
NUM_LEAVES = 2 ** DEFAULT_DEPTH  # 32

# Blockstream API for fetching the latest Bitcoin block
# Returns JSON array of recent blocks, each with 'id' (block hash) and 'merkle_root'
LATEST_BLOCK_API = "https://blockstream.info/api/blocks/tip"

# Fallback merkle root if API is unreachable
DEFAULT_MERKLE_ROOT = "2e0f4eb72a525d443b731dce006d728a2f3575768a9e475fc1b4c66016475600"

# Fixed tempo: 120 BPM
# At 120 BPM, one beat = 500,000 microseconds
TEMPO_BPM = 120
MICROSECONDS_PER_BEAT = int(60_000_000 / TEMPO_BPM)

# MIDI drum channel: channel 9 (0-indexed) = channel 10 in GM spec
# Notes on this channel map to percussion sounds, not pitched instruments
MIDI_DRUM_CHANNEL = 9

# Acoustic Bass Drum (GM percussion key 35)
# Chosen for a clean, punchy rhythmic hit that works well for pattern playback
MIDI_DRUM_NOTE = 35

# Note velocity (0-127): 80 gives a solid mid-level hit
NOTE_VELOCITY = 80

# Duty cycle: note sounds for 80% of its duration, 20% gap
# This creates a percussive, non-legato feel with space between hits
DUTY_CYCLE = 0.8

# MIDI timing: mido default resolution = 480 ticks per quarter note
# At this resolution, a quarter note = 480 ticks, half note = 960, etc.
TICKS_PER_QUARTER = 480

# Weighted duration lookup table
# Each entry: (name, ticks, index_min, index_max)
# The 2048-value index space (11 bits) is partitioned so shorter durations
# are more probable and longer durations are rarer, creating natural-feeling rhythms.
#
# Probability breakdown:
#   Sixteenth (0.25 beats):  448/2048 = 21.9%
#   Eighth (0.5 beats):      368/2048 = 18.0%
#   Dotted eighth (0.75):    288/2048 = 14.1%
#   Quarter (1.0 beats):     248/2048 = 12.1%
#   Eighth triplet (0.667):  208/2048 = 10.2%
#   Dotted quarter (1.5):    168/2048 =  8.2%
#   Half (2.0 beats):        168/2048 =  8.2%
#   Dotted half (3.0 beats): 152/2048 =  7.4%
DURATION_TABLE = [
    # (name,             ticks,   index_min, index_max)
    ("sixteenth",        TICKS_PER_QUARTER // 4,   0,    447),
    ("eighth",           TICKS_PER_QUARTER // 2,   448,  815),
    ("dotted eighth",    int(TICKS_PER_QUARTER * 0.75), 816,  1103),
    ("quarter",          TICKS_PER_QUARTER,        1104, 1351),
    ("eighth triplet",   int(TICKS_PER_QUARTER * 2 / 3), 1352, 1559),
    ("dotted quarter",   int(TICKS_PER_QUARTER * 1.5), 1560, 1727),
    ("half",             TICKS_PER_QUARTER * 2,    1728, 1895),
    ("dotted half",      int(TICKS_PER_QUARTER * 3),   1896, 2047),
]


# ── Block fetching ───────────────────────────────────────────────────────────

def fetch_latest_block() -> Tuple[Optional[str], Optional[str], Optional[int]]:
    """
    Fetch the latest Bitcoin block from the Blockstream API.

    The API returns a JSON array of the most recent blocks. We use the first
    (most recent) block, extracting its merkle_root, block hash (id), and height.

    The block hash is displayed for reference only — it is NOT used in the
    rhythm derivation. Only the merkle root drives the MIDI generation.

    Returns:
        (merkle_root, block_hash, block_height) or (None, None, None) on failure.
    """
    try:
        print(f"Fetching latest BTC block from:\n  {LATEST_BLOCK_API}\n")
        req = urllib.request.Request(LATEST_BLOCK_API)
        req.add_header("User-Agent", "merkle-to-midi/1.0")
        with urllib.request.urlopen(req, timeout=10) as response:
            blocks = json.loads(response.read().decode("utf-8"))
            if blocks and "merkle_root" in blocks[0] and "id" in blocks[0] and "height" in blocks[0]:
                return blocks[0]["merkle_root"], blocks[0]["id"], blocks[0]["height"]
    except Exception as e:
        print(f"Could not fetch latest block: {e}")
    return None, None, None


# ── Merkle tree descent ──────────────────────────────────────────────────────

def derive_leaves(merkle_root_hex: str, depth: int = DEFAULT_DEPTH) -> List[str]:
    """
    Derive 2^depth leaf hashes from a merkle root via binary tree descent.

    This is the core cryptographic derivation that replaces simple bit-slicing.
    Instead of linearly chopping bits from the merkle root, we treat it as a
    tree root and recursively derive children:

        Left child:  SHA-256(node_bytes || 0x00)
        Right child: SHA-256(node_bytes || 0x01)

    At each level, the node is extended with a single byte (0x00 or 0x01)
    before hashing, ensuring left and right children are always distinct.

    The recursion continues to the specified depth, at which point the leaf
    node bytes are collected. Leaves are returned in left-to-right depth-first
    order, which is the natural traversal order of the binary tree.

    Why this is more elegant than bit-slicing:
    - Every leaf is a full 256-bit hash with uniform entropy distribution
    - The tree structure is deterministic and reproducible from any root
    - No bits are "wasted" — the entire root participates in every leaf
    - The derivation uses proper cryptographic hashing at each step

    Args:
        merkle_root_hex: 64-character hex string (256-bit merkle root)
        depth: Tree depth (default 5 → 32 leaves)

    Returns:
        List of 2^depth leaf hashes as hex strings, in left-to-right order.
    """
    root_bytes = bytes.fromhex(merkle_root_hex)

    def descend(node_bytes: bytes, current_depth: int) -> List[str]:
        # Base case: reached target depth, return this leaf
        if current_depth == depth:
            return [node_bytes.hex()]

        # Recursive case: derive left and right children
        # Append 0x00 for left, 0x01 for right, then SHA-256 hash
        left_bytes = hashlib.sha256(node_bytes + b"\x00").digest()
        right_bytes = hashlib.sha256(node_bytes + b"\x01").digest()

        # Depth-first traversal: left subtree first, then right
        return descend(left_bytes, current_depth + 1) + descend(right_bytes, current_depth + 1)

    return descend(root_bytes, 0)


# ── Loop length determination ────────────────────────────────────────────────

def root_bits_to_bar_count(merkle_root_hex: str) -> Tuple[int, int, str]:
    """
    Extract the first 2 bits of the merkle root to determine loop length.

    The first 2 bits are the most significant bits of the first byte of the
    merkle root. They map to bar counts as powers of 2:

        First 2 bits | Bar count | Total beats (in 4/4)
        -------------|-----------|---------------------
          00         | 1 bar     | 4 beats
          01         | 2 bars    | 8 beats
          10         | 4 bars    | 16 beats
          11         | 8 bars    | 32 beats

    Why powers of 2? Musical phrasing convention. Loops of 1, 2, 4, or 8 bars
    feel natural and align with common song structures. Odd-bar loops (3, 5, 7)
    can feel awkward and are harder to layer with other musical elements.

    Why first 2 bits of the root (not the first leaf)? This is a structural
    parameter that determines the overall form of the rhythm. By deriving it
    directly from the root (before tree descent), we keep loop length
    independent from the rhythmic content (which comes from the leaves).

    Args:
        merkle_root_hex: 64-character hex string

    Returns:
        (bar_count, target_beats, bit_string) where:
        - bar_count: 1, 2, 4, or 8
        - target_beats: total quarter-note beats (bar_count * 4)
        - bit_string: the 2-bit string used (e.g., "10")
    """
    # First byte of the merkle root
    first_byte = int(merkle_root_hex[:2], 16)

    # Extract top 2 bits (most significant bits of the first byte)
    first_two_bits = first_byte >> 6  # shift right by 6 to get bits 7-6

    # Map to bar counts as powers of 2
    bar_map = {0: 1, 1: 2, 2: 4, 3: 8}
    bars = bar_map[first_two_bits]

    # Format as 2-bit binary string for display
    bits_str = f"{first_two_bits:02b}"

    return bars, bars * 4, bits_str


# ── Duration mapping ─────────────────────────────────────────────────────────

def leaf_to_duration(leaf_hex: str) -> Tuple[str, int]:
    """
    Map a leaf hash to a note duration using its first 11 bits.

    The first 11 bits of each leaf hash form an index (0–2047) that selects
    a duration from the weighted lookup table. Shorter durations are more
    probable (sixteenth notes appear ~22% of the time) while longer durations
    are rarer (dotted half notes appear ~7% of the time).

    This weighted distribution creates natural-feeling rhythms where short
    notes provide motion and long notes provide breathing room.

    Bit extraction:
    - First 8 bits = first byte of the leaf hash
    - Next 3 bits = top 3 bits of the second byte
    - Combined: (byte[0] << 3) | (byte[1] >> 5)

    Args:
        leaf_hex: 64-character hex string (one leaf hash)

    Returns:
        (duration_name, duration_in_ticks)
    """
    leaf_bytes = bytes.fromhex(leaf_hex)
    first_byte = leaf_bytes[0]
    second_byte = leaf_bytes[1]

    # First 11 bits: all 8 bits of first byte + first 3 bits of second byte
    index = (first_byte << 3) | (second_byte >> 5)

    for name, ticks, min_idx, max_idx in DURATION_TABLE:
        if min_idx <= index <= max_idx:
            return name, ticks

    # Should never reach here since ranges cover 0–2047
    return DURATION_TABLE[-1][0], DURATION_TABLE[-1][1]


# ── Rhythm filling ───────────────────────────────────────────────────────────

def fill_rhythm_to_target(
    durations: List[Tuple[str, int]],
    target_ticks: int
) -> List[Tuple[str, int, bool]]:
    """
    Fill notes sequentially until the target is reached exactly.

    Follows MIDI-PROTOCOL.md §7.4:

    - Placement walks the periodic sequence durations[i % L]. If the 32 leaves
      run out before the target is filled (common for 8-bar loops: the mean
      32-leaf sum is ~14.6k ticks vs a 15,360-tick target), placement wraps
      around to the first leaf and continues.
    - Truncation rule: the first note whose duration would overflow the
      remaining space is truncated to fill it exactly and terminates the
      sequence.
    - Exact rule: a note landing exactly on the target terminates the sequence
      un-truncated. A zero-length note is never appended.

    Example (target = 4 bars = 16 beats = 7680 ticks):
        Note 1: dotted eighth  (0.75 beats) → accumulated: 0.75
        Note 2: eighth triplet (0.667 beats) → accumulated: 1.417
        ...
        Note 18: dotted quarter (1.5 beats) → accumulated: 14.833
        Note 19: half (2.0 beats) → would overflow to 16.833
            → truncated to 1.167 beats to hit exactly 16.0

    Args:
        durations: List of (duration_name, ticks) from leaf mapping
        target_ticks: Total ticks the rhythm must fill exactly

    Returns:
        List of (duration_name, actual_ticks, was_truncated) tuples.
        The sum of all actual_ticks equals target_ticks exactly.
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
    notes: List[Tuple[str, int, bool]],
    output_path: str
):
    """
    Generate a MIDI file from a list of rhythm notes.

    Uses the GM drum channel (channel 10, 0-indexed as 9) so that MIDI notes
    map to percussion sounds rather than pitched instruments. The note used
    is Acoustic Bass Drum (MIDI key 35), which provides a clean, punchy hit
    suitable for rhythmic pattern playback.

    Each note has an 80% duty cycle: the note sounds for 80% of its duration,
    followed by a 20% gap before the next note. This creates a percussive,
    non-legato feel with natural space between hits.

    The tempo is set via a MetaMessage at the start of the track. All note
    timing is in ticks, which are converted to real time by the MIDI player
    using the tempo value.

    Args:
        notes: List of (duration_name, actual_ticks, was_truncated) tuples
        output_path: File path for the output MIDI file
    """
    mid = mido.MidiFile(ticks_per_beat=TICKS_PER_QUARTER)
    track = mido.MidiTrack()
    mid.tracks.append(track)

    # Set tempo: microseconds per quarter note
    # At 120 BPM, this is 500,000 microseconds per beat
    track.append(mido.MetaMessage("set_tempo", tempo=MICROSECONDS_PER_BEAT, time=0))

    # Generate note events
    for name, total_ticks, was_truncated in notes:
        # 80% duty cycle: note-on for 80% of duration, 20% gap
        note_on_ticks = int(total_ticks * DUTY_CYCLE)
        gap_ticks = total_ticks - note_on_ticks

        # Note on: start the drum hit
        track.append(mido.Message(
            "note_on",
            note=MIDI_DRUM_NOTE,
            velocity=NOTE_VELOCITY,
            channel=MIDI_DRUM_CHANNEL,
            time=0  # immediate (delta time from previous event)
        ))

        # Note off: end the drum hit after the note-on duration
        track.append(mido.Message(
            "note_off",
            note=MIDI_DRUM_NOTE,
            velocity=0,
            channel=MIDI_DRUM_CHANNEL,
            time=note_on_ticks
        ))

        # Gap: silence before the next note (if any)
        if gap_ticks > 0:
            track.append(mido.Message(
                "note_off",
                note=MIDI_DRUM_NOTE,
                velocity=0,
                channel=MIDI_DRUM_CHANNEL,
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
    notes: List[Tuple[str, int, bool]],
    leaves: List[str],
):
    """
    Print a detailed breakdown of the conversion for transparency.

    Shows:
    - Input merkle root and block hash (reference only)
    - First 2 bits used for loop length determination
    - Target bar count and total beats
    - Each note's leaf hash, duration, and whether it was truncated
    - Total notes used vs. available leaves
    - Final duration (always exactly matches target)
    """
    print("=" * 70)
    print("MERKLE ROOT → RHYTHMIC MIDI PATTERN (merkle tree descent)")
    print("=" * 70)
    print(f"\nInput merkle root:\n  {merkle_root_hex}")
    print(f"Block hash (reference):\n  {block_hash}\n")

    print(f"Loop length: first 2 bits = '{first_two_bits}' → {bar_count} bar(s) ({target_beats} beats)")
    print(f"Tree depth: {DEFAULT_DEPTH}")
    print(f"Leaves derived: {len(leaves)}")

    # Count how many notes were actually used
    notes_used = len(notes)
    last_truncated = notes[-1][2] if notes else False
    truncated_note = " (last note truncated to fit)" if last_truncated else ""
    wrapped = notes_used - len(leaves)
    wrap_note = f" (cycled {wrapped} wrapped)" if wrapped > 0 else ""
    print(f"Notes used: {notes_used} of {len(leaves)}{wrap_note}{truncated_note}\n")

    print("Leaf hashes (first 16 chars) → Duration:")
    print("-" * 65)
    for i, (name, ticks, was_truncated) in enumerate(notes, start=1):
        leaf = leaves[(i - 1) % len(leaves)]
        leaf_short = leaf[:16]
        beats = ticks / TICKS_PER_QUARTER
        marker = " ← truncated" if was_truncated else (" ← wrapped" if i > len(leaves) else "")
        print(f"  {i:>2}. {leaf_short}... → {name:<16} ({beats:.3g} beats){marker}")

    total_beats = sum(t for _, t, _ in notes) / TICKS_PER_QUARTER
    total_bars = total_beats / 4
    print(f"\nTotal duration: {total_beats:.2f} beats ({total_bars:.2f} bars in 4/4)")


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    """
    Main pipeline:
    1. Get merkle root (from CLI arg, API fetch, or fallback default)
    2. Validate the hex string
    3. Derive 32 leaf hashes via merkle tree descent
    4. Map each leaf to a note duration via weighted lookup
    5. Determine loop length from first 2 bits of the root
    6. Fill notes to exactly match the target bar count
    7. Display results and export MIDI file
    """
    # ── Step 1: Get merkle root ─────────────────────────────────────────────
    block_hash = "N/A"
    block_height = None

    if len(sys.argv) > 1:
        # User provided a merkle root on the command line
        merkle_root_hex = sys.argv[1].strip().lower()
        block_hash = "N/A"
        block_height = None
        print(f"Using merkle root from command line argument.")
    else:
        # Fetch the latest Bitcoin block from the Blockstream API
        merkle_root_hex, block_hash, block_height = fetch_latest_block()
        if merkle_root_hex is None:
            # API failed — fall back to hardcoded default
            print(f"Could not fetch latest block. Falling back to default merkle root.")
            merkle_root_hex = DEFAULT_MERKLE_ROOT
            block_hash = "N/A"
            block_height = None
        else:
            print(f"Using latest BTC block merkle root.")

    # ── Step 2: Validate ────────────────────────────────────────────────────
    if len(merkle_root_hex) != MERKLE_ROOT_HEX_LENGTH:
        raise ValueError(
            f"Expected a {MERKLE_ROOT_HEX_LENGTH}-character hex string, "
            f"got {len(merkle_root_hex)} characters."
        )
    int(merkle_root_hex, 16)  # validates hex format

    # ── Step 2b: Check if MIDI file already exists ──────────────────────────
    # Uses the output file itself as a "cache" — if the file exists, the same
    # merkle root was already processed. This avoids redundant work and signals
    # that no new block has been found since the last run.
    # Filename format: {block_height}_merkle_{root_prefix}.mid (or merkle_{root_prefix}.mid if height unknown)
    if block_height is not None:
        output_name = f"{block_height}_merkle_{merkle_root_hex[:8]}.mid"
    else:
        output_name = f"merkle_{merkle_root_hex[:8]}.mid"

    # Ensure the output directory exists
    midi_dir = Path(MIDI_OUTPUT_DIR)
    midi_dir.mkdir(exist_ok=True)

    output_path = midi_dir / output_name

    if output_path.exists():
        print(f"\nNo new block since last run. MIDI file already exists: {output_path}")
        print(f"Delete the file or use a different merkle root to regenerate.")
        sys.exit(0)

    # ── Step 3: Derive leaves ───────────────────────────────────────────────
    print(f"\nDeriving {NUM_LEAVES} leaf hashes via merkle tree descent (depth={DEFAULT_DEPTH})...")
    leaves = derive_leaves(merkle_root_hex, DEFAULT_DEPTH)

    # ── Step 4: Map leaves to durations ─────────────────────────────────────
    durations = [leaf_to_duration(leaf) for leaf in leaves]

    # ── Step 5: Determine loop length from first 2 bits of root ─────────────
    bar_count, target_beats, first_two_bits = root_bits_to_bar_count(merkle_root_hex)
    target_ticks = target_beats * TICKS_PER_QUARTER

    # ── Step 6: Fill rhythm to exact target bar count ───────────────────────
    notes = fill_rhythm_to_target(durations, target_ticks)

    # ── Step 7: Display results ─────────────────────────────────────────────
    display_results(
        merkle_root_hex, block_hash, bar_count, target_beats,
        first_two_bits, notes, leaves
    )

    # ── Step 8: Export MIDI file ────────────────────────────────────────────
    generate_midi(notes, str(output_path))


if __name__ == "__main__":
    main()
