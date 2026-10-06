// ui.js — DOM wiring + product flow (polling, snapshots, paint).
// State lives here (blocks array + engine slots + map); state.js handles
// URL/localStorage; engine.js handles audio, placement, rotation mechanics.
// Folded ♯ view and the keyboard window are view state, never data.

import { derivePattern, PROTOCOL_ID, PROTOCOL_VERSION } from "./protocol.js";
import { deriveMelody, noteName, CELL_TICKS, foldMidi, mapTicksFor } from "./notes.js";
import { fetchTip, fetchByHeight } from "./api.js";
import { downloadMidi, downloadMidiMapped } from "./smf.js";
import { Ensemble, MAX_BLOCKS } from "./engine.js";
import { getVoice, TONE_SCHEMA, TONE_DEFAULTS, toneFor, setTone, resetTone, LFO_RATES, LFO_DEFAULT_RATE, getMods, setMods, clearMods } from "./synth.js";
import { DRUM_LANES, LANE_LABELS } from "./seq.js";
import * as tonebank from "./tonebank.js";
import { APP_VERSION } from "./version.js";
import * as session from "./state.js";

const LIVE_POLL_MS = 60000;
const SNAP_KEY = "m2m-snapshots-v1";
const SNAP_KEY_LEGACY = "m2m…s-v1"; // pre-v1.5 shipped constant (stray “…” glyph — intentional literal, migration-only)
function migrateSnaps() {
  try {
    if (localStorage.getItem(SNAP_KEY) === null && localStorage.getItem(SNAP_KEY_LEGACY) !== null) {
      localStorage.setItem(SNAP_KEY, localStorage.getItem(SNAP_KEY_LEGACY));
      localStorage.removeItem(SNAP_KEY_LEGACY);
    }
  } catch (e) { /* private mode */ }
}

const engine = new Ensemble();
// sound layer (local-only persistence — see tonebank.js): restore before boot
const bank = tonebank.load() || tonebank.blank();
for (const id of Object.keys(TONE_SCHEMA)) {
  setTone(id, bank.tone[id]);
  setMods(id, (bank.mods && bank.mods[id]) || {});
}
engine.setReverb(bank.reverb);
let openTone = null;         // slot index whose tone panel is open (view state)
let uiLfoRate = LFO_DEFAULT_RATE;  // ∿ cycle chooser in the tone panel
let lastModToggle = { voice: null, key: null, t: 0 }; // double-fire guard (touch long-press + synthetic contextmenu)
let blocks = [];             // [{height, rootHex, pattern, melody?, scale?}]
let selected = null;       // {kind:'block'|'slot', idx} — tap-to-move mode
let busy = false;
let liveTimer = null;
let livePrimed = false;    // first tick after arming just baselines the height
let lastTipHeight = null;

const $ = (s) => document.querySelector(s);
const slotsEl = $("#slots"), shelfEl = $("#shelf"), statusEl = $("#status");
const playBtn = $("#playBtn"), modeBtn = $("#modeBtn"), bpmInput = $("#bpmInput");
const liveBtn = $("#liveBtn"), srcBtn = $("#srcBtn");
const reverbIn = $("#reverbIn");
reverbIn.addEventListener("input", () => {
  engine.setReverb(parseInt(reverbIn.value, 10) / 100);
  bank.reverb = engine.reverb;
  tonebank.save(bank);
});

engine.onChange(() => render());

// ── helpers ──
function setStatus(msg, err = false) {
  statusEl.textContent = msg || "";
  statusEl.classList.toggle("err", err);
}
function findBlock(rootHex) { return blocks.find((b) => b.rootHex === rootHex) || null; }
function firstEmptySlot() {
  for (let i = 0; i < engine.slots.length; i++) if (!engine.slots[i].block) return i;
  return -1;
}
function slotIndexOf(block) {
  for (let i = 0; i < engine.slots.length; i++) if (engine.slots[i].block === block) return i;
  return -1;
}
function view() {
  return {
    blocks: blocks.map((b) => ({ height: b.height, rootHex: b.rootHex })),
    slots: engine.slots.map((s) => (s.block ? blocks.indexOf(s.block) : -1)),
    mode: engine.mode,
    transpose: engine.slots.map((s) => s.transpose | 0),
    bpm: engine.bpm,
    cells: engine.cells.map((c) => c.slice()),
    mapBars: engine.mapBars,
    polyphony: engine.polyphony,
    mapOffset: engine.mapOffset,
    source: engine.melodySource,
    seq: {
      res: engine.seq.res,
      bars: engine.seq.bars,
      modes: Object.assign({}, engine.seq.modes),
      cells: DRUM_LANES.reduce((o, id) => { o[id] = engine.seq.cells[id].slice(); return o; }, {}),
    },
  };
}
function persist() { session.save(view()); }

// ── block acquisition (on-request; LIVE poll uses this too) ──
async function addBlock({ height, merkleRoot }) {
  const existing = findBlock(merkleRoot);
  if (existing) return existing;
  if (blocks.length >= MAX_BLOCKS) { setStatus(`collection full (${MAX_BLOCKS} max) — remove a block first`, true); return null; }
  busy = true; setStatus("deriving pattern…"); render();
  try {
    const pattern = await derivePattern(merkleRoot);
    const b = { height, rootHex: merkleRoot, pattern };
    try { const mel = await deriveMelody(merkleRoot); b.melody = mel.melody32; b.scale = mel.scale; }
    catch (e) { /* melodic layer optional */ }
    blocks.push(b);
    setStatus(`#${height ?? "?"} · ${pattern.barCount}-bar loop · ${pattern.notes.length} notes` +
      (pattern.noteCountWrapped ? " (wrapped)" : ""));
    return b;
  } catch (e) {
    setStatus(String(e.message || e), true);
    return null;
  } finally {
    busy = false;
  }
}

function removeBlock(b) {
  disarmLive();
  const i = slotIndexOf(b);
  if (i >= 0) engine.clearSlot(i);
  blocks = blocks.filter((x) => x !== b);
  if (selected && selected.kind === "block" && blocks.indexOf(b) < 0) selected = null;
  persist(); render();
}

// shelf-by-default: manual fetches land on the shelf, never auto-assigned
// (LIVE arrivals and the first-load demo are the only auto-placements).
function shelfOnly(b) {
  setStatus(`#${b.height ?? "?"} on the shelf — assign via the block's ▾ menu or drag`);
  persist(); render();
}

