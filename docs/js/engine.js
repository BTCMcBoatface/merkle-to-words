// engine.js — ensemble transport. One shared master clock; each slot's block
// loops at its own length, phase-anchored so the ensemble grid never shifts.
//
// Design stance (per user: "do not box in"):
//   - anchorTick is PER PART: 0 = anchored (tick-0 locked to transport-0 —
//     all bars re-converge there); head-start entry sets anchor = entryTick.
//   - cycleLen is COMPUTED, never hardcoded, so future longer loops don't break
//     master mode.
//   - Tempo is a piecewise tick↔second map (segments): setBpm() queues a change
//     that commits at the next shared boundary so the ensemble retimes together.
//     Render-time only — §5's 120 BPM and the .mid download are untouched.
//   - Voice triggering carries pitch + per-slot transpose (melodic voices;
//     percussion ignores it). M2M-NOTES v2.1: the melody map is a fixed
//     128-column (16-bar) store whose mapBars selects the looping EXTENT
//     (shrink hides the tail, grow restores — data never destroyed); a map-level
//     capo (mapOffset ±) shifts sounding PAINTED pitches only, painted data is
//     untouched; unpainted cells resolve via the melody-source switch.
//   - LIVE mode: rotation is a slot permutation moved with the parts themselves
//     (cursor intact) — rotation NEVER re-times anything, only re-voices it.
//     Arrival-driven rotation lives in ui.js; the engine owns the mechanism.

import { BAR_TICKS, NOTE_VELOCITY } from "./protocol.js";
import { getVoice, VOICES } from "./synth.js";
import { CELL_TICKS, foldMidi, mapTicksFor, POLY_STACK_CAP, KEY_OFFSET_CAP, DEFAULT_MAP_BARS, MAP_BAR_OPTIONS, MAP_MAX_COLS } from "./notes.js";

const PPQ = 480; // §5 ticks per quarter
const tpsFor = (bpm) => (bpm * PPQ) / 60; // ticks/sec = 960 at 120 BPM
const LOOKAHEAD_SEC = 0.12;
const SCHED_INTERVAL_MS = 25;
const REFERENCE_CYCLE = BAR_TICKS * 8; // 15360: max current loop, floor for master cycle
const MAP_BAR_SET = new Set(MAP_BAR_OPTIONS);

export const SLOT_INSTRUMENTS = VOICES.map((v) => v.id); // 7 slots, fixed order
export const MAX_BLOCKS = 8;

export class Ensemble {
  constructor() {
    this.ctx = null;
    this.bus = null;
    this.mode = "independent"; // 'independent' (bar quantum) | 'master' (cycle quantum)
    this.playing = false;
    this.live = false;         // LIVE (conductor) mode armed (polling lives in ui.js)
    this.startTime = 0; // ctx time at master tick 0
    this._tpsBase = tpsFor(120); // current master ticks/sec (tempo lives in segments)
    this._segments = null; // [{tick0, time0, tps}] piecewise tick↔second map
    this._pending = null;  // {bpm, boundary} queued tempo change
    this.timer = null;
    this._cycleIdx = 0;
    this._listeners = new Set();
    // global reverb (the ONE whole-mix sound knob; local-persisted by tonebank)
    this.reverb = 0;          // 0–1 wet level
    this._wet = null;         // per-play wet gain node
    this._ir = null;          // cached convolver (per AudioContext)
    this._irCtx = null;
    this.slots = SLOT_INSTRUMENTS.map((voiceId) => ({
      voiceId, block: null, part: null, muted: false, transpose: 0,
    }));
    // ── M2M-NOTES v2.1 melody map (render-time; exports are explicit actions) ──
    // cells[col] = stack of MIDI pitches (21–108); [] = empty column.
    // The store is ALWAYS the 128-col (16-bar) superset; mapBars selects the
    // looping extent — column = floor((t mod mapTicksFor(mapBars)) / CELL_TICKS) on the
    // MASTER clock, so the map is global truth synced across every instrument.
    // mapOffset = map-level capo (semitones): shifts sounding painted pitches
    // only; fallbacks (merkle melody / voice default) are not capoed.
    this.polyphony = false;        // false: one pitch per column (replace); true: stacks ≤7
    this.mapBars = DEFAULT_MAP_BARS;
    this.cells = this._makeCells();
    this.mapOffset = 0;
    this.melodySource = "none"; // 'merkle' | 'none' (empty-column resolution)
  }

