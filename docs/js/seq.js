// seq.js — drum sequencer geometry + codecs (pure, DOM-free, Node-importable).
// v1.6 re-design: TWO independent grids.
//   PAINT GRID (writing only): step selector whole…16th + optional ³ (triplets
//     offered on ♩→320 and ♪→160 ticks only — nothing finer than eighth-triplets,
//     owner ruling). Changing it NEVER moves existing notes: the dial is the
//     snap strength for new input only.
//   BLOCK TIMING (drums only, separate selector): "raw" — the §7.4 merkle
//     onsets exactly as mathematically defined — or explicit quantization to
//     ¼/⅛/1/16. The paint dial never touches the block layer.
// Paint events live on the 40-tick lattice (the common refinement of straight
// sixteenths 120 and eighth-triplets 160 — every legal paint position is a
// whole number of units, so both families coexist with zero drift):
//   ons[u]   = 1 → a written hit at tick u*40
//   rests[u] = L → silence window [u*40, (u+L)*40) — suppresses EVERY hit that
//              starts inside it (ghost, quantized, or painted); painted rests
//              carry the step size at the time they were drawn.
// Render-time only: blocks still derive E(R) verbatim; canonical files
// untouched (MIDI-PROTOCOL.md §11).

import { BAR_TICKS } from "./protocol.js"; // 1920

export const SEQ_UNIT = 40;                    // lattice ticks (16th ÷ 3)
export const UNITS_PER_BAR = BAR_TICKS / SEQ_UNIT; // 48
export const SEQ_UNITS_MAX = 16 * UNITS_PER_BAR;   // 768 = 16 bars
export const SEQ_EXTENTS = [1, 2, 4, 8, 16];       // bars — looping window
export const SEQ_DEFAULT_BARS = 4;

// paint dial: base selections (steps/bar) and the triplet mapping (owner ruling:
// ³ applies to ♩ and ♪ only; 16th unavailable in ³ mode → falls back to ♪³)
export const PAINT_SELS = [1, 2, 4, 8, 16];
export const TRIPLET_MAP = { 4: 6, 8: 12, 16: 12 }; // 6=¼³(320t), 12=♪³(160t)
export const EFFECTIVE_STEPS = [1, 2, 4, 6, 8, 12, 16];
export const SEQ_DEFAULT_SEL = 8; // eighths

export const paintStepsPerBar = (sel, triplet) =>
  (triplet && TRIPLET_MAP[sel] != null) ? TRIPLET_MAP[sel] : sel;
export const stepTicks = (stepsPerBar) => BAR_TICKS / stepsPerBar; // 1920/n
export const stepUnits = (stepsPerBar) => stepTicks(stepsPerBar) / SEQ_UNIT; // int ✓

export function seqLoopTicks(bars) { return bars * BAR_TICKS; }
export function seqUnitWindow(bars) { return bars * UNITS_PER_BAR; }

// ── block-ghost hits for a lane (raw onsets, or explicit quantize grid) ──
export function blockGhostTicks(onsets, loopTicks, { extTicks, quantTicks = 0 }) {
  const hits = new Set();
  if (!quantTicks) { // RAW — sacrosanct: exact §7.4 onset positions,
    for (const o of onsets) { // repeated/truncated to the looping window
      if (loopTicks <= extTicks) {
        for (let rep = 0; rep * loopTicks < extTicks; rep++) {
          const t = o.tick + rep * loopTicks;
          if (t < extTicks) hits.add(t);
        }
      } else {
        if (o.tick < extTicks) hits.add(o.tick);
      }
    }
  } else { // explicit block-timing quantize (nearest grid tick)
    for (const o of onsets) {
      if (loopTicks <= extTicks) {
        for (let rep = 0; rep * loopTicks < extTicks; rep++) {
          const t = Math.round((o.tick + rep * loopTicks) / quantTicks) * quantTicks;
          if (t < extTicks) hits.add(t);
        }
      } else {
        const t = Math.round(o.tick / quantTicks) * quantTicks;
        if (t < extTicks) hits.add(t);
      }
    }
  }
  return hits;
}