// move = the ONE block-per-slot rule; any manual placement exits LIVE.
// slotIdx < 0 = send to shelf. Destination slot occupied? setSlot overwrite IS the
// evict-to-shelf ruling: the displaced block simply loses its slot, stays in the
// collection, appears on the shelf.
function placeBlock(block, slotIdx, { headStart = false } = {}) {
  disarmLive();
  const prev = slotIndexOf(block);
  if (slotIdx < 0) {
    if (prev >= 0) engine.clearSlot(prev);
    selected = null;
    persist(); render();
    return;
  }
  if (prev >= 0 && prev !== slotIdx) engine.clearSlot(prev);
  engine.setSlot(slotIdx, block, { headStart });
  selected = null;
  persist(); render();
}

// ── LIVE mode (conductor) ──
// Polls ONLY while armed; rotation happens only when the chain actually
// produces a new block. Mechanism (rotateOneStep) lives in the engine.
function armLive() {
  engine.setLive(true);
  livePrimed = false;
  liveTick(); // immediate baseline/arrival check
  liveTimer = setInterval(liveTick, LIVE_POLL_MS);
  persist(); render();
}
function disarmLive(silent = false) {
  if (!engine.live) return;
  engine.setLive(false);
  if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
  livePrimed = false; lastTipHeight = null;
  if (!silent) setStatus("live disarmed — manual arrangement");
  render();
}
async function liveTick() {
  try {
    const tip = await fetchTip();
    if (!livePrimed) { // baseline: never rotate on the arrival we were handed
      livePrimed = true; lastTipHeight = tip.height;
      setStatus(`live: watching chain at #${tip.height}`);
      render();
      return;
    }
    if (tip.height === lastTipHeight) { setStatus(`live: watching #${tip.height}`); render(); return; }
    lastTipHeight = tip.height;
    if (findBlock(tip.merkleRoot)) { render(); return; } // already known (manual add)
    // a real arrival: evict oldest at cap, rotate placement one step, place new
    if (blocks.length >= MAX_BLOCKS) {
      const old = blocks[0];
      const oi = slotIndexOf(old);
      if (oi >= 0) engine.clearSlot(oi);
      blocks = blocks.slice(1);
    }
    engine.rotateOneStep();
    const b = await addBlock(tip);
    if (b) {
      let slot = firstEmptySlot();
      if (slot < 0) { engine.clearSlot(0); slot = 0; }
      engine.setSlot(slot, b);
    }
    setStatus(`LIVE: block #${tip.height} arrived — arrangement rotated`);
    persist(); render();
  } catch (e) {
    setStatus(`live poll failed: ${String(e.message || e)}`, true); // stays armed
  }
}
liveBtn.addEventListener("click", () => {
  if (engine.live) disarmLive(); else armLive();
});

// ── melody map panel (M2M-NOTES v2 piano roll) ──
// Time left→right (eighth columns over the map's own 4/8/16-bar length), pitch
// up→down (2-octave window, default C2–B3, ◀/▶ octave shifter). Mouse-down paints
// immediately and a held drag covers everything it crosses (interpolated);
// right-drag removes that pitch from the column. The map is GLOBAL truth: it
// loops at its own length, in sync across every instrument; drum slots never.
const ROWS = 24, ROW_H = 14, GUT = 46, CELL_MIN_W = 16;
const BLACK_SET = new Set([1, 3, 6, 8, 10]);
let octShift = 0;                       // view offset: rows shown (not data)
let mapGeom = { cellW: CELL_MIN_W, cols: 32, rows: [] };
let stroking = false, eraseStroke = false, lastXY = null, strokeDirty = false;
let foldSharps = false;                   // view filter: natural rows only (data untouched)
const WHITES = new Set([0, 2, 4, 5, 7, 9, 11]);

const viewTop = () => 59 + 12 * octShift;   // top pitch of window (B3 default)

function rowsPitches() {
  const top = viewTop();
  const list = [];
  for (let p = top; p > top - 24; p--) {
    if (!foldSharps || WHITES.has(((p % 12) + 12) % 12)) list.push(p);
  }
  return list;
}

srcBtn.addEventListener("click", () => {
  engine.setMelodySource(engine.melodySource === "merkle" ? "none" : "merkle");
  persist(); render();
});
$("#clearMapBtn").addEventListener("click", () => { engine.clearMap(); persist(); render(); });
$("#barsSeg").querySelectorAll("button").forEach((btn) =>
  btn.addEventListener("click", () => {
    engine.setMapBars(parseInt(btn.dataset.bars, 10));
    persist(); render();
  }));
$("#keyDown").addEventListener("click", () => { engine.setMapOffset(engine.mapOffset - 1); persist(); render(); });
$("#keyUp").addEventListener("click", () => { engine.setMapOffset(engine.mapOffset + 1); persist(); render(); });
$("#foldBtn").addEventListener("click", () => { foldSharps = !foldSharps; renderMap(); syncMapBtns(); });
$("#polyChk").addEventListener("change", (e) => {
  engine.setPolyphony(e.target.checked); persist(); render();
});
$("#octDown").addEventListener("click", () => { octShift = Math.max(-1, octShift - 1); drawMap(); });
$("#octUp").addEventListener("click", () => { octShift = Math.min(4, octShift + 1); drawMap(); });

// ── drum sequencer controls (on-the-fly grid morph; live-safe) ──
document.querySelectorAll("#seqResSeg button").forEach((btn) =>
  btn.addEventListener("click", () => {
    engine.setSeqRes(parseInt(btn.dataset.res, 10));
    persist(); render();
  }));
document.querySelectorAll("#seqBarsSeg button").forEach((btn) =>
  btn.addEventListener("click", () => {
    engine.setSeqBars(parseInt(btn.dataset.sbars, 10));
    persist(); render();
  }));
$("#seqClearBtn").addEventListener("click", () => {
  for (const id of DRUM_LANES) engine.seq.cells[id].fill(0);
  setStatus("drum steps cleared — inherited block ghosts stay");
  persist(); render();
});

$("#fillBtn").addEventListener("click", () => {
  const idx = parseInt($("#fillSelect").value, 10);
  const b = blocks[idx];
  if (!b || !b.melody) { setStatus("pick a block with a melody to fill", true); return; }
  const cols = engine.activeCols;                      // wrap at ACTIVE extent
  b.pattern.onsets.forEach((o, i) => {
    engine.paintCell(Math.floor((o.tick % (cols * CELL_TICKS)) / CELL_TICKS),
      b.melody[i % b.melody.length]);
  });
  setStatus(`map filled from #${b.height ?? b.rootHex.slice(0, 8)} (${b.scale.rootNoteName} ${b.scale.modeName})`);
  persist(); render();
});

function cellFromXY(x, y) {
  const { cellW, cols, rows } = mapGeom;
  if (x < GUT) return null;
  const col = Math.floor((x - GUT) / cellW);
  const row = Math.floor(y / ROW_H);
  if (col < 0 || col >= cols || row < 0 || row >= rows.length) return null;
  const pitch = rows[row];
  if (pitch < 21 || pitch > 108) return null;
  return { col, pitch };
}

