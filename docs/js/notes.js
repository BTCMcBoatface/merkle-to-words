// notes.js — M2M-NOTES v1.0.0 implementation (pitch layer on the frozen rhythm).
// Frozen Oct 1; mirrors notes-from-merkle.py exactly (fixture-verified, 98 checks).
// Rhythm is untouched: this module only reads the leaf bytes rhythm already derived
// (bits 11–18, disjoint per OP1 fix) plus scale bits from the root (§2 allocation).

import { hexToBytes, deriveLeaves, BAR_TICKS, DEFAULT_DEPTH } from "./protocol.js";

// ── §4 grid (OP2 resolved: eighths over the 8-bar reference cycle) ──
export const GRID_TICKS = BAR_TICKS * 8;              // 15360
export const MAP_CELLS = 64;                           // eighths per cycle
export const CELL_TICKS = GRID_TICKS / MAP_CELLS;      // 600

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
