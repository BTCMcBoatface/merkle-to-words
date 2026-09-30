// ui.js — DOM wiring. State lives here (blocks array + engine slots);
// state.js handles URL/localStorage; engine.js handles audio + placement.

import { derivePattern, PROTOCOL_VERSION } from "./protocol.js";
import { fetchTip, fetchByHeight } from "./api.js";
import { downloadMidi } from "./smf.js";
import { Ensemble, MAX_BLOCKS, SLOT_INSTRUMENTS } from "./engine.js";
import { getVoice } from "./synth.js";
import * as session from "./state.js";

const engine = new Ensemble();
let blocks = [];           // [{height, rootHex, pattern}]
let selected = null;       // {kind:'block'|'slot', idx} — tap-to-move mode
let busy = false;

const $ = (s) => document.querySelector(s);
const slotsEl = $("#slots"), shelfEl = $("#shelf"), statusEl = $("#status");
const playBtn = $("#playBtn"), modeBtn = $("#modeBtn"), bpmInput = $("#bpmInput");

// engine mutators (mute etc.) notify us so the DOM always matches state
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
  };
}
function persist() { session.save(view()); }

// ── block acquisition (on-request only) ──
async function addBlock({ height, merkleRoot }) {
  const existing = findBlock(merkleRoot);
  if (existing) { setStatus(`block #${height ?? "?"} already in collection`); return existing; }
  if (blocks.length >= MAX_BLOCKS) { setStatus(`collection full (${MAX_BLOCKS} max) — remove a block first`, true); return null; }
  busy = true; setStatus("deriving pattern…"); render();
  try {
    const pattern = await derivePattern(merkleRoot);
    const b = { height, rootHex: merkleRoot, pattern };
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
  const i = slotIndexOf(b);
  if (i >= 0) engine.clearSlot(i);
  blocks = blocks.filter((x) => x !== b);
  if (selected && selected.kind === "block" && blocks.indexOf(b) < 0) selected = null;
  persist(); render();
}

// ── placement: move = the ONE block-per-slot rule; tapping a busy slot swaps ──
function placeBlock(block, slotIdx, { headStart = false } = {}) {
  const prev = slotIndexOf(block);
  if (prev >= 0 && prev !== slotIdx) engine.clearSlot(prev); // move, not copy
  engine.setSlot(slotIdx, block, { headStart });
  selected = null;
  persist(); render();
}

// ── rendering ──
function render() {
  // slots
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
      const b = s.block;
      const bl = document.createElement("div");
      bl.className = "block";
      bl.textContent = `#${b.height ?? "•"} ${b.rootHex.slice(0, 8)} · ${b.pattern.barCount}bar`;
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
      out.addEventListener("click", (e) => { e.stopPropagation(); engine.clearSlot(i); selected = null; persist(); render(); });
      acts.appendChild(out);
    }
    el.appendChild(acts);

    // transpose: melodic voices only — our drum synths are unpitched and
    // ignore midiNote, so a semitone shift on percussion is meaningless
    if (voice.melodic) {
      const tRow = document.createElement("div");
      tRow.className = "transpose";
      for (const [label, delta] of [["−12", -12], ["−1", -1], ["+1", 1], ["+12", 12]]) {
        const tb = document.createElement("button");
        tb.textContent = label;
        tb.title = `${delta > 0 ? "up" : "down"} ${Math.abs(delta) === 12 ? "an octave" : "a semitone"}`;
        tb.addEventListener("click", (e) => {
          e.stopPropagation();
          const nv = Math.max(-24, Math.min(24, (s.transpose | 0) + delta));
          engine.setTranspose(i, nv);
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

    // tap-to-move
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
    // drag target (desktop)
    el.addEventListener("dragover", (e) => { e.preventDefault(); el.classList.add("over"); });
    el.addEventListener("dragleave", () => el.classList.remove("over"));
    el.addEventListener("drop", (e) => {
      e.preventDefault(); el.classList.remove("over");
      let data; try { data = JSON.parse(e.dataTransfer.getData("text/plain")); } catch { return; }
      if (data.kind === "block") placeBlock(blocks[data.idx], i);
      else if (data.kind === "slot" && data.idx !== i) {
        const moving = engine.slots[data.idx].block;
        if (moving) placeBlock(moving, i);
      }
    });
    // drag source from occupied slot
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
  const free = blocks.filter((b) => slotIndexOf(b) < 0);
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
      if (inSlot >= 0) { selected = { kind: "slot", idx: inSlot }; }
      else { selected = (selected && selected.kind === "block" && selected.idx === i) ? null : { kind: "block", idx: i }; }
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
    meta.textContent = `${b.pattern.barCount} bar · ${b.pattern.notes.length} notes${inSlot >= 0 ? " → " + getVoice(engine.slots[inSlot].voiceId).label : (blocks.length > 7 && !free.includes(b) ? "" : " · shelf")}`;
    card.appendChild(meta);

    const row = document.createElement("div");
    row.className = "row";
    const dl = document.createElement("button");
    dl.textContent = "⤓ .mid";
    dl.title = "download this block's protocol-conformant MIDI";
    dl.addEventListener("click", (e) => { e.stopPropagation(); downloadMidi(b.pattern.notes, b.rootHex, b.height); });
    row.appendChild(dl);
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
  if (document.activeElement !== bpmInput) {
    bpmInput.value = engine.pendingBpm ?? engine.bpm;
  }
  bpmInput.classList.toggle("pending", !!engine.pendingBpm);
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
    if (boundary !== null) {
      setStatus(`tempo → ${engine.pendingBpm} BPM at next ${engine.mode === "master" ? "cycle" : "bar"}`);
    } else {
      setStatus(`tempo set to ${engine.bpm} BPM`);
    }
  } catch (e) {
    setStatus(String(e.message || e), true);
  }
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
  catch { setStatus(url); }
});
$("#resetBtn").addEventListener("click", () => {
  engine.stop();
  blocks = []; selected = null;
  engine.slots.forEach((s, i) => engine.clearSlot(i));
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

// ── boot ──
async function bootRestored(st) {
  for (const k of st.blocks) {
    try {
      const pattern = await derivePattern(k.rootHex);
      blocks.push({ height: k.height, rootHex: k.rootHex, pattern });
    } catch (e) { /* bad root in URL → skip */ }
  }
  engine.setMode(st.mode);
  if (st.transpose) st.transpose.forEach((n, i) => { engine.slots[i].transpose = n | 0; });
  if (st.bpm) engine.setBpm(st.bpm);
  st.slots.forEach((bi, i) => { if (bi >= 0 && blocks[bi]) engine.setSlot(i, blocks[bi]); });
  setStatus("session restored (no network used)");
  render();
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
  const st = session.load();
  if (st) await bootRestored(st); else await bootFresh();
  render();
  // expose for console debugging / smoke tests
  window.__m2m = { engine, derivePattern, blocks: () => blocks, PROTOCOL_VERSION };
})();