function strokeAt(x, y) {
  const c = cellFromXY(x, y);
  if (!c) return;
  if (eraseStroke) engine.eraseCellPitch(c.col, c.pitch);
  else engine.paintCell(c.col, c.pitch);
  strokeDirty = true;
}

function drawMap() {
  const canvas = $("#mapCanvas"), wrap = $("#mapWrap");
  const cols = engine.mapBars * 8;             // visible/editable window (loop extent)
  const rows = rowsPitches();
  const cellW = Math.max(CELL_MIN_W, Math.floor((wrap.clientWidth - GUT - 6) / cols));
  mapGeom = { cellW, cols, rows };
  canvas.width = GUT + cellW * cols;
  canvas.height = rows.length * ROW_H + 2;
  const g = canvas.getContext("2d");
  g.clearRect(0, 0, canvas.width, canvas.height);
  const H = rows.length * ROW_H;

  rows.forEach((pitch, r) => {
    const white = WHITES.has(((pitch % 12) + 12) % 12);
    g.fillStyle = (!foldSharps && !white) ? "#12141b" : "#1e2330";
    g.fillRect(0, r * ROW_H, canvas.width, ROW_H);
    if (white) {
      g.fillStyle = pitch % 12 === 0 ? "#dfe6f0" : "#8a93a6";
      g.font = "9px ui-monospace, Menlo, monospace";
      g.fillText(noteName(pitch), 4, r * ROW_H + ROW_H - 4);
    }
    if (pitch % 12 === 0) {   // C baselines
      g.strokeStyle = "#2a3040"; g.lineWidth = 1;
      g.beginPath(); g.moveTo(GUT, (r + 1) * ROW_H + 0.5); g.lineTo(canvas.width, (r + 1) * ROW_H + 0.5); g.stroke();
    }
  });
  for (let col = 0; col <= cols; col++) {
    const x = GUT + col * cellW + 0.5;
    g.strokeStyle = col % 8 === 0 ? "#4a5468" : (col % 2 === 0 ? "rgba(42,48,64,.9)" : "rgba(42,48,64,.4)");
    g.lineWidth = col % 8 === 0 ? 1.4 : 1;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
  }
  g.fillStyle = "#7dd3fc";
  for (let col = 0; col < cols; col++) {
    const stack = engine.cells[col] || [];
    for (const p of stack) {
      const r = rows.indexOf(p);
      if (r >= 0) {
        g.fillRect(GUT + col * cellW + 1, r * ROW_H + 1, Math.max(2, cellW - 2), ROW_H - 2);
      } else if (foldSharps) {
        // hidden sharp (black key) whose natural-below row is visible: notch marker
        const rn = rows.indexOf(p - 1);
        if (rn >= 0) {
          g.beginPath();
          g.moveTo(GUT + (col + 1) * cellW - 2, rn * ROW_H + 2);
          g.lineTo(GUT + (col + 1) * cellW - 2, rn * ROW_H + ROW_H - 3);
          g.lineTo(GUT + col * cellW + 2, rn * ROW_H + ROW_H / 2);
          g.closePath(); g.fill();
        }
      }
    }
  }
  g.fillStyle = "#8a93a6"; g.font = "8px sans-serif";
  for (let bar = 0; bar < cols / 8; bar++) g.fillText(String(bar + 1), GUT + bar * 8 * cellW + 2, H - 2);
}

function wireMapCanvas() {
  const canvas = $("#mapCanvas");
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    stroking = true; eraseStroke = (e.button === 2); strokeDirty = false;
    lastXY = [e.clientX - r.left, e.clientY - r.top];
    strokeAt(...lastXY);
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { }
    drawMap();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!stroking) return;
    const r = canvas.getBoundingClientRect();
    const xy = [e.clientX - r.left, e.clientY - r.top];
    // interpolate between samples so fast drags never skip columns
    const [x0, y0] = lastXY, [x1, y1] = xy;
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.ceil(dist / (mapGeom.cellW / 3)));
    for (let k = 1; k <= steps; k++)
      strokeAt(x0 + (x1 - x0) * k / steps, y0 + (y1 - y0) * k / steps);
    lastXY = xy;
    if (strokeDirty) { drawMap(); strokeDirty = false; }
  });
  const endStroke = () => {
    if (!stroking) return;
    stroking = false; eraseStroke = false;
    persist(); render();
  };
  canvas.addEventListener("pointerup", endStroke);
  canvas.addEventListener("pointercancel", endStroke);
}

function syncMapBtns() {
  const fb = $("#foldBtn");
  if (fb) { fb.classList.toggle("sel", foldSharps); fb.textContent = foldSharps ? "♯ folded" : "♯ fold"; }
}

function renderSeq() {
  document.querySelectorAll("#seqResSeg button").forEach((btn) =>
    btn.classList.toggle("sel", parseInt(btn.dataset.res, 10) === engine.seq.res));
  document.querySelectorAll("#seqBarsSeg button").forEach((btn) =>
    btn.classList.toggle("sel", parseInt(btn.dataset.sbars, 10) === engine.seq.bars));
  drawSeq();
}

function renderMap() {
  // control sync
  $("#polyChk").checked = engine.polyphony;
  document.querySelectorAll("#barsSeg button").forEach((btn) =>
    btn.classList.toggle("sel", parseInt(btn.dataset.bars, 10) === engine.mapBars));
  const kl = $("#keyLbl"); if (kl) kl.textContent = engine.mapOffset === 0 ? "±0" : (engine.mapOffset > 0 ? `+${engine.mapOffset}` : `−${-engine.mapOffset}`);
  syncMapBtns();

  // fill selector
  const sel = $("#fillSelect");
  const prevVal = sel.value;
  sel.textContent = "";
  blocks.forEach((b, i) => {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = `#${b.height ?? "?"} ${b.rootHex.slice(0, 8)}${b.melody ? ` · ${b.scale.rootNoteName} ${b.scale.modeName}` : ""}`;
    sel.appendChild(o);
  });
  if (prevVal && blocks[parseInt(prevVal, 10)]) sel.value = prevVal;
  else if (blocks.length) sel.value = String(blocks.length - 1);

  drawMap();
}

