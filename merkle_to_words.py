#!/usr/bin/env python3
"""
merkle_to_words.py
------------------
Converts a Bitcoin merkle root (256-bit hex value) into a 21-word phrase
using the official BIP-39 English wordlist.

HOW IT WORKS (inspired by BIP-39 encoding):
--------------------------------------------
BIP-39 encodes entropy by:
  1. Taking a binary string of entropy bits
  2. Splitting it into 11-bit chunks
  3. Using each 11-bit value (0–2047) as an index into a 2048-word list

This script applies that same core mechanic to a Bitcoin merkle root:
  - A merkle root is 64 hex characters = 256 bits
  - 21 words × 11 bits = 231 bits needed 
  - We use the first 231 bits, discarding the last 25 bits
  - NO checksum is appended (unlike proper BIP-39); this is purely
    a deterministic encoding of the merkle root into human-readable words

NOTE: The output is NOT a valid BIP-39 wallet seed phrase. It is a
      faithful application of the BIP-39 word-lookup mechanism to a
      merkle root for representational/mnemonic purposes only.
"""

import sys
import urllib.request


# ── Constants ────────────────────────────────────────────────────────────────

# The official BIP-39 English wordlist, hosted in the Bitcoin BIPs repository
WORDLIST_URL = "https://raw.githubusercontent.com/bitcoin/bips/master/bip-0039/english.txt"

# A merkle root is always 64 hex characters (256 bits)
MERKLE_ROOT_HEX_LENGTH = 64

# We want exactly 21 words
NUM_WORDS = 21

# Each BIP-39 word represents exactly 11 bits (because 2^11 = 2048 words)
BITS_PER_WORD = 11

# Total bits we need to use from the 256-bit merkle root
BITS_TO_USE = NUM_WORDS * BITS_PER_WORD   # 21 × 11 = 231 bits

# Bits we discard from the end of the 256-bit input
BITS_DISCARDED = 256 - BITS_TO_USE        # 256 - 231 = 25 bits discarded


# ── Wordlist loading ─────────────────────────────────────────────────────────

def load_wordlist(url: str) -> list[str]:
    """
    Fetch the BIP-39 English wordlist from the official Bitcoin BIPs repository.
    Returns a list of 2048 words, where index 0 = 'abandon', index 2047 = 'zoo'.
    Each word's position in this list is its 11-bit index value.
    """
    print(f"Fetching BIP-39 wordlist from:\n  {url}\n")
    with urllib.request.urlopen(url) as response:
        content = response.read().decode("utf-8")

    # Each line in the file is one word; strip whitespace and skip blank lines
    words = [line.strip() for line in content.splitlines() if line.strip()]

    if len(words) != 2048:
        raise ValueError(f"Expected 2048 words, got {len(words)}. Wordlist may be malformed.")

    return words


# ── Conversion logic ──────────────────────────────────────────────────────────

def hex_to_bits(hex_string: str) -> str:
    """
    Convert a hex string to a binary string (a string of '0' and '1' characters).

    Example:
      '2e' → '00101110'

    We use zfill to ensure each byte is always represented as exactly 8 bits,
    preserving leading zeros that would otherwise be lost in the conversion.

    A 64-character hex string (merkle root) becomes a 256-character bit string.
    """
    # Convert hex → integer → binary string, then strip the '0b' prefix
    # zfill pads to the correct length: 4 bits per hex character
    bit_length = len(hex_string) * 4
    integer_value = int(hex_string, 16)
    bit_string = bin(integer_value)[2:].zfill(bit_length)
    return bit_string


def bits_to_word_indices(bit_string: str, num_words: int, bits_per_word: int) -> list[int]:
    """
    Split a binary string into chunks of `bits_per_word` bits each,
    and convert each chunk to an integer index.

    This is the core of the BIP-39 encoding mechanism.

    Example (with bits_per_word=11):
      '00000000001' → index 1   → word at position 1
      '11111111111' → index 2047 → word at position 2047

    We only take the first `num_words * bits_per_word` bits, discarding the rest.
    """
    bits_needed = num_words * bits_per_word

    # Truncate to only the bits we need (first 231 of 256)
    truncated = bit_string[:bits_needed]

    indices = []
    for i in range(num_words):
        # Slice out an 11-bit chunk
        start = i * bits_per_word
        end   = start + bits_per_word
        chunk = truncated[start:end]

        # Convert the 11-bit binary string to an integer (0–2047)
        index = int(chunk, 2)
        indices.append(index)

    return indices


