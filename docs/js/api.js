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
export async function fetchByHeight(height) {
  const h = parseInt(String(height).trim(), 10);
  if (!Number.isInteger(h) || h < 0 || h > 9999999) {
    throw new Error(`Invalid block height: ${height}`);
  }
  const hashes = await getJSON(`/block-height/${h}`);
  if (!hashes || !hashes[0]) throw new Error(`No block at height ${h}`);
  const block = await getJSON(`/block/${hashes[0]}`);
  if (!block || !block.merkle_root) throw new Error(`No merkle_root at height ${h}`);
  return { height: h, merkleRoot: normalizeRootHex(block.merkle_root), blockHash: block.id };
}