  _makeCells() {
    return Array.from({ length: MAP_MAX_COLS }, () => []);
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
    if (this.playing && block) s.part = this._buildPart(block, headStart);
    this.emit();
  }
  clearSlot(i) {
    const s = this.slots[i];
    s.block = null; s.part = null;
    this.emit();
  }
  toggleMute(i) {
    // pure flag: the part keeps its live cursor so unmute resumes in-phase
    const s = this.slots[i];
    s.muted = !s.muted;
    this.emit();
  }
  setTranspose(i, semitones) {
    this.slots[i].transpose = Math.max(-24, Math.min(24, semitones | 0));
    this.emit();
  }
  setMode(m) {
    this.mode = m === "master" ? "master" : "independent";
    if (this.playing && this.mode === "master") this.resyncAllToTop();
    this.emit();
  }
  setLive(on) {
    this.live = !!on;
    this.emit();
  }

  // ── global reverb (render-time; ONE wet knob over the whole mix, not a
  // per-instrument setting and never part of files/sessions — tonebank.js) ──
  setReverb(v) {
    this.reverb = Math.max(0, Math.min(1, Number(v) || 0));
    if (this.playing && this._wet) {
      this._wet.gain.setTargetAtTime(this.reverb, this.ctx.currentTime, 0.02);
    }
  }

