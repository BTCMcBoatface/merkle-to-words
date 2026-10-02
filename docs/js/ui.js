// ui.js — DOM wiring + product flow (polling, snapshots, paint).
// State lives here (blocks array + engine slots + map); state.js handles
// URL/localStorage; engine.js handles audio, placement, rotation mechanics.

import { derivePattern, PROTOCOL_ID, PROTOCOL_VERSION } from "./protocol.js";
import { deriveMelody, noteName, CELL_TICKS, MAP_CELLS } from "./notes.js";
import { fetchTip, fetchByHeight } from "./api.js";
import { downloadMidi, downloadMidiMapped } from "./smf.js";
import { Ensemble, MAX_BLOCKS } from "./engine.js";
import { getVoice } from "./synth.js";
import * as session from "./state.js";

const LIVE_POLL_MS = 60000;
const SNAP_KEY = "m2m…s-v1";

const engine = new Ensemble();
let blocks = [];           // [{height, rootHex, pattern, melody?, scale?}]
let selected = null;       // {kind:'block'|'slot', idx} — tap-to-move mode
let busy = false;
let liveTimer = null;
let livePrimed = false;    // first tick after arming just baselines the height
let lastTipHeight = null;
let paintNote = 0;         // 0 = erase mode; else MIDI note stamped on tap
let paletteShift = 0;      // palette octave offset

const $ = (s) => document.querySelector(s);
const slotsEl = $("#slots"), shelfEl = $("#shelf"), statusEl = $("#status");
const playBtn = $("#playBtn"), modeBtn = $("#modeBtn"), bpmInput = $("#bpmInput");
const liveBtn = $("#liveBtn"), srcBtn = $("#srcBtn");

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
    map: Array.from(engine.map),
    source: engine.melodySource,
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

