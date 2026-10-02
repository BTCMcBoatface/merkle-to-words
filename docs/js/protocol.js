// protocol.js — M2M-RHYTHM v1.0.2 derivation (§2–§9 of MIDI-PROTOCOL.md)
// 1.0.1/1.0.2 are editorial; derivation is byte-identical to 1.0.0.
// DOM-free and side-effect-free: importable by the browser AND by Node tests.
// Function names mirror midi-from-merkle.py deliberately.

export const PROTOCOL_ID = "M2M-RHYTHM";
export const PROTOCOL_VERSION = "1.0.2";

// ── §5 Fixed structural constants (changing any is a MAJOR-version event) ──
export const MERKLE_ROOT_HEX_LENGTH = 64;
export const DEFAULT_DEPTH = 5;
export const NUM_LEAVES = 2 ** DEFAULT_DEPTH; // 32
export const TEMPO_BPM = 120;
export const MICROSECONDS_PER_BEAT = Math.floor(60_000_000 / TEMPO_BPM); // 500000
export const TICKS_PER_QUARTER = 480;
export const BAR_TICKS = TICKS_PER_QUARTER * 4; // 1920 (§5 barTicks)
export const MIDI_DRUM_CHANNEL = 9;   // canonical stream channel (§10)
export const MIDI_DRUM_NOTE = 35;
export const NOTE_VELOCITY = 80;
export const DUTY_CYCLE = 0.8;

// ── §7.2 Weighted duration table (source of truth; never computed) ──
// [name, ticks, indexMin, indexMax]
export const DURATION_TABLE = [
  ["sixteenth",       120,   0,   447],
  ["eighth",          240, 448,   815],
  ["dotted eighth",   360, 816,  1103],
  ["quarter",         480, 1104,  1351],
  ["eighth triplet",  320, 1352,  1559],
  ["dotted quarter",  720, 1560,  1727],
  ["half",            960, 1728,  1895],
  ["dotted half",    1440, 1896,  2047],
];

// ── §2 Input validation ──
export function normalizeRootHex(input) {
  let s = String(input).trim().toLowerCase();
  if (s.startsWith("0x")) s = s.slice(2);
  if (s.length !== MERKLE_ROOT_HEX_LENGTH) {
    throw new Error(
      `Expected ${MERKLE_ROOT_HEX_LENGTH}-character hex merkle root, got ${s.length}.`
    );
  }
  if (!/^[0-9a-f]+$/.test(s)) throw new Error("Merkle root contains non-hex characters.");
  return s;
}

export function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16); // A7
  return out;
}

export function bytesToHex(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

async function sha256(bytes) {
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(buf);
}

function concatBytes(a, tag) {
  const out = new Uint8Array(a.length + 1);
  out.set(a);
  out[a.length] = tag;
  return out;
}

// ── §4 Leaf derivation — binary descent, left-to-right DFS order ──
// Iterative level-order with left-before-right yields the same leaf sequence
// as the Python recursion (level L has 2^L nodes ordered left→right).
export async function deriveLeaves(rootHex, depth = DEFAULT_DEPTH) {
  let level = [hexToBytes(rootHex)];
  for (let d = 0; d < depth; d++) {
    const next = [];
    for (const node of level) {
      next.push(await sha256(concatBytes(node, 0x00))); // left
      next.push(await sha256(concatBytes(node, 0x01))); // right
    }
    level = next;
  }
  return level; // Uint8Array[32]
}

// ── §6 Loop length — root bits 0–1 (MSBs of byte 0) ──
export function rootBitsToBarCount(rootBytes) {
  const k = rootBytes[0] >>> 6;
  const bars = 1 << k; // A6
  return { bars, targetBeats: bars * 4, bits: k.toString(2).padStart(2, "0") };
}

// ── §7.1–§7.2 Duration index and table lookup ──
export function leafToDuration(leafBytes) {
  const index = (leafBytes[0] << 3) | (leafBytes[1] >>> 5); // A2/A3: exact in JS
  for (const [name, ticks, minIdx, maxIdx] of DURATION_TABLE) {
    if (index >= minIdx && index <= maxIdx) return { name, ticks, index };
  }
  const last = DURATION_TABLE[DURATION_TABLE.length - 1]; // unreachable: table covers 0–2047
  return { name: last[0], ticks: last[1], index };
}

// ── §7.3–§7.4 Note placement, duty cycle, cyclic leaf reuse ──
export function fillRhythmToTarget(durations, targetTicks) {
  const notes = [];
  let accumulated = 0;
  const n = durations.length;
  if (n === 0) return notes;

  let i = 0;
  while (accumulated < targetTicks) {
    const { name, ticks } = durations[i % n]; // §7.4 cyclic reuse
    const remaining = targetTicks - accumulated;

    if (ticks > remaining) {
      notes.push({ name, ticks: remaining, truncated: true }); // truncation rule
      break;
    } else {
      notes.push({ name, ticks, truncated: false });
      accumulated += ticks; // exact rule: loop stops cleanly at remaining = 0
    }
    i++;
  }
  return notes;
}

// ── §3 Canonical event stream E(R) helpers ──
// soundingTicks = floor(duration × dutyCycle) — A4. All reachable durations are
// multiples of 40 so this is exact, but the floor form is normative.
export function dutySplit(durationTicks) {
  const sounding = Math.floor(durationTicks * DUTY_CYCLE);
  return { sounding, gap: durationTicks - sounding };
}

// Onset grid per engine: absolute tick position + sounding length,
// independent of channel/key (that is §10 / voice-routing, not derivation).
export function onsetsFromNotes(notes) {
  let pos = 0;
  return notes.map((n) => {
    const { sounding } = dutySplit(n.ticks);
    const onset = { tick: pos, durationTicks: n.ticks, soundingTicks: sounding, name: n.name };
    pos += n.ticks;
    return onset;
  });
}

// Full pipeline for one merkle root → everything the player and SMF writer need.
export async function derivePattern(rootHex) {
  const hex = normalizeRootHex(rootHex);
  const rootBytes = hexToBytes(hex);
  const leaves = await deriveLeaves(hex, DEFAULT_DEPTH);
  const durations = leaves.map(leafToDuration);
  const { bars, targetBeats, bits } = rootBitsToBarCount(rootBytes);
  const targetTicks = targetBeats * TICKS_PER_QUARTER;

  const notes = fillRhythmToTarget(durations, targetTicks);
  const sumTicks = notes.reduce((a, n) => a + n.ticks, 0);
  if (sumTicks !== targetTicks) {
    // §7.4 loop guarantee — must never happen. Fail loudly per spec.
    throw new Error(`Protocol violation: Σ=${sumTicks} != target ${targetTicks}`);
  }

  return {
    rootHex: hex,
    protocol: `${PROTOCOL_ID}/${PROTOCOL_VERSION}`,
    barCount: bars,
    firstTwoBits: bits,
    targetTicks,
    loopTicks: targetTicks, // loop length in ticks (engine anchor)
    notes,
    onsets: onsetsFromNotes(notes),
    leafPrefixes: leaves.map((l) => bytesToHex(l).slice(0, 16)),
    noteCountWrapped: notes.length > NUM_LEAVES,
  };
}
