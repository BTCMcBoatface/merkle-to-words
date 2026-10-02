// notes.js — M2M-NOTES v2.0.0 implementation (pitch layer on the frozen rhythm).
// v2.0.0 (Oct 1, same-day amendment after interaction review): the melody map is a
// piano roll with its OWN length (4/8/16 bars, default 4) that loops forever, synced
// across all instruments (position = t mod mapTicks). Monophonic by default; an
// optional polyphony mode stacks simultaneous pitches per column (cap 7).
// Mirrors notes-from-merkle.py for the deterministic layer; fixture-verified.
// Rhythm is untouched: this module only reads the leaf bytes rhythm already derived
// (bits 11–18, disjoint per OP1 fix) plus scale bits from the root (§2 allocation).

import { hexToBytes, deriveLeaves, BAR_TICKS, DEFAULT_DEPTH } from "./protocol.js";

// ── map geometry (v2) ──
export const CELL_TICKS = 600;                    // one eighth (OP2)
export const MAP_BAR_OPTIONS = [4, 8, 16];
export const DEFAULT_MAP_BARS = 4;
export const POLY_STACK_CAP = 7;
export const mapTicksFor = (bars) => bars * BAR_TICKS;

// Legacy v1 grid constants (8-bar cycle) — kept for decode compatibility only.
export const GRID_TICKS = BAR_TICKS * 8;
export const MAP_CELLS = GRID_TICKS / CELL_TICKS; // 64

// ── §3 modes ──
export const MODES = {
  ionian:     [0, 2, 4, 5, 7, 9, 11],
  dorian:     [0, 2, 3, 5, 7, 9, 10],
  phrygian:   [0, 1, 3, 5, 7, 8, 10],
  lydian:     [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  aeolian:    [0, 2, 3, 5, 7, 8, 10],
  locrian:    [0, 1, 3, 5, 6, 8, 10],
  chromatic:  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};
export const MODE_ORDER = ["ionian", "dorian", "phrygian", "lydian", "mixolydian", "aeolian", "locrian", "chromatic"];
export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function noteName(midi) {
  return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

// foldMidi: ±12 octave fold into 21–108 (A0..C8) — spec §3 clamp
export function foldMidi(m) {
  while (m > 108) m -= 12;
  while (m < 21) m += 12;
  return m;
}

// ── §2: true disjoint leaf bits 11–18 (OP1 fix) ──
export function pitchByte(leafBytes) {
  return ((leafBytes[1] & 0x1f) << 3) | (leafBytes[2] >> 5);
}

// ── §2/§3: scale parameters from root bits 2–15 ──
export function deriveScaleParams(rootBytes) {
  const b0 = rootBytes[0];
  const b1 = rootBytes[1];
  const bit2 = (b0 >> 5) & 0x01;
  const modeIndex = (b0 >> 2) & 0x07;
  const rootNoteIndex = (((b0 & 0x03) << 3) | (b1 >> 5)) % 12;
  const baseOctave = (b1 & 0x1f) % 3 + 2;
  const octaveRange = bit2 === 0 ? 1 : 2;
  const scaleSize = octaveRange === 1 ? 8 : 15;
  const modeName = MODE_ORDER[modeIndex];
  return {
    modeIndex, modeName, modeIntervals: MODES[modeName],
    rootNoteIndex, baseOctave, octaveRange, scaleSize,
    rootNoteName: NOTE_NAMES[rootNoteIndex],
  };
}

// ── §3: degree → MIDI note (diatonic wraps by 7, chromatic by 12) ──
export function scaleDegreeToMidi(degree, sc) {
  const rootMidi = (sc.baseOctave + 1) * 12 + sc.rootNoteIndex;
  if (sc.modeName === "chromatic") {
    return rootMidi + sc.modeIntervals[degree % 12] + 12 * Math.floor(degree / 12);
  }
  return rootMidi + sc.modeIntervals[degree % 7] + 12 * Math.floor(degree / 7);
}

// full deterministic melody for a root: one folded MIDI pitch per leaf (32)
export async function deriveMelody(rootHex) {
  const rootBytes = hexToBytes(rootHex);
  const leaves = await deriveLeaves(rootHex, DEFAULT_DEPTH);
  const scale = deriveScaleParams(rootBytes);
  const melody32 = leaves.map((l) =>
    foldMidi(scaleDegreeToMidi(pitchByte(l) % scale.scaleSize, scale))
  );
  return { scale, melody32 };
}

// ── map stack codec (v2): per column [count, notes...] — URL-friendly ──
export function encodeCells(cells) {
  const bytes = [];
  for (const c of cells) {
    const n = Math.min(c.length, POLY_STACK_CAP);
    bytes.push(n);
    for (let i = 0; i < n; i++) bytes.push(c[i]);
  }
  return bytes;
}

export function decodeCells(bytes, cols) {
  const out = [];
  let i = 0;
  for (let col = 0; col < cols; col++) {
    const c = [];
    if (i < bytes.length) {
      const n = Math.min(bytes[i++] | 0, POLY_STACK_CAP);
      for (let k = 0; k < n && i < bytes.length; k++) {
        const p = bytes[i++];
        if (p >= 21 && p <= 108) c.push(p);
      }
    }
    out.push(c);
  }
  return out;
}

// legacy v1 payload: one byte per column (0 empty) over the 8-bar cycle → mono cells
export function decodeLegacyCells(bytes) {
  return bytes.map((v) => (v >= 21 && v <= 108 ? [v] : []));
}
