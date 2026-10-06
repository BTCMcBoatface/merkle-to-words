// seq.js — drum sequencer geometry + codecs (pure, DOM-free, Node-importable).
// Ribbon model: ONE shared grid (extent in bars, like the melody map) at a
// selectable step resolution (whole → 16th). Each drum lane holds tri-state
// cells over a FIXED SEQ_MAX_STEPS column store:
//   0 = inherit — the assigned block's merkle onsets, quantized (nearest cell)
//   1 = on      — forced hit (plays standalone, even with no block)
//   2 = rest    — explicit hole (suppresses the quantized hit)
// Render-time only: the block's own E(R) and canonical .mid files are untouched
// (MIDI-PROTOCOL.md §11). Quantization = floor-free nearest-cell mapping of
// §7.4 onsets onto the chosen musical grid; triplets/dotted values merge when
// they collapse to the same cell.

import { BAR_TICKS } from "./protocol.js";

// customary low→high: VOICES order already IS bass-drum, snare, hat-closed,
// hat-open — lanes draw bottom row → top row in this order.
export const DRUM_LANES = ["bass-drum", "snare", "hat-closed", "hat-open"];
export const LANE_LABELS = { "bass-drum": "kick", "snare": "snare", "hat-closed": "hat·c", "hat-open": "hat·o" };

export const SEQ_RESOLUTIONS = [1, 2, 4, 8, 16]; // steps per bar: whole…16th
export const SEQ_DEFAULT_RES = 8;                // eighths (matches the map grid)
export const SEQ_MAX_STEPS = 16 * 16;            // 256 cols = 16 bars of sixteenths
export const SEQ_EXTENTS = [1, 2, 4, 8, 16];     // bars — same selector family as the map
export const SEQ_DEFAULT_BARS = 4;

export const seqCellTicks = (res) => BAR_TICKS / res;          // 1920/res
export const seqActiveCols = (res, bars) => res * bars;        // looping window
export const seqLoopTicks = (res, bars) => seqActiveCols(res, bars) * seqCellTicks(res); // = bars*1920

// Quantize a block's onsets (one loop) onto the ribbon grid: nearest cell,
// repeating when the loop is shorter than the extent, truncating when longer.
export function quantizeBlockCols(onsets, { loopTicks, res, bars }) {
  const cell = seqCellTicks(res);
  const active = seqActiveCols(res, bars);
  const extTicks = active * cell;
  const cols = new Set();
  for (const o of onsets) {
    if (loopTicks <= extTicks) {
      for (let rep = 0; rep * loopTicks < extTicks; rep++) {
        const c = Math.round((o.tick + rep * loopTicks) / cell);
        if (c < active) cols.add(c);
      }
    } else {
      const c = Math.round(o.tick / cell);
      if (c < active) cols.add(c);
    }
  }
  return cols;
}

// Re-snap manual cells from one grid to another (on-the-fly resolution change):
// position in TICKS is preserved, nearest new cell wins. "On" beats "rest"
// when two cells collide. Returns a fresh array; cols beyond the new max store
// are dropped (256 covers every legal res×bars pair).
export function resnapCells(arr, oldRes, newRes) {
  const out = new Array(SEQ_MAX_STEPS).fill(0);
  if (oldRes === newRes) return arr.slice();
  const oldCell = seqCellTicks(oldRes), newCell = seqCellTicks(newRes);
  for (let c = 0; c < arr.length; c++) {
    const v = arr[c];
    if (!v) continue;
    const nc = Math.min(SEQ_MAX_STEPS - 1, Math.round((c * oldCell) / newCell));
    if (out[nc] === 0 || v === 1) out[nc] = v;
  }
  return out;
}

// ── session codec: 4 lanes, count-prefixed trimmed bytes (0-inherit tail) ──
export function encodeLanes(cellsByLane) {
  const bytes = [];
  for (const id of DRUM_LANES) {
    const u = cellsByLane[id] || [];
    let n = u.length;
    while (n > 0 && u[n - 1] === 0) n--;
    bytes.push(n & 0xff, (n >> 8) & 0xff);
    for (let i = 0; i < n; i++) bytes.push(u[i] > 2 ? 0 : u[i]); // only 0/1/2 travel
  }
  return bytes;
}

export function decodeLanes(bytes) {
  const out = {};
  let p = 0;
  for (const id of DRUM_LANES) {
    if (p + 2 > bytes.length) return null;
    const n = bytes[p] | (bytes[p + 1] << 8);
    p += 2;
    if (n > SEQ_MAX_STEPS || p + n > bytes.length) return null;
    const arr = new Array(SEQ_MAX_STEPS).fill(0);
    for (let i = 0; i < n; i++) arr[i] = bytes[p + i];
    p += n;
    out[id] = arr;
  }
  return p === bytes.length ? out : null;
}

export function lanesHaveEdits(cellsByLane) {
  return DRUM_LANES.some((id) => (cellsByLane[id] || []).some((v) => v));
}