  // synthesized room: stereo decaying-noise impulse response (no audio asset),
  // built once per AudioContext and reused across plays.
  _reverbIR(ctx) {
    if (this._ir && this._irCtx === ctx) return this._ir;
    const len = Math.max(1, Math.floor(ctx.sampleRate * 2.0));
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5);
    }
    const conv = ctx.createConvolver();
    conv.buffer = buf;
    this._ir = conv; this._irCtx = ctx;
    return conv;
  }

  // Rotate the arrangement one round-robin step: block at slot i travels to slot
  // i+1, PART OBJECTS MOVE WITH THEM — timing (anchor/entry/cursor) is untouched,
  // only the sounding voice changes. Mutes/transposes stay with the instrument.
  rotateOneStep() {
    const n = this.slots.length;
    const prev = this.slots.map((s) => ({ block: s.block, part: s.part }));
    for (let i = 0; i < n; i++) {
      const src = prev[(i - 1 + n) % n];
      this.slots[i].block = src.block;
      this.slots[i].part = src.part;
    }
    this.emit();
  }

  // ── melody map + source + capo (M2M-NOTES v2.1; player-side) ──
  get activeCols() { return this.mapBars * 8; }
  setMapBars(bars) {                       // extent change only — data untouched
    if (!MAP_BAR_SET.has(bars) || bars === this.mapBars) return;
    this.mapBars = bars;
    this.emit();
  }
  setMapOffset(n) {
    this.mapOffset = Math.max(-KEY_OFFSET_CAP, Math.min(KEY_OFFSET_CAP, n | 0));
    this.emit();
  }
  setPolyphony(on) {
    this.polyphony = !!on;
    if (!this.polyphony) for (const c of this.cells) if (c.length > 1) c.length = 1;
    this.emit();
  }
  // paint one column: n = MIDI pitch, or null/0 = clear the whole column.
  // Columns outside the current looping extent are not paintable (hidden tail).
  paintCell(col, n) {
    const c = this.cells[col];
    if (!c || col >= this.activeCols) return;
    if (!n) { c.length = 0; return; }
    const p = foldMidi(n);
    if (this.polyphony) {
      if (!c.includes(p) && c.length < POLY_STACK_CAP) { c.push(p); c.sort((a, b) => a - b); }
    } else if (c[0] !== p) {
      c.length = 0; c.push(p);
    }
  }
  eraseCellPitch(col, n) {
    const c = this.cells[col];
    if (!c || !n || col >= this.activeCols) return;
    const i = c.indexOf(n);
    if (i >= 0) c.splice(i, 1);
  }
  clearMap() { for (const c of this.cells) c.length = 0; this.emit(); }
  setMelodySource(s) {
    this.melodySource = s === "merkle" ? "merkle" : "none";
    this.emit();
  }
  // resolve a melodic onset's pitch STACK: painted column (capoed) → source-merkle
  // melody of this event → voice default; per-slot transpose folds each last
  _pitchStackFor(absTick, part, evIdx, voice, slot) {
    const col = Math.floor((absTick % mapTicksFor(this.mapBars)) / CELL_TICKS);
    const stack = this.cells[col];
    let base, off = 0;
    if (stack && stack.length) { base = stack; off = this.mapOffset; } // capo is the map's property
    else if (this.melodySource === "merkle" && part.block && part.block.melody)
      base = [part.block.melody[evIdx % part.block.melody.length]];
    else base = [voice.defaultNote];
    const tr = slot.transpose | 0;
    if (!off && !tr) return base.slice();
    return base.map((m) => foldMidi(m + off + tr));
  }

  // ── tempo (player-only; the derived stream and .mid download always
  // carry the canonical 120 BPM of §5 — this is render-time retiming) ──
  get bpm() { return Math.round(this._tpsBase * 60 / PPQ); }
  get pendingBpm() { return this._pending ? this._pending.bpm : null; }
  setBpm(v) {
    const bpm = Math.round(Number(v));
    if (!Number.isFinite(bpm) || bpm < 20 || bpm > 300) {
      throw new Error(`BPM must be 20–300 (got ${v})`);
    }
    if (!this.playing) {
      this._tpsBase = tpsFor(bpm);
      this._pending = null;
      this.emit();
      return null; // effective immediately (applies next play)
    }
    // queue: commits at the next shared boundary — bar (independent) or
    // cycle top (master) — so all parts retime together, phase-locked
    const boundary = this._pending ? this._pending.boundary : this._nextBoundary();
    this._pending = { bpm, boundary };
    this.emit();
    return boundary;
  }

  // ── clock geometry ──
  get cycleLen() {
    let mx = REFERENCE_CYCLE;
    for (const s of this.slots) if (s.part) mx = Math.max(mx, s.part.loop);
    return mx;
  }
  _quantum() { return this.mode === "master" ? this.cycleLen : BAR_TICKS; }
  // piecewise tick↔second map over tempo segments (continuous at boundaries)
  _tickAt(t) {
    const sg = this._segments || [{ tick0: 0, time0: this.startTime, tps: this._tpsBase }];
    let s = sg[0];
    for (const x of sg) { if (x.time0 <= t) s = x; else break; }
    return s.tick0 + (t - s.time0) * s.tps;
  }
  _timeAt(tick) {
    const sg = this._segments || [{ tick0: 0, time0: this.startTime, tps: this._tpsBase }];
    let s = sg[0];
    for (const x of sg) { if (x.tick0 <= tick) s = x; else break; }
    return s.time0 + (tick - s.tick0) / s.tps;
  }
  _curTick() { return this._tickAt(this.ctx.currentTime); }
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
      block, onsets: p.onsets, loop,
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
    // reverb send post-compressor: the whole mix (drums included) feeds a
    // cached convolver whose wet gain rides the single global knob
    const conv = this._reverbIR(ctx);
    const wet = ctx.createGain();
    wet.gain.value = this.reverb;
    comp.connect(conv); conv.connect(wet); wet.connect(ctx.destination);
    this._wet = wet;

    this.startTime = ctx.currentTime + 0.1;
    this._segments = [{ tick0: 0, time0: this.startTime, tps: this._tpsBase }];
    this._pending = null;
    this._cycleIdx = 0;
    for (const s of this.slots) {
      s.part = s.block ? this._buildPart(s.block, false) : null;
    }
    this.playing = true;
    this.timer = setInterval(() => this._schedule(), SCHED_INTERVAL_MS);
    this.emit();
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.bus) {
      const b = this.bus, c = this.ctx, comp = this._comp, wet = this._wet;
      b.gain.setTargetAtTime(0, c.currentTime, 0.01);
      setTimeout(() => {
        try {
          b.disconnect(); comp.disconnect();
          if (wet) { wet.disconnect(); if (this._ir) this._ir.disconnect(); }
        } catch (e) { /* gone */ }
      }, 250);
    }
    this.bus = null; this._comp = null; this._wet = null;
    this.playing = false;
    this._segments = null; this._pending = null; // discard uncommitted tempo
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

    // commit queued tempo change at its boundary (continuous piecewise map)
    if (this._pending && cur >= this._pending.boundary) {
      const b = this._pending.boundary;
      const t0 = this._timeAt(b);
      this._segments.push({ tick0: b, time0: t0, tps: tpsFor(this._pending.bpm) });
      this._tpsBase = tpsFor(this._pending.bpm);
      this._pending = null;
      this.emit();
    }
    const horizon = this._tickAt(now + LOOKAHEAD_SEC);

    if (this.mode === "master") {
      const ci = Math.floor(cur / this.cycleLen);
      if (ci > this._cycleIdx) { this._cycleIdx = ci; this.resyncAllToTop(); }
    }

    for (const s of this.slots) {
      const p = s.part;
      if (!p || s.muted) continue; // cursor freeze-through; catches up on unmute
      const voice = getVoice(s.voiceId);
      for (;;) {
        const evIdx = p.cursor.idx;
        const o = p.onsets[evIdx];
        const abs = p.anchor + p.cursor.rep * p.loop + o.tick;
        if (abs >= horizon) break;
        // audible window: after entry gate, and not stale (tab throttle guard)
        if (abs >= p.entry && abs >= cur - 2) {
          const at = Math.max(this._timeAt(abs), now + 0.004);
          const dur = o.soundingTicks / this._tpsBase;
          if (voice.melodic) {
            for (const midi of this._pitchStackFor(abs, p, evIdx, voice, s))
              voice.trigger(ctx, this.bus, at, dur, NOTE_VELOCITY, midi);
          } else {
            voice.trigger(ctx, this.bus, at, dur, NOTE_VELOCITY, 0);
          }
        }
        if (++p.cursor.idx >= p.onsets.length) { p.cursor.idx = 0; p.cursor.rep++; }
      }
    }
  }
}
