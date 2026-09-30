# merkle-to-words

Tools for converting a Bitcoin merkle root (or any 256-bit hash) into human-readable and audible representations. A merkle root is a deterministic fingerprint of all transactions in a block — these tools transform that fingerprint into words and rhythm.

## merkle-to-words

Converts a 256-bit merkle root into a 21-word phrase using the BIP-39 English wordlist.

The merkle root is treated as a 256-bit binary value. The first 231 bits are split into 21 chunks of 11 bits each. Each 11-bit value (0–2047) serves as a direct index into the 2048-word BIP-39 wordlist. The remaining 25 bits are discarded.

The output is a deterministic encoding of the merkle root into readable words. This is **not** a valid BIP-39 wallet seed phrase — no checksum is appended.

**Usage:**
```
python3 words-from-merkle.py                          # uses a default example merkle root
python3 words-from-merkle.py <64-char-hex-string>     # uses your own merkle root
```

## merkle-to-midi

Converts a 256-bit merkle root into a rhythmic MIDI pattern using merkle tree descent.

### Derivation

The merkle root is used as the root of a binary tree. Leaf hashes are derived via deterministic descent:

- **Left child:** `SHA-256(node_bytes || 0x00)`
- **Right child:** `SHA-256(node_bytes || 0x01)`
- Recurse to depth D (default 5), yielding 2^5 = **32 leaf hashes** in left-to-right depth-first order

This approach is more elegant than simple bit-slicing: every leaf is a full 256-bit hash with uniform entropy distribution, the tree structure is deterministic and reproducible, and the entire root participates in every leaf through proper cryptographic hashing.

### Loop Length

The **first 2 bits** of the merkle root determine the loop length as powers of 2, following musical phrasing convention:

| First 2 Bits | Bar Count | Total Beats (4/4) |
|---|---|---|
| 00 | 1 bar | 4 beats |
| 01 | 2 bars | 8 beats |
| 10 | 4 bars | 16 beats |
| 11 | 8 bars | 32 beats |

### Rhythm

Each leaf's first 11 bits (0–2047) map to a note duration via a weighted lookup table. Notes are placed sequentially, filling the target bar count exactly. If the last note would overflow, it is truncated to fill the remaining space precisely — guaranteeing clean looping with no partial bars.

| Duration | Index Range | Probability |
|---|---|---|
| Sixteenth | 0–447 | 21.9% |
| Eighth | 448–815 | 18.0% |
| Dotted eighth | 816–1103 | 14.1% |
| Quarter | 1104–1351 | 12.1% |
| Eighth triplet | 1352–1559 | 10.2% |
| Dotted quarter | 1560–1727 | 8.2% |
| Half | 1728–1895 | 8.2% |
| Dotted half | 1896–2047 | 7.4% |

### Output

- **Percussion:** GM drum channel (channel 10), Acoustic Bass Drum (MIDI note 35)
- **Tempo:** 120 BPM (fixed)
- **Duty cycle:** 80% note-on, 20% gap (percussive feel)
- **Loop length:** exactly 1, 2, 4, or 8 bars (never partial)

If no merkle root is provided, the script fetches the latest Bitcoin block from the Blockstream API, using its merkle root and displaying the block hash for reference. Falls back to a default value if the API is unreachable.

**Usage:**
```
python3 midi-from-merkle.py                          # fetches latest BTC block merkle root
python3 midi-from-merkle.py <64-char-hex-string>     # uses your own merkle root
```

Requires the `mido` library: `pip install mido`