// mapped export pitch SETS: painted stack → else the block's merkle melody
// (deterministic; voice defaults are a player concept and never enter files — §6)
// ── drum sequencer (v1.4 ribbons) ──
// Four horizontal lanes, customary kit order bottom→top (kick, snare, hat·c,
// hat·o). One shared grid: extent in bars (map-style) × live resolution
// (whole→16th). Cells are tri-state — tap cycles inherit ▸ on ▸ rest ▸ inherit;
// a held stroke paints that target across the row; right-drag clears to
// inherit. Inherited cells ghost the assigned block's quantized rhythm. Tapping
// the gutter flips the lane raw-merkle ▸ seq-ribbon. Pure render-time: blocks
// still derive E(R) untouched; "raw" lanes behave exactly as before.
const SQ_ROWS = 4, SQ_ROW_H = 26, SQ_GUT = 46;
let seqGeom = { cellW: 12, cols: 32 };
let seqStroke = null, lastSeqXY = null;

function seqCellFromXY(x, y) {
  if (x < SQ_GUT) {
    const r = Math.floor(y / SQ_ROW_H);
    if (r < 0 || r >= SQ_ROWS) return null;
    return { gutter: true, lane: DRUM_LANES[SQ_ROWS - 1 - r] };
  }
  const col = Math.floor((x - SQ_GUT) / seqGeom.cellW);
  const r = Math.floor(y / SQ_ROW_H);
  if (col < 0 || col >= seqGeom.cols || r < 0 || r >= SQ_ROWS) return null;
  return { lane: DRUM_LANES[SQ_ROWS - 1 - r], col };
}

function drawSeq() {
  const canvas = $("#seqCanvas"), wrap = $("#seqWrap");
  if (!canvas || !wrap) return;
  const cols = engine.seqActiveCols, res = engine.seq.res;
  const cellW = Math.max(12, Math.floor((wrap.clientWidth - SQ_GUT - 6) / cols));
  seqGeom = { cellW, cols };
  canvas.width = SQ_GUT + cellW * cols;
  canvas.height = SQ_ROWS * SQ_ROW_H + 2;
  const g = canvas.getContext("2d");
  g.clearRect(0, 0, canvas.width, canvas.height);

  const quants = {};
  for (const id of DRUM_LANES) quants[id] = engine.seqQuantCols(id);

  for (let r = 0; r < SQ_ROWS; r++) {
    const lane = DRUM_LANES[SQ_ROWS - 1 - r];          // bottom row = kick
    const y = r * SQ_ROW_H;
    const seqMode = engine.seq.modes[lane] === "seq";
    g.fillStyle = seqMode ? "#1e2330" : "#141722";
    g.fillRect(SQ_GUT, y, cellW * cols, SQ_ROW_H);
    g.fillStyle = seqMode ? "#7dd3fc" : "#8a93a6";
    g.font = "9px ui-monospace, Menlo, monospace";
    g.fillText(LANE_LABELS[lane], 4, y + 10);
    // mode pill — whole gutter is the tap target; ▾ says "press me"
    if (seqMode) {
      g.fillStyle = "#7dd3fc"; g.fillRect(3, y + 13, 40, 12);
      g.fillStyle = "#06202e";
    } else {
      g.strokeStyle = "#3a4256"; g.lineWidth = 1; g.strokeRect(3.5, y + 13.5, 39, 11);
      g.fillStyle = "#8a93a6";
    }
    g.font = "bold 8px sans-serif";
    g.fillText(seqMode ? "SEQ ▾" : "raw ▾", lane === "bass-drum" || lane === "hat-closed" ? 9 : 10, y + 21.5);

    const cells = engine.seq.cells[lane], qset = quants[lane];
    for (let c = 0; c < cols; c++) {
      const x = SQ_GUT + c * cellW;
      const st = cells[c];
      if (st === 1) {
        g.fillStyle = "#7dd3fc";
        g.fillRect(x + 1, y + 2, Math.max(2, cellW - 2), SQ_ROW_H - 4);
      } else if (st === 2) {
        g.strokeStyle = "#f87171"; g.lineWidth = 1.4;
        g.beginPath();
        g.moveTo(x + 3, y + SQ_ROW_H / 2 - 4); g.lineTo(x + cellW - 3, y + SQ_ROW_H / 2 + 4);
        g.moveTo(x + cellW - 3, y + SQ_ROW_H / 2 - 4); g.lineTo(x + 3, y + SQ_ROW_H / 2 + 4);
        g.stroke();
      } else if (qset && qset.has(c)) {
        g.fillStyle = seqMode ? "rgba(125,211,252,.45)" : "rgba(125,211,252,.20)";
        g.fillRect(x + 2, y + 4, Math.max(1, cellW - 4), SQ_ROW_H - 8);
      }
    }
  }
  const H = SQ_ROWS * SQ_ROW_H;
  for (let c = 0; c <= cols; c++) {                     // beat/bar grid on top
    const x = SQ_GUT + c * cellW + 0.5;
    const isBar = c % res === 0;
    const isBeat = res >= 4 && c % (res / 4) === 0;
    g.strokeStyle = isBar ? "#4a5468" : (isBeat ? "rgba(42,48,64,.9)" : "rgba(42,48,64,.35)");
    g.lineWidth = isBar ? 1.4 : 1;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
  }
  g.fillStyle = "#8a93a6"; g.font = "8px sans-serif";
  for (let b = 0; b < engine.seq.bars; b++) g.fillText(String(b + 1), SQ_GUT + b * res * cellW + 2, H - 2);
}

function seqStrokeAt(x, y) {
  if (!seqStroke) return;
  const h = seqCellFromXY(x, y);
  if (!h || h.gutter || h.lane !== seqStroke.lane) return;
  engine.seqPaint(h.lane, h.col, seqStroke.val);
  drawSeq();
}

function wireSeqCanvas() {
  const canvas = $("#seqCanvas");
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const h = seqCellFromXY(x, y);
    if (!h) return;
    if (h.gutter) {
      engine.seqToggleMode(h.lane);
      const m = engine.seq.modes[h.lane];
      setStatus(`${LANE_LABELS[h.lane]} lane → ${m === "seq" ? "SEQ — the ribbon plays" : "raw merkle"}`);
      persist(); render(); return;
    }
    let val;
    if (e.button === 2) { val = 0; engine.seqPaint(h.lane, h.col, 0); } // right-drag clears to inherit
    else { val = engine.seqCycle(h.lane, h.col); }                      // tap: inherit ▸ on ▸ rest ▸ inherit
    // Painting an audible cell (hit or rest) in a raw lane ARMS the lane —
    // edits must never silently do nothing (v1.4.1, owner-reported confusion)
    if (val !== 0 && engine.seq.modes[h.lane] !== "seq") {
      engine.seqToggleMode(h.lane);
      setStatus(`${LANE_LABELS[h.lane]} armed: SEQ — your edits play now (tap its pill for raw)`);
    }
    seqStroke = { lane: h.lane, val };
    lastSeqXY = [x, y];
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { }
    drawSeq();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!seqStroke) return;
    const r = canvas.getBoundingClientRect();
    const xy = [e.clientX - r.left, e.clientY - r.top];
    const [x0, y0] = lastSeqXY, [x1, y1] = xy;
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.ceil(dist / (seqGeom.cellW / 3)));
    for (let k = 1; k <= steps; k++)
      seqStrokeAt(x0 + (x1 - x0) * k / steps, y0 + (y1 - y0) * k / steps);
    lastSeqXY = xy;
  });
  const endStroke = () => {
    if (!seqStroke) return;
    seqStroke = null;
    persist(); render();
  };
  canvas.addEventListener("pointerup", endStroke);
  canvas.addEventListener("pointercancel", endStroke);
}