// move = the ONE block-per-slot rule; any manual placement exits LIVE
function placeBlock(block, slotIdx, { headStart = false } = {}) {
  disarmLive();
  const prev = slotIndexOf(block);
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

// ── melody map panel ──
srcBtn.addEventListener("click", () => {
  engine.setMelodySource(engine.melodySource === "merkle" ? "none" : "merkle");
  persist(); render();
});
$("#clearMapBtn").addEventListener("click", () => { engine.clearMap(); persist(); render(); });
$("#fillBtn").addEventListener("click", () => {
  const idx = parseInt($("#fillSelect").value, 10);
  const b = blocks[idx];
  if (!b || !b.melody) { setStatus("pick a block with a melody to fill", true); return; }
  const map = Array.from(engine.map);
  b.pattern.onsets.forEach((o, i) => {
    const cell = Math.floor((o.tick % (CELL_TICKS * MAP_CELLS)) / CELL_TICKS);
    if (o.tick < b.pattern.loopTicks) map[cell] = b.melody[i % b.melody.length];
  });
  engine.setMap(map);
  setStatus(`map filled from #${b.height ?? b.rootHex.slice(0, 8)} (${b.scale.modeName} ${b.scale.rootNoteName})`);
  persist(); render();
});

function renderMap() {
  // palette: erase + octave shifts + 24 chromatic buttons (C3..B4, shiftable)
  const pal = $("#palette");
  pal.textContent = "";
  const addChip = (label, cls, isSel, fn) => {
    const b = document.createElement("button");
    b.textContent = label;
    if (cls) b.className = cls;
    if (isSel) b.classList.add("sel");
    b.addEventListener("click", fn);
    pal.appendChild(b);
  };
  addChip("erase", "erase", paintNote === 0, () => { paintNote = 0; render(); });
  addChip("◀8vb", "", paletteShift < 0, () => { paletteShift = Math.max(-24, paletteShift - 12); render(); });
  for (let n = 48 + paletteShift; n <= 71 + paletteShift; n++) {
    addChip(noteName(n), "", paintNote === n, () => { paintNote = n; render(); });
  }
  addChip("8vb▶", "", paletteShift > 0, () => { paletteShift = Math.min(24, paletteShift + 12); render(); });

  // grid: 64 cells in two 32-cell rows (4 bars each), barline every 8
  const grid = $("#mapGrid");
  grid.textContent = "";
  engine.map.forEach((v, idx) => {
    const c = document.createElement("div");
    c.className = "cell" + (v ? " filled" : "") + (idx % 8 === 0 ? " barline" : "");
    c.textContent = v ? noteName(v) : "";
    c.title = `eighth ${idx + 1}`;
    c.addEventListener("click", () => {
      const map = Array.from(engine.map);
      map[idx] = paintNote;
      engine.setMap(map);
      persist(); render();
    });
    grid.appendChild(c);
  });

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
}

// mapped export pitches: painted cell → merkle melody (deterministic; voice
// defaults are a player concept and never enter files — M2M-NOTES §6)
function exportPitches(b) {
  if (!b.melody) return null;
  return b.pattern.onsets.map((o, i) => {
    const cell = Math.floor((o.tick % (CELL_TICKS * MAP_CELLS)) / CELL_TICKS);
    return engine.map[cell] || b.melody[i % b.melody.length];
  });
}

// ── snapshots ──
function loadSnaps() { try { return JSON.parse(localStorage.getItem(SNAP_KEY)) || []; } catch (e) { return []; } }
function saveSnaps(list) { try { localStorage.setItem(SNAP_KEY, JSON.stringify(list)); } catch (e) { } }
$("#snapSave").addEventListener("click", () => {
  const name = $("#snapName").value.trim() || `arr ${new Date().toLocaleTimeString()}`;
  const list = loadSnaps();
  list.push({ name, ts: Date.now(), state: view() });
  saveSnaps(list.slice(-20)); // cap 20 snapshots
  $("#snapName").value = "";
  setStatus(`snapshot "${name}" saved`);
  render();
});

// ── rendering ──
function render() {
  // drop dangling selection (e.g., a selected block was just evicted by live mode)
  if (selected && selected.kind === "block" && !blocks[selected.idx]) selected = null;
  slotsEl.textContent = "";
  engine.slots.forEach((s, i) => {
    const voice = getVoice(s.voiceId);
    const el = document.createElement("div");
    el.className = "slot" + (s.muted ? " muted" : "") +
      (selected && selected.kind === "slot" && selected.idx === i ? " selected-slot" : "");

    const inst = document.createElement("div");
    inst.className = "inst";
    inst.textContent = voice.label;
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
    if (s.block) {
      el.draggable = true;
      el.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", JSON.stringify({ kind: "slot", idx: i }));
        e.dataTransfer.effectAllowed = "move";
      });
    }
    slotsEl.appendChild(el);
  });

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
      (b.scale ? ` · ${b.scale.rootNoteName} ${b.scale.modeName}` : "") +
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
    dl2.title = "mapped export (M2M-NOTES draft): rhythm identical, pitched";
    dl2.addEventListener("click", (e) => {
      e.stopPropagation();
      const pitches = exportPitches(b);
      if (!pitches) { setStatus("no melody derived for this block", true); return; }
      downloadMidiMapped(b.pattern.notes, pitches, b.rootHex, b.height);
    });
    row.appendChild(dl2);
    const rm = document.createElement("button");
    rm.textContent = "✕";
    rm.title = "remove block";
    rm.addEventListener("click", (e) => { e.stopPropagation(); removeBlock(b); });
    row.appendChild(rm);
    card.appendChild(row);
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

  renderMap();

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
$("#copyBtn").addEventListener("click", async () => {
  const url = session.shareURL(view());
  try { await navigator.clipboard.writeText(url); setStatus("session link copied"); }
  catch (e) { setStatus(url); }
});
$("#resetBtn").addEventListener("click", () => {
  engine.stop();
  disarmLive(true);
  blocks = []; selected = null;
  engine.slots.forEach((s, i) => engine.clearSlot(i));
  engine.clearMap();
  engine.setMelodySource("none");
  try { localStorage.removeItem("m2m-rhythm-session-v1"); } catch (e) { }
  history.replaceState(null, "", location.pathname);
  bootFresh();
});
$("#fetchLatest").addEventListener("click", async () => {
  try { const tip = await fetchTip(); const b = await addBlock(tip); if (b) autoPlace(b); }
  catch (e) { setStatus(String(e.message || e), true); }
  render();
});
$("#fetchHeight").addEventListener("click", async () => {
  const v = $("#heightInput").value;
  if (!v.trim()) { setStatus("enter a block height first", true); return; }
  try { const blk = await fetchByHeight(v); const b = await addBlock(blk); if (b) autoPlace(b); }
  catch (e) { setStatus(String(e.message || e), true); }
  render();
});
$("#heightInput").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#fetchHeight").click(); });

function autoPlace(b) {
  const i = firstEmptySlot();
  if (i >= 0) placeBlock(b, i);
  else { persist(); render(); } // shelf-parked
}

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
  if (st.map) engine.setMap(st.map);
  if (st.source) engine.setMelodySource(st.source);
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
  if (tag) tag.textContent = `${PROTOCOL_ID} v${PROTOCOL_VERSION} · bitcoin merkle roots → rhythm · +M2M-NOTES v1.0.0`;
  const st = session.load();
  if (st) await applySessionAsync(st); else await bootFresh();
  render();
  window.__m2m = {
    engine, derivePattern, deriveMelody, blocks: () => blocks,
    PROTOCOL_VERSION, exportPitches,
  };
})();
