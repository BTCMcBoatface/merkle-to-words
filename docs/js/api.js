// api.js — Blockstream data source (MIDI-PROTOCOL.md §2: the API is NOT part
// of the protocol; any valid 32-byte root source is conformant).
// Fetches are strictly on-request (no background polling).

import { normalizeRootHex } from "./protocol.js";

const BASE = "https://blockstream.info/api";

async function getJSON(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`Blockstream API ${res.status} for ${path}`);
  const data = await res.json();
  return data;
}

// GET /blocks/tip → array of blocks at the current height; first entry is used
// (same contract the Python fetch_latest_block relies on).
export async function fetchTip() {
  const blocks = await getJSON("/blocks/tip");
  const b = blocks && blocks[0];
  if (!b || !b.merkle_root || !b.id || b.height == null) {
    throw new Error("Unexpected /blocks/tip response shape.");
  }
  return { height: b.height, merkleRoot: normalizeRootHex(b.merkle_root), blockHash: b.id };
}

// Two-step for a specific height (old blocks allowed): height → hash → block.
// NOTE: GET /block-height/:height returns the block hash as PLAIN TEXT
// (an array of hashes only during chain forks) — do not .json() it.
// Safari surfaced that parse failure as:
//   SyntaxError: "The string did not match the expected pattern."
export async function fetchByHeight(height) {
  const h = parseInt(String(height).trim(), 10);
  if (!Number.isInteger(h) || h < 0 || h > 9999999) {
    throw new Error(`Invalid block height: ${height}`);
  }
  const res = await fetch(`${BASE}/block-height/${h}`);
  if (!res.ok) throw new Error(`Blockstream API ${res.status} for /block-height/${h}`);
  const raw = (await res.text()).trim();
  let hash;
  if (raw.startsWith("[")) {
    const arr = JSON.parse(raw); // fork: multiple hashes at this height
    hash = arr && arr[0];
  } else {
    hash = raw;
  }
  if (!/^[0-9a-f]{64}$/.test(hash || "")) throw new Error(`No block found at height ${h}`);
  const block = await getJSON(`/block/${hash}`);
  if (!block || !block.merkle_root) throw new Error(`No merkle_root at height ${h}`);
  return { height: h, merkleRoot: normalizeRootHex(block.merkle_root), blockHash: block.id };
}