// mapped export pitch SETS: painted column (capo applied) → else the block's
// merkle melody (deterministic; voice defaults never enter files — M2M-NOTES §6).
// Looping wraps at the ACTIVE extent (mapBars), never the 128-col storage.
function exportPitchSets(b) {
  if (!b.melody) return null;
  const mapTicks = mapTicksFor(engine.mapBars);        // wrap at ACTIVE extent
  return b.pattern.onsets.map((o, i) => {
    const stack = engine.cells[Math.floor((o.tick % mapTicks) / CELL_TICKS)];
    if (stack && stack.length)
      return stack.map((p) => foldMidi(p + engine.mapOffset));   // capo in, fold 21–108
    return [b.melody[i % b.melody.length]];
  });
}

// ── snapshots ──
function loadSnaps() { migrateSnaps(); try { return JSON.parse(localStorage.getItem(SNAP_KEY)) || []; } catch (e) { return []; } }
function saveSnaps(list) { try { localStorage.setItem(SNAP_KEY, JSON.stringify(list)); } catch (e) { } }
$("#snapSave").addEventListener("click", () => {
  const name = $("#snapName").value.trim() || `arr ${new Date().toLocaleTimeString()}`;
  const list = loadSnaps();
  list.push({ name, ts: Date.now(), appVersion: APP_VERSION, state: view() });
  saveSnaps(list.slice(-20)); // cap 20 snapshots
  $("#snapName").value = "";
  setStatus(`snapshot "${name}" saved`);
  render();
});

// ── tone panels (edit-sound; render-time dials per melodic voice) ──
// The panel opens as an instrument POPUP anchored under the slot card —
// ~70% of the app width, at least 2 card widths so drawbars have slide room,
// capped at 620px — because the narrow grid column cannot host the organ's
// 8 dials + favorites legibly. Panel state writes straight into
// synth.js's live params (effect on the next triggered note) + tonebank.js
// localStorage. Deliberately NO session persist and NO full render() on slider
// input — dragging a slider must not rebuild the DOM under the finger.
function persistTone(voiceId) {
  bank.tone[voiceId] = { ...toneFor(voiceId) };
  bank.mods[voiceId] = JSON.parse(JSON.stringify(getMods(voiceId) || {}));
  tonebank.save(bank);
}
function toggleMod(voiceId, d) {
  const now = Date.now();
  if (lastModToggle.voice === voiceId && lastModToggle.key === d.key && now - lastModToggle.t < 450) return;
  lastModToggle = { voice: voiceId, key: d.key, t: now };
  const mods = getMods(voiceId);
  if (mods[d.key]) { delete mods[d.key]; setStatus(`∿ ${d.label} oscillation off`); }
  else { mods[d.key] = { rate: uiLfoRate }; setStatus(`∿ ${d.label} oscillates min↔max once per ${rateName(uiLfoRate)}`); }
  persistTone(voiceId);
  render();
}
const rateName = (steps) => (LFO_RATES.find((r) => r.steps === steps) || LFO_RATES[3]).name;
function fmt(d, v) {
  if (d.unit === "Hz") return String(Math.round(v));
  if (d.unit === "s") return String(Math.round(v * 1000) / 1000);
  return String(Math.round(v * 100) / 100);
}

// center the popup under its slot, clamped inside the viewport
function positionTonePopup(slotEl, panel) {
  const r = slotEl.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const pw = panel.offsetWidth || Math.min(Math.max(vw * 0.7, 310), vw - 16, 620);
  let gLeft = r.left + (r.width - pw) / 2;
  gLeft = Math.max(8, Math.min(gLeft, vw - pw - 8));
  panel.style.left = (gLeft - r.left) + "px";
}

