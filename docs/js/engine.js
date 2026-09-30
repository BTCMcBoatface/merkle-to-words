// engine.js — ensemble transport. One shared master clock; each slot's block
// loops at its own length, phase-anchored so the ensemble grid never shifts.
//
// Design stance (per user: "do not box in"):
//   - anchorTick is PER PART: 0 = anchored (tick-0 locked to transport-0 —
//     all bars re-converge there); head-start entry sets anchor = entryTick.
//   - cycleLen is COMPUTED, never hardcoded, so future longer loops don't break
//     master mode.
//   - Voice triggering carries pitch + per-slot transpose hook for the
//     future chord/note-mapping overlay; nothing in here bakes in GM key 35.
//
// Protocol: timing math in integer ticks (§8); seconds = ticks / 960 (§A5).

import { BAR_TICKS, NOTE_VELOCITY } from "./protocol.js";
import { getVoice, VOICES } from "./synth.js";

const TICKS_PER_SECOND = 960; // at PPQ 480 / 120 BPM
const LOOKAHEAD_SEC = 0.12;
const SCHED_INTERVAL_MS = 25;
const REFERENCE_CYCLE = BAR_TICKS * 8; // 15360: max current loop, floor for master cycle

export const SLOT_INSTRUMENTS = VOICES.map((v) => v.id); // 7 slots, fixed order
export const MAX_BLOCKS = 8;

export class Ensemble {
  constructor() {
    this.ctx = null;
    this.bus = null;
    this.mode = "independent"; // 'independent' (bar quantum) | 'master' (cycle quantum)
    this.playing = false;
    this.startTime = 0; // ctx time at master tick 0
    this.timer = null;
    this._cycleIdx = 0;
    this._listeners = new Set();
    this.slots = SLOT_INSTRUMENTS.map((voiceId) => ({
      voiceId, block: null, part: null, muted: false, transpose: 0,
    }));
  }

  // ── change notifications ──
  onChange(cb) { this._listeners.add(cb); return () => this._listeners.delete(cb); }
  emit() { for (const f of this._listeners) f(this); }

  _ensureCtx() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC(); // created/resumed inside a user gesture (Play) — iOS rule
    }
    return this.ctx;
  }

  // ── arrangement ──
  setSlot(i, block, { headStart = false } = {}) {
    const s = this.slots[i];
    s.block = block;
    s.part = null;
    if (this.playing && block && !s.muted) s.part = this._buildPart(block, headStart);
    this.emit();
  }
  clearSlot(i) {
    const s = this.slots[i];
    s.block = null; s.part = null;
    this.emit();
  }
  toggleMute(i) {
    const s = this.slots[i];
    s.muted = !s.muted;
    if (this.playing) {
      s.part = (!s.muted && s.block) ? this._buildPart(s.block, false) : null;
    }
    this.emit();
  }
  // Future transpose/chord overlay lands here (semitone offset for melodic voices).
  setTranspose(i, semitones) {
    this.slots[i].transpose = semitones | 0;
    this.emit();
  }
  setMode(m) {
    this.mode = m === "master" ? "master" : "independent";
    if (this.playing && this.mode === "master") this.resyncAllToTop();
    this.emit();
  }

  // ── clock geometry ──
  get cycleLen() {
    let mx = REFERENCE_CYCLE;
    for (const s of this.slots) if (s.part) mx = Math.max(mx, s.part.loop);
    return mx;
  }
  _quantum() { return this.mode === "master" ? this.cycleLen : BAR_TICKS; }
  _curTick() { return (this.ctx.currentTime - this.startTime) * TICKS_PER_SECOND; }
  _nextBoundary() {
    const q = this._quantum();
    const t = this._curTick();
    return t <= 0 ? 0 : (Math.floor(t / q) + 1) * q;
  }
  _buildPart(block, headStart) {
    const p = block.pattern;
    const entry = this.playing ? this._nextBoundary() : 0;
    const loop = p.loopTicks;
    return {
      onsets: p.onsets, loop,
      anchor: headStart ? entry : 0, // parameterized phase policy
      entry,
      cursor: { rep: Math.max(0, Math.floor(entry / loop)), idx: 0 },
    };
  }

  // ── transport ──
  play() {
    if (this.playing) return;
    const ctx = this._ensureCtx();
    ctx.resume();
    const comp = ctx.createDynamicsCompressor();
    this.bus = ctx.createGain();
    this.bus.gain.value = 0.9;
    this.bus.connect(comp);
    comp.connect(ctx.destination);
    this._comp = comp;

    this.startTime = ctx.currentTime + 0.1;
    this._cycleIdx = 0;
    for (const s of this.slots) {
      s.part = (s.block && !s.muted) ? this._buildPart(s.block, false) : null;
    }
    this.playing = true;
    this.timer = setInterval(() => this._schedule(), SCHED_INTERVAL_MS);
    this.emit();
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.bus) {
      const b = this.bus, c = this.ctx, comp = this._comp;
      b.gain.setTargetAtTime(0, c.currentTime, 0.01);
      setTimeout(() => { try { b.disconnect(); comp.disconnect(); } catch (e) { /* gone */ } }, 250);
    }
    this.bus = null; this._comp = null;
    this.playing = false;
    for (const s of this.slots) s.part = null;
    this.emit();
  }

  // "Reset all bars to 0 at transport 0": every part re-anchors (tick-0 grid
  // restored) entering at the next boundary under the current loop mode.
  // No-ops when stopped — play() already starts everything anchored at 0.
  resyncAllToTop() {
    if (!this.playing) return;
    const b = this._nextBoundary();
    for (const s of this.slots) {
      const p = s.part;
      if (!p) continue;
      p.anchor = 0;
      p.entry = b;
      p.cursor = { rep: Math.max(0, Math.floor(b / p.loop)), idx: 0 };
    }
    this.emit();
  }

  _schedule() {
    if (!this.playing || !this.bus) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const cur = this._curTick();
    if (cur < 0) return; // pre-roll
    const horizon = (now + LOOKAHEAD_SEC - this.startTime) * TICKS_PER_SECOND;

    if (this.mode === "master") {
      const ci = Math.floor(cur / this.cycleLen);
      if (ci > this._cycleIdx) { this._cycleIdx = ci; this.resyncAllToTop(); }
    }

    for (const s of this.slots) {
      const p = s.part;
      if (!p) continue;
      const voice = getVoice(s.voiceId);
      const midi = voice.melodic ? (voice.defaultNote + s.transpose) : 0;
      for (;;) {
        const o = p.onsets[p.cursor.idx];
        const abs = p.anchor + p.cursor.rep * p.loop + o.tick;
        if (abs >= horizon) break;
        // audible window: after entry gate, and not stale (tab throttle guard)
        if (abs >= p.entry && abs >= cur - 2) {
          const at = Math.max(this.startTime + abs / TICKS_PER_SECOND, now + 0.004);
          voice.trigger(ctx, this.bus, at, o.soundingTicks / TICKS_PER_SECOND, NOTE_VELOCITY, midi);
        }
        if (++p.cursor.idx >= p.onsets.length) { p.cursor.idx = 0; p.cursor.rep++; }
      }
    }
  }
}