// ── merged lane timeline: (ghost ∪ painted-on) minus rest windows, sorted ──
// Returns a plain Array of ticks in [0, extTicks). Deterministic and cheap.
export function laneTimeline({ onsets, loopTicks, extTicks, quantTicks, ons, rests }) {
  const units = Math.floor(extTicks / SEQ_UNIT);
  const ghosts = onsets && loopTicks
    ? blockGhostTicks(onsets, loopTicks, { extTicks, quantTicks })
    : new Set();
  const covered = new Uint8Array(units);
  for (let u = 0; u < units; u++) {
    const L = rests[u];
    if (L) {
      const end = Math.min(units, u + L);
      for (let k = u; k < end; k++) covered[k] = 1;
    }
  }
  const ticks = [];
  for (const t of ghosts) {
    if (!covered[Math.floor(t / SEQ_UNIT)]) ticks.push(t);
  }
  for (let u = 0; u < units; u++) {
    if (ons[u] && !covered[u]) {
      const t = u * SEQ_UNIT;
      if (!ghosts.has(t)) ticks.push(t);
    }
  }
  ticks.sort((a, b) => a - b);
  return ticks;
}

// ── session codec (&f): per lane — nOn u16, on-unit u16s; nRest u16, (u16,u8) ──
export function encodeLanes(lanes) {
  const bytes = [];
  for (const id of DRUM_LANES) {
    const ln = lanes[id] || {};
    const ons = ln.ons || [], rests = ln.rests || [];
    const onList = [], restList = [];
    for (let u = 0; u < SEQ_UNITS_MAX; u++) {
      if (ons[u]) onList.push(u);
      if (rests[u]) restList.push([u, Math.max(1, Math.min(255, rests[u]))]);
    }
    bytes.push(onList.length & 0xff, (onList.length >> 8) & 0xff);
    for (const u of onList) bytes.push(u & 0xff, (u >> 8) & 0xff);
    bytes.push(restList.length & 0xff, (restList.length >> 8) & 0xff);
    for (const [u, L] of restList) bytes.push(u & 0xff, (u >> 8) & 0xff, L);
  }
  return bytes;
}

export function decodeLanes(bytes) {
  const out = {};
  let p = 0;
  const u16 = () => bytes[p] | (bytes[p + 1] << 8), p2 = () => { p += 2; };
  for (const id of DRUM_LANES) {
    const arr = () => {
      const lane = { ons: new Array(SEQ_UNITS_MAX).fill(0), rests: new Array(SEQ_UNITS_MAX).fill(0) };
      if (p + 2 > bytes.length) return null;
      let n = u16(); p2();
      if (p + n * 2 > bytes.length) return null;
      for (let i = 0; i < n; i++) { const u = u16(); p2(); if (u < SEQ_UNITS_MAX) lane.ons[u] = 1; }
      if (p + 2 > bytes.length) return null;
      n = u16(); p2();
      if (p + n * 3 > bytes.length) return null;
      for (let i = 0; i < n; i++) {
        const u = u16(); p2(); const L = bytes[p++];
        if (u < SEQ_UNITS_MAX && L >= 1 && L <= 255) lane.rests[u] = L;
      }
      return lane;
    };
    const lane = arr();
    if (!lane) return null;
    out[id] = lane;
  }
  return p === bytes.length ? out : null;
}

// ── legacy v1.4 &d (current-res cell array, 0/1/2) → event lanes ──
// Old semantics: col index in the link's paint grid. Convert: tick = col×cellTicks.
export function lanesFromLegacy(bytes, oldSteps) {
  if (!EFFECTIVE_STEPS.includes(oldSteps) && ![1, 2, 4, 8, 16].includes(oldSteps)) return null;
  const cellUnits = stepTicks(oldSteps) / SEQ_UNIT;
  const out = {};
  let p = 0;
  for (const id of DRUM_LANES) {
    const lane = { ons: new Array(SEQ_UNITS_MAX).fill(0), rests: new Array(SEQ_UNITS_MAX).fill(0) };
    if (p + 2 > bytes.length) return null;
    const n = bytes[p] | (bytes[p + 1] << 8);
    p += 2;
    if (p + n > bytes.length || n > SEQ_UNITS_MAX) return null;
    for (let i = 0; i < n; i++) {
      const v = bytes[p++];
      const u = i * cellUnits;
      if (u >= SEQ_UNITS_MAX) continue;
      if (v === 1) lane.ons[u] = 1;
      else if (v === 2) lane.rests[u] = cellUnits;
    }
    out[id] = lane;
  }
  return p === bytes.length ? out : null;
}

export function lanesHaveEdits(lanes) {
  return DRUM_LANES.some((id) => {
    const ln = lanes[id];
    return ln && (ln.ons.some((v) => v) || ln.rests.some((v) => v));
  });
}

// customary low→high: VOICES order IS bass-drum, snare, hat-closed, hat-open —
// lanes draw bottom row → top row in this order.
export const DRUM_LANES = ["bass-drum", "snare", "hat-closed", "hat-open"];
export const LANE_LABELS = { "bass-drum": "kick", "snare": "snare", "hat-closed": "hat·c", "hat-open": "hat·o" };