function buildTonePanel(voiceId) {
  const p = toneFor(voiceId);
  const wrap = document.createElement("div");
  wrap.className = "tone";
  wrap.addEventListener("click", (e) => e.stopPropagation());

  const head = document.createElement("div");
  head.className = "thead";
  const ttl = document.createElement("span");
  ttl.textContent = `${getVoice(voiceId).label} · sound`;
  const x = document.createElement("button");
  x.textContent = "✕"; x.title = "close (or Esc)";
  x.addEventListener("click", () => { openTone = null; render(); });
  head.appendChild(ttl); head.appendChild(x);
  wrap.appendChild(head);

  // ∿ cycle chooser: a complete sine loop over the chosen musical duration
  const crow = document.createElement("div");
  crow.className = "wrow crow";
  const clbl = document.createElement("span");
  clbl.textContent = "∿ cycle";
  crow.appendChild(clbl);
  for (const r of LFO_RATES) {
    const b = document.createElement("button");
    b.textContent = r.label; b.title = `one full min→max→min cycle per ${r.name}`;
    if (uiLfoRate === r.steps) b.classList.add("sel");
    b.addEventListener("click", () => {
      uiLfoRate = r.steps;
      const mods = getMods(voiceId);
      for (const k of Object.keys(mods)) mods[k].rate = r.steps; // retune all live mods
      persistTone(voiceId);
      render();
    });
    crow.appendChild(b);
  }
  wrap.appendChild(crow);

  for (const d of TONE_SCHEMA[voiceId]) {
    const row = document.createElement("div");
    if (d.type === "enum") {
      row.className = "wrow";
      const lbl = document.createElement("span");
      lbl.textContent = d.label;
      row.appendChild(lbl);
      for (const opt of d.options) {
        const b = document.createElement("button");
        b.textContent = opt === "sawtooth" ? "saw" : opt === "triangle" ? "tri" : opt;
        b.title = opt;
        if (p[d.key] === opt) b.classList.add("sel");
        b.addEventListener("click", () => {
          p[d.key] = opt;
          persistTone(voiceId);
          row.querySelectorAll("button").forEach((x) => x.classList.toggle("sel", x.title === opt));
        });
        row.appendChild(b);
      }
    } else {
      row.className = "frow";
      const modded = !!(getMods(voiceId) || {})[d.key];
      if (modded) row.classList.add("mod");
      row.title = "right-click / long-press: oscillate this dial min↔max";
      const lbl = document.createElement("label");
      lbl.textContent = (modded ? "∿ " : "") + d.label;
      const inp = document.createElement("input");
      inp.type = "range"; inp.min = d.min; inp.max = d.max; inp.step = d.step; inp.value = p[d.key];
      inp.setAttribute("aria-label", `${d.label} (${voiceId})`);
      const out = document.createElement("output");
      out.textContent = fmt(d, p[d.key]);
      inp.addEventListener("input", () => {
        p[d.key] = parseFloat(inp.value);
        out.textContent = fmt(d, p[d.key]);
        persistTone(voiceId);
      });
      // toggle the oscillation: right-click anywhere on the row (desktop) or
      // a 500 ms hold without drag (touch); deduped via lastModToggle
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault(); e.stopPropagation();
        toggleMod(voiceId, d);
      });
      inp.addEventListener("pointerdown", (e) => {
        if (e.button === 2) return; // handled by contextmenu
        const sx = e.clientX, sy = e.clientY;
        let timer = setTimeout(() => {
          timer = null;
          toggleMod(voiceId, d);
        }, 500);
        const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
        const move = (ev) => { if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 10) cancel(); };
        inp.addEventListener("pointermove", move);
        inp.addEventListener("pointerup", cancel);
        inp.addEventListener("pointercancel", cancel);
      });
      row.appendChild(lbl); row.appendChild(inp); row.appendChild(out);
    }
    wrap.appendChild(row);
  }

  const srow = document.createElement("div");
  srow.className = "tbtns";
  const nameIn = document.createElement("input");
  nameIn.className = "tname"; nameIn.placeholder = "favorite name"; nameIn.maxLength = 24;
  nameIn.setAttribute("aria-label", "favorite tone name");
  const sv = document.createElement("button");
  sv.className = "btn mini"; sv.textContent = "💾 save";
  sv.addEventListener("click", () => {
    const nm = nameIn.value.trim() || `tone ${new Date().toLocaleTimeString()}`;
    tonebank.addFav(bank, voiceId, nm, { ...p }, getMods(voiceId));
    setStatus(`favorite "${nm}" saved (${(bank.favs[voiceId] || []).length}/8)`);
    render();
  });
  nameIn.addEventListener("keydown", (e) => { if (e.key === "Enter") sv.click(); });
  const rst = document.createElement("button");
  rst.className = "btn mini"; rst.textContent = "reset";
  rst.title = "back to this voice's built-in defaults";
  rst.title = "back to this voice's built-in defaults (also clears ∿ mods)";
  rst.addEventListener("click", () => {
    setTone(voiceId, TONE_DEFAULTS[voiceId]); clearMods(voiceId); persistTone(voiceId);
    setStatus(`${getVoice(voiceId).label}: tone reset to defaults`);
    render();
  });
  srow.appendChild(nameIn); srow.appendChild(sv); srow.appendChild(rst);
  wrap.appendChild(srow);

  (bank.favs[voiceId] || []).forEach((f, i) => {
    const fr = document.createElement("div");
    fr.className = "favrow";
    const nm = document.createElement("span");
    nm.className = "fname"; nm.textContent = f.name;
    const use = document.createElement("button");
    use.textContent = "use";
    use.addEventListener("click", () => {
      setTone(voiceId, f.params);
      setMods(voiceId, f.mods || {});
      persistTone(voiceId);
      setStatus(`tone "${f.name}" loaded${Object.keys(f.mods || {}).length ? ` (with ∿ ${Object.keys(f.mods).length} mod${Object.keys(f.mods).length > 1 ? "s" : ""})` : ""}`);
      render();
    });
    const del = document.createElement("button");
    del.textContent = "✕"; del.title = "delete favorite";
    del.addEventListener("click", () => { tonebank.removeFav(bank, voiceId, i); render(); });
    fr.appendChild(nm); fr.appendChild(use); fr.appendChild(del);
    wrap.appendChild(fr);
  });
  return wrap;
}