def merkle_to_words(merkle_root_hex: str, wordlist: list[str]) -> list[str]:
    """
    Full pipeline: merkle root hex → 21 BIP-39 words.

    Steps:
      1. Validate input is a proper 64-char hex string
      2. Convert hex → 256-bit binary string
      3. Take the first 231 bits (21 × 11), discard the last 25
      4. Split into 21 chunks of 11 bits each
      5. Use each 11-bit value as an index into the BIP-39 wordlist
    """

    # ── Step 1: Validate ──────────────────────────────────────────────────────
    merkle_root_hex = merkle_root_hex.strip().lower()

    if len(merkle_root_hex) != MERKLE_ROOT_HEX_LENGTH:
        raise ValueError(
            f"Expected a {MERKLE_ROOT_HEX_LENGTH}-character hex string "
            f"(256-bit merkle root), got {len(merkle_root_hex)} characters."
        )

    # Confirm it's valid hex (will raise ValueError if not)
    int(merkle_root_hex, 16)

    # ── Step 2: Hex → bits ────────────────────────────────────────────────────
    all_bits = hex_to_bits(merkle_root_hex)
    # all_bits is now a 256-character string of '0' and '1'

    # ── Steps 3 & 4: Truncate and split into 11-bit indices ──────────────────
    indices = bits_to_word_indices(all_bits, NUM_WORDS, BITS_PER_WORD)

    # ── Step 5: Look up each index in the wordlist ────────────────────────────
    words = [wordlist[idx] for idx in indices]

    return words, indices, all_bits


# ── Output / display ─────────────────────────────────────────────────────────

def display_results(merkle_root_hex: str, words: list[str], indices: list[int], all_bits: str):
    """
    Print a detailed breakdown of the conversion for transparency.
    Shows the bit string, each 11-bit chunk, its integer value, and the word.
    """
    print("=" * 60)
    print("MERKLE ROOT → 21-WORD PHRASE (BIP-39 encoding)")
    print("=" * 60)
    print(f"\nInput merkle root:\n  {merkle_root_hex}\n")

    print(f"Full 256-bit binary representation:")
    # Print in groups of 11 bits for easy visual chunking, then the remainder
    used_bits   = all_bits[:BITS_TO_USE]
    unused_bits = all_bits[BITS_TO_USE:]
    # Display used bits in 11-bit groups
    groups = [used_bits[i:i+11] for i in range(0, BITS_TO_USE, 11)]
    print(f"  Used   ({BITS_TO_USE} bits): {' '.join(groups)}")
    print(f"  Unused ({BITS_DISCARDED} bits): {unused_bits}  ← discarded\n")

    print(f"{'Word #':<8} {'11-bit chunk':<14} {'Index (0–2047)':<18} {'Word'}")
    print("-" * 55)
    for i, (word, idx) in enumerate(zip(words, indices), start=1):
        chunk = used_bits[(i-1)*11 : i*11]
        print(f"  {i:<6} {chunk:<14} {idx:<18} {word}")

    print("\n" + "=" * 60)
    print("21-WORD PHRASE:")
    print("=" * 60)
    print("\n  " + " ".join(words) + "\n")


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    # Use the merkle root from a March 28 block example, or accept one as a command-line arg
    default_merkle_root = "2e0f4eb72a525d443b731dce006d728a2f3575768a9e475fc1b4c66016475600"

    if len(sys.argv) > 1:
        merkle_root_hex = sys.argv[1]
        print(f"Using merkle root from command line argument.")
    else:
        merkle_root_hex = default_merkle_root
        print(f"No argument provided. Using default example merkle root.")

    # Load the official BIP-39 wordlist from GitHub
    wordlist = load_wordlist(WORDLIST_URL)
    print(f"Loaded {len(wordlist)} words. First: '{wordlist[0]}', Last: '{wordlist[-1]}'\n")

    # Run the conversion
    words, indices, all_bits = merkle_to_words(merkle_root_hex, wordlist)

    # Display the detailed breakdown
    display_results(merkle_root_hex, words, indices, all_bits)


if __name__ == "__main__":
    main()