// ── rendering ──
function render() {
  // drop dangling selection (e.g., a selected block was just evicted by live mode)
  if (selected && selected.kind === "block" && !blocks[selected.idx]) selected = null;
  let pendingTonePos = null; // popup must be measured once its slot is in the DOM
  slotsEl.textContent = "";
  engine.slots.forEach((s, i) => {
    const voice = getVoice(s.voiceId);
    const el = document.createElement("div");
    el.className = "slot" + (s.muted ? " muted" : "") +
      (selected && selected.kind === "slot" && selected.idx === i ? " selected-slot" : "");

    const inst = document.createElement("div");
    inst.className = "inst";
    inst.textContent = voice.label + (!voice.melodic && engine.seq.modes[s.voiceId] === "seq" ? " · seq" : "");
    el.appendChild(inst);

    if (s.block) {
      const bl = document.createElement("div");
      bl.className = "block";
      bl.textContent = `#${s.block.height ?? "•"} ${s.block.rootHex.slice(0, 8)} · ${s.block.pattern.barCount}bar`;
      el.appendChild(bl);
    } else {
      const em = document.createElement("div");
      em.className = "empty";
      em.textContent = "drop a block";
      el.appendChild(em);
    }

    const acts = document.createElement("div");
    acts.className = "actions";
    const muteBtn = document.createElement("button");
    muteBtn.textContent = s.muted ? "unmute" : "mute";
    muteBtn.className = s.muted ? "on" : "";
    muteBtn.addEventListener("click", (e) => { e.stopPropagation(); engine.toggleMute(i); persist(); });
    acts.appendChild(muteBtn);
    if (TONE_SCHEMA[s.voiceId]) {
      const snd = document.createElement("button");
      snd.textContent = "sound";
      snd.title = "edit sound — tone dials for this voice (saved in this browser)";
      if (openTone === i) snd.classList.add("on");
      snd.addEventListener("click", (e) => {
        e.stopPropagation();
        openTone = (openTone === i) ? null : i;
        render();
      });
      acts.appendChild(snd);
    }
    if (s.block) {
      const out = document.createElement("button");
      out.textContent = "unassign";
      out.addEventListener("click", (e) => {
        e.stopPropagation(); disarmLive(); engine.clearSlot(i); selected = null; persist(); render();
      });
      acts.appendChild(out);
    }
    el.appendChild(acts);

    if (voice.melodic) {
      const tRow = document.createElement("div");
      tRow.className = "transpose";
      for (const [label, delta] of [["−12", -12], ["−1", -1], ["+1", 1], ["+12", 12]]) {
        const tb = document.createElement("button");
        tb.textContent = label;
        tb.title = `${delta > 0 ? "up" : "down"} ${Math.abs(delta) === 12 ? "an octave" : "a semitone"}`;
        tb.addEventListener("click", (e) => {
          e.stopPropagation();
          engine.setTranspose(i, (s.transpose | 0) + delta);
          persist();
        });
        tRow.appendChild(tb);
      }
      const tv = document.createElement("span");
      tv.className = "tval";
      tv.textContent = s.transpose ? `T${s.transpose > 0 ? "+" : ""}${s.transpose}` : "";
      tRow.appendChild(tv);
      el.appendChild(tRow);
      if (TONE_SCHEMA[s.voiceId] && openTone === i) {
        const tp = buildTonePanel(s.voiceId);
        el.appendChild(tp);
        pendingTonePos = { slotEl: el, panel: tp };
      }
    }

    el.addEventListener("click", () => {
      if (selected && selected.kind === "block") {
        placeBlock(blocks[selected.idx], i);
      } else if (selected && selected.kind === "slot" && selected.idx !== i) {
        const moving = engine.slots[selected.idx].block;
        if (moving) placeBlock(moving, i);
        selected = null; render();
      } else {
        selected = (selected && selected.kind === "slot" && selected.idx === i) ? null : { kind: "slot", idx: i };
        render();
      }
    });
    el.addEventListener("dragover", (e) => { e.preventDefault(); el.classList.add("over"); });
    el.addEventListener("dragleave", () => el.classList.remove("over"));
    el.addEventListener("drop", (e) => {
      e.preventDefault(); el.classList.remove("over");
      let data; try { data = JSON.parse(e.dataTransfer.getData("text/plain")); } catch (err) { return; }
      if (data.kind === "block") placeBlock(blocks[data.idx], i);
      else if (data.kind === "slot" && data.idx !== i) {
        const moving = engine.slots[data.idx].block;
        if (moving) placeBlock(moving, i);
      }
    });
    // while the tone panel is open the slot must not be a native drag source
    // (a slider drag would get hijacked by the parent's draggable=true)
    if (s.block && openTone !== i) {
      el.draggable = true;
      el.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", JSON.stringify({ kind: "slot", idx: i }));
        e.dataTransfer.effectAllowed = "move";
      });
    }
    slotsEl.appendChild(el);
  });
  if (pendingTonePos) positionTonePopup(pendingTonePos.slotEl, pendingTonePos.panel);

  // shelf
  shelfEl.textContent = "";
  if (!blocks.length) {
    const h = document.createElement("div");
    h.className = "hint";
    h.textContent = "no blocks yet — get latest or fetch a height";
    shelfEl.appendChild(h);
  }
  blocks.forEach((b, i) => {
    const card = document.createElement("div");
    const inSlot = slotIndexOf(b);
    card.className = "block-card" +
      (selected && selected.kind === "block" && selected.idx === i ? " selected" : "") +
      (inSlot >= 0 ? " queued" : "");
    card.draggable = true;
    card.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", JSON.stringify({ kind: "block", idx: i }));
      e.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("click", () => {
      if (inSlot >= 0) selected = { kind: "slot", idx: inSlot };
      else selected = (selected && selected.kind === "block" && selected.idx === i) ? null : { kind: "block", idx: i };
      render();
    });

    const id = document.createElement("div");
    id.className = "id";
    id.textContent = b.height != null ? `#${b.height}` : "manual root";
    card.appendChild(id);
    const root = document.createElement("div");
    root.className = "root";
    root.textContent = `${b.rootHex.slice(0, 8)}…${b.rootHex.slice(-4)}`;
    card.appendChild(root);
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${b.pattern.barCount} bar · ${b.pattern.notes.length} notes` +
      (inSlot >= 0 ? " → " + getVoice(engine.slots[inSlot].voiceId).label : " · shelf");
    card.appendChild(meta);

    const row = document.createElement("div");
    row.className = "row";
    const dl = document.createElement("button");
    dl.textContent = "⤓ .mid";
    dl.title = "download this block's protocol-conformant MIDI";
    dl.addEventListener("click", (e) => { e.stopPropagation(); downloadMidi(b.pattern.notes, b.rootHex, b.height); });
    row.appendChild(dl);
    const dl2 = document.createElement("button");
    dl2.textContent = "⤓ notes";
    dl2.title = "mapped export (M2M-NOTES v2.1): rhythm identical, pitched (capo included)";
    dl2.addEventListener("click", (e) => {
      e.stopPropagation();
      const sets = exportPitchSets(b);
      if (!sets) { setStatus("no melody derived for this block", true); return; }
      downloadMidiMapped(b.pattern.notes, sets, b.rootHex, b.height);
    });
    row.appendChild(dl2);
    const rm = document.createElement("button");
    rm.textContent = "✕";
    rm.title = "remove block";
    rm.addEventListener("click", (e) => { e.stopPropagation(); removeBlock(b); });
    row.appendChild(rm);
    card.appendChild(row);

    // assign dropdown: re-assign anywhere without dragging (shelf-by-default UX).
    // Moving onto an occupied instrument evicts that occupant to the shelf.
    const asg = document.createElement("select");
    asg.className = "assign";
    asg.title = "assign / re-assign — a displaced block goes to the shelf";
    const mkOpt = (v, label) => {
      const o = document.createElement("option");
      o.value = String(v); o.textContent = label;
      asg.appendChild(o);
    };
    mkOpt(-1, "▾ shelf (unassigned)");
    engine.slots.forEach((s, si) => mkOpt(si, getVoice(s.voiceId).label));
    asg.value = String(inSlot);
    asg.addEventListener("click", (e) => e.stopPropagation());
    asg.addEventListener("change", () => placeBlock(b, parseInt(asg.value, 10)));
    card.appendChild(asg);
    shelfEl.appendChild(card);
  });

  $("#blockCount").textContent = `${blocks.length}/${MAX_BLOCKS}`;
  playBtn.textContent = engine.playing ? "■ stop" : "▶ play";
  modeBtn.textContent = engine.mode === "master" ? "8-bar cycle" : "bars";
  playBtn.disabled = busy;
  liveBtn.classList.toggle("on", engine.live);
  srcBtn.textContent = engine.melodySource === "merkle" ? "source: merkle" : "source: voice";
  srcBtn.classList.toggle("on", engine.melodySource === "merkle");
  if (document.activeElement !== bpmInput) bpmInput.value = engine.pendingBpm ?? engine.bpm;
  bpmInput.classList.toggle("pending", !!engine.pendingBpm);
  if (document.activeElement !== reverbIn) reverbIn.value = String(Math.round(engine.reverb * 100));

  renderMap();
  renderSeq();

  // snapshots
  const list = $("#snapList");
  list.textContent = "";
  loadSnaps().forEach((snap, i) => {
    const chip = document.createElement("div");
    chip.className = "snap";
    const nm = document.createElement("span");
    nm.textContent = snap.name;
    chip.appendChild(nm);
    const use = document.createElement("button");
    use.textContent = "use";
    use.addEventListener("click", () => applySessionAsync(snap.state));
    chip.appendChild(use);
    const del = document.createElement("button");
    del.textContent = "✕";
    del.addEventListener("click", () => {
      const l = loadSnaps(); l.splice(i, 1); saveSnaps(l); render();
    });
    chip.appendChild(del);
    list.appendChild(chip);
  });
}

// ── transport wiring ──
playBtn.addEventListener("click", () => {
  if (engine.playing) engine.stop(); else engine.play();
  persist(); render();
});
modeBtn.addEventListener("click", () => {
  engine.setMode(engine.mode === "master" ? "independent" : "master");
  setStatus(engine.mode === "master"
    ? "master cycle: parts re-align to bar 0 every cycle"
    : "independent: parts loop freely on the bar grid");
  persist(); render();
});
function applyBpmInput() {
  const v = parseInt(bpmInput.value, 10);
  if (Number.isNaN(v)) { render(); return; }
  try {
    const boundary = engine.setBpm(v);
    if (boundary !== null) setStatus(`tempo → ${engine.pendingBpm} BPM at next ${engine.mode === "master" ? "cycle" : "bar"}`);
    else setStatus(`tempo set to ${engine.bpm} BPM`);
  } catch (e) { setStatus(String(e.message || e), true); }
  persist(); render();
}
bpmInput.addEventListener("change", applyBpmInput);
bpmInput.addEventListener("keydown", (e) => { if (e.key === "Enter") bpmInput.blur(); });
$("#resyncBtn").addEventListener("click", () => {
  engine.resyncAllToTop();
  setStatus("re-aligned: all parts back to tick 0");
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && openTone !== null) { openTone = null; render(); }
});
$("#copyBtn").addEventListener("click", async () => {
  const url = session.shareURL(view());
  try { await navigator.clipboard.writeText(url); setStatus("session link copied"); }
  catch (e) { setStatus(url); }
});
let clearArmed = false, clearTimer = null;
const resetBtn = $("#resetBtn");
function disarmClear() {
  clearArmed = false;
  if (clearTimer) { clearTimeout(clearTimer); clearTimer = null; }
  resetBtn.textContent = "✕"; resetBtn.classList.remove("armed");
}
resetBtn.addEventListener("click", () => {
  if (!clearArmed) {                       // two-click confirm: clear ≠ reset
    clearArmed = true;
    resetBtn.textContent = "clear?"; resetBtn.classList.add("armed");
    clearTimer = setTimeout(disarmClear, 3500);
    return;
  }
  disarmClear();
  // CLEAR: unassign every block to the shelf; collection, map, tempo, transpose
  // all survive. No fetch, no demo (that is first-load only), LIVE disarmed.
  engine.stop();
  disarmLive(true);
  engine.slots.forEach((s, i) => engine.clearSlot(i));
  selected = null;
  persist(); render();
  setStatus("cleared — all blocks returned to the shelf");
});
$("#fetchLatest").addEventListener("click", async () => {
  try { const tip = await fetchTip(); const b = await addBlock(tip); if (b) shelfOnly(b); }
  catch (e) { setStatus(String(e.message || e), true); }
  render();
});
$("#fetchHeight").addEventListener("click", async () => {
  const v = $("#heightInput").value;
  if (!v.trim()) { setStatus("enter a block height first", true); return; }
  try { const blk = await fetchByHeight(v); const b = await addBlock(blk); if (b) shelfOnly(b); }
  catch (e) { setStatus(String(e.message || e), true); }
  render();
});
$("#heightInput").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#fetchHeight").click(); });

// first-load demo is the ONE auto-assign outside LIVE (owner ruling)

// ── boot / session apply ──
async function applySessionAsync(st) {
  disarmLive(true);
  const rebuilt = [];
  for (const k of st.blocks) {
    try {
      const pattern = await derivePattern(k.rootHex);
      const b = { height: k.height, rootHex: k.rootHex, pattern };
      try { const mel = await deriveMelody(k.rootHex); b.melody = mel.melody32; b.scale = mel.scale; } catch (e) { }
      rebuilt.push(b);
    } catch (e) { /* bad root → skip */ }
  }
  blocks = rebuilt;
  engine.setMode(st.mode || "independent");
  if (st.transpose) st.transpose.forEach((t, i) => { if (engine.slots[i]) engine.slots[i].transpose = t | 0; });
  if (st.bpm && st.bpm !== engine.bpm) { try { engine.setBpm(st.bpm); } catch (e) { } }
  if (st.mapBars) engine.setMapBars(st.mapBars);
  if (st.mapOffset) engine.setMapOffset(st.mapOffset);
  engine.setPolyphony(!!st.polyphony);
  engine.clearMap();
  if (st.cells) st.cells.forEach((c, i) => {
    if (engine.cells[i]) engine.cells[i] = (c || []).filter((p) => p >= 21 && p <= 108).slice(0, 7);
  });
  engine.emit();
  if (st.source) engine.setMelodySource(st.source);
  engine.setSeqState(st.seq || null);
  engine.slots.forEach((s, i) => { s.block = null; s.part = null; });
  (st.slots || []).forEach((bi, i) => { if (bi >= 0 && blocks[bi]) engine.setSlot(i, blocks[bi]); });
  selected = null;
  setStatus("session applied");
  persist(); render();
}

async function bootFresh() {
  setStatus("fetching current block…");
  try {
    const tip = await fetchTip();
    const b = await addBlock(tip);
    if (b) placeBlock(b, 0); // bass drum slot per plan
    setStatus(`live tip #${tip.height} placed on Bass Drum — press play`);
  } catch (e) {
    setStatus(`offline? ${String(e.message || e)} — fetch a height manually`, true);
  }
  persist(); render();
}

(async function boot() {
  const tag = document.getElementById("protocolTag");
  if (tag) tag.textContent = `${PROTOCOL_ID} v${PROTOCOL_VERSION} · bitcoin merkle roots → rhythm · +M2M-NOTES v2.1.0 · player v${APP_VERSION}`;
  const st = session.load();
  if (st) await applySessionAsync(st); else await bootFresh();
  wireMapCanvas();
  wireSeqCanvas();
  window.addEventListener("resize", () => { drawMap(); drawSeq(); if (openTone !== null) render(); });
  render();
  window.__m2m = {
    engine, derivePattern, deriveMelody, blocks: () => blocks,
    PROTOCOL_VERSION, exportPitchSets,
  };
})();
