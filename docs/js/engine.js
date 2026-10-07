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
import { getVoice, VOICES, hasMods, lfoCycleTicks } from "./synth.js";
import { CELL_TICKS, foldMidi, mapTicksFor, POLY_STACK_CAP, KEY_OFFSET_CAP, DEFAULT_MAP_BARS, MAP_BAR_OPTIONS, MAP_MAX_COLS } from "./notes.js";
import { DRUM_LANES, SEQ_DEFAULT_BARS, SEQ_DEFAULT_SEL, SEQ_UNIT, SEQ_UNITS_MAX, SEQ_EXTENTS, PAINT_SELS, EFFECTIVE_STEPS, paintStepsPerBar, stepTicks, seqLoopTicks, seqUnitWindow, laneTimeline } from "./seq.js";

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
    this._lfos = {};          // v1.5 tempo-synced sine oscillators, rate(steps/bar) -> OscillatorNode
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
    // ── drum sequencer (v1.6 re-design; render-time ribbons) ──
    // TWO independent grids (owner ruling):
    //   paint dial (sel + triplet): snap strength for WRITING new notes only —
    //   changing it never moves existing events. Triplet mode: ♩→¼³(320t),
    //   ♪→♪³(160t) only; nothing finer than eighth-triplets.
    //   block timing (blockQuant): the assigned block's rhythm plays RAW
    //   (exact §7.4 onsets — sacrosanct) unless explicitly quantized ¼/⅛/1/16.
    // Paint store lives on the 40-tick lattice (straight 16ths and eighth-
    // triplets coexist exactly): per lane ons[] (hit) + rests[] (silence
    // window length in units, set at paint time). Loop = bars×1920; lanes
    // sound standalone (no block) in 'seq' mode. 'rhythm' = status quo raw.
    this.seq = {
      sel: SEQ_DEFAULT_SEL,      // dial selection 1|2|4|8|16 (steps/bar, straight)
      triplet: false,            // ³ toggle (applies to ♩/♪ per owner)
      bars: SEQ_DEFAULT_BARS,    // looping extent
      blockQuant: 0,             // 0 raw | 480 ¼ | 240 ⅛ | 120 1/16
      modes: {},                 // voiceId -> 'rhythm' | 'seq'
      lanes: {},                 // voiceId -> {ons: Array(768), rests: Array(768)}
      cursors: null,             // voiceId -> {rep, idx} over the merged timeline
    };
    for (const id of DRUM_LANES) {
      this.seq.modes[id] = "rhythm";
      this.seq.lanes[id] = { ons: new Array(SEQ_UNITS_MAX).fill(0), rests: new Array(SEQ_UNITS_MAX).fill(0) };
    }
    this._seqTL = {};            // merged-timeline cache per lane
    this._seqDirty = {};         // rebuild flags
    for (const id of DRUM_LANES) this._seqDirty[id] = true;
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
    this._markSeqDirty(s.voiceId);
    this._seqRephase();
    this.emit();
  }
  clearSlot(i) {
    const s = this.slots[i];
    s.block = null; s.part = null;
    this._markSeqDirty(s.voiceId);
    this._seqRephase();
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
    this._markSeqDirty();   // ghosts follow blocks across instruments
    this._seqRephase();
    this.emit();
  }

  // ── tempo-synced LFO service (v1.5 modulation; render-time) ──
  // One shared sine oscillator per rate, phase origin = transport tick 0
  // (start(startTime) with a past time is legal and locks phase). Frequency is
  // musical: rate steps/bar → Hz = tps / cycleTicks, retuned at every tempo
  // commit. Only created when a voice actually uses a mod (lazy, zero-cost off).
  _lfo(rateSteps) {
    if (!this.playing || !this.ctx) return null;
    let o = this._lfos[rateSteps];
    if (!o) {
      o = this.ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = this._tpsBase / lfoCycleTicks(rateSteps);
      try { o.start(this.startTime); } catch (e) { o = null; }
      if (o) this._lfos[rateSteps] = o;
    }
    return o || null;
  }
  _resyncLfos() {
    for (const r of Object.keys(this._lfos)) {
      try {
        this._lfos[r].frequency.setTargetAtTime(this._tpsBase / lfoCycleTicks(+r), this.ctx.currentTime, 0.03);
      } catch (e) { /* gone */ }
    }
  }
  _killLfos() {
    for (const r of Object.keys(this._lfos)) {
      try { this._lfos[r].stop(); this._lfos[r].disconnect(); } catch (e) { /* gone */ }
    }
    this._lfos = {};
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

  // ── drum sequencer (player-side, v1.6) ──
  get seqPaintSteps() { return paintStepsPerBar(this.seq.sel, this.seq.triplet); }
  get seqStepTicks() { return stepTicks(this.seqPaintSteps); }
  get seqStepUnits() { return this.seqStepTicks / SEQ_UNIT; }
  get seqLoopTicks() { return seqLoopTicks(this.seq.bars); }
  get seqUnits() { return seqUnitWindow(this.seq.bars); }

  // PAINT dial setters — never touch stored events (freeze ruling): changing
  // the writing grid is a no-op for existing notes AND for the block layer.
  setPaintSel(sel) {
    if (!PAINT_SELS.includes(sel)) return;
    this.seq.sel = sel;
    this.emit();
  }
  setTriplet(on) {
    this.seq.triplet = !!on;
    if (this.seq.triplet && this.seq.sel === 16) this.seq.sel = 8; // ♬ unavailable in ³
    this.emit();
  }
  setSeqBars(bars) {
    if (!SEQ_EXTENTS.includes(bars) || bars === this.seq.bars) return;
    this.seq.bars = bars;
    this._markSeqDirty();
    this._seqRephase();
    this.emit();
  }
  // BLOCK timing selector — explicit and separate: raw (0) or ¼/⅛/1/16 grid.
  setBlockQuant(q) {
    if (![0, 480, 240, 120].includes(q) || q === this.seq.blockQuant) return;
    this.seq.blockQuant = q;
    this._markSeqDirty();
    this._seqRephase();
    this.emit();
  }
  seqToggleMode(voiceId) {
    if (!(voiceId in this.seq.modes)) return;
    this.seq.modes[voiceId] = this.seq.modes[voiceId] === "seq" ? "rhythm" : "seq";
    this._seqRephase();
    this.emit();
  }
  // paint a unit on the lane (inside the looping window); 'on' and 'rest' are
  // exclusive, 'rest' carries the CURRENT step size as its window length.
  seqApplyUnit(voiceId, u, state) {
    const ln = this.seq.lanes[voiceId];
    if (!ln || u < 0 || u >= this.seqUnits) return;
    if (state === "on") { ln.ons[u] = 1; ln.rests[u] = 0; }
    else if (state === "rest") { ln.ons[u] = 0; ln.rests[u] = this.seqStepUnits; }
    else { ln.ons[u] = 0; ln.rests[u] = 0; }
    this._markSeqDirty(voiceId);
  }
  seqCycleUnit(voiceId, u) {              // tap: on → rest → clear → on
    const ln = this.seq.lanes[voiceId];
    if (!ln || u < 0 || u >= this.seqUnits) return "clear";
    const next = ln.ons[u] ? "rest" : ln.rests[u] ? "clear" : "on";
    this.seqApplyUnit(voiceId, u, next);
    return next;
  }
  _markSeqDirty(voiceId) {
    if (voiceId) this._seqDirty[voiceId] = true;
    else for (const id of DRUM_LANES) this._seqDirty[id] = true;
  }
  // merged timeline for a lane: (raw-or-quantized block ∪ painted-ons) − rests
  _seqTimeline(voiceId) {
    if (!this._seqDirty[voiceId] && this._seqTL[voiceId]) return this._seqTL[voiceId];
    const slot = this.slots.find((s) => s.voiceId === voiceId);
    const pat = slot && slot.block && slot.block.pattern;
    const ln = this.seq.lanes[voiceId];
    const tl = laneTimeline({
      onsets: pat ? pat.onsets : null,
      loopTicks: pat ? pat.loopTicks : 0,
      extTicks: this.seqLoopTicks,
      quantTicks: this.seq.blockQuant,
      ons: ln ? ln.ons : [],
      rests: ln ? ln.rests : [],
    });
    this._seqTL[voiceId] = tl;
    this._seqDirty[voiceId] = false;
    return tl;
  }
  seqLaneTimeline(voiceId) { return this._seqTimeline(voiceId); } // UI/export accessor
  seqClearSteps() {                      // zero painted events, keep modes/grid
    for (const id of DRUM_LANES) {
      this.seq.lanes[id] = { ons: new Array(SEQ_UNITS_MAX).fill(0), rests: new Array(SEQ_UNITS_MAX).fill(0) };
    }
    this._markSeqDirty();
    this._seqRephase();
    this.emit();
  }
  _seqRephase() {
    if (!this.playing || !this.seq.cursors) return;
    const loop = this.seqLoopTicks;
    const cur = Math.max(0, this._curTick());
    for (const id of DRUM_LANES) {
      const c = this.seq.cursors[id];
      if (!c) continue;
      const tl = this._seqTimeline(id);
      c.rep = Math.floor(cur / loop);
      const ph = cur - c.rep * loop;
      let i = 0;
      while (i < tl.length && tl[i] < ph) i++;
      c.idx = i >= tl.length ? 0 : i;
      if (c.idx === 0 && tl.length && tl[0] < ph) c.rep++; // wrapped past loop end
    }
  }
  setSeqState(st) {                       // session restore: defaults first, then apply
    this.seq.sel = SEQ_DEFAULT_SEL;
    this.seq.triplet = false;
    this.seq.bars = SEQ_DEFAULT_BARS;
    this.seq.blockQuant = 0;
    for (const id of DRUM_LANES) {
      this.seq.modes[id] = "rhythm";
      this.seq.lanes[id] = { ons: new Array(SEQ_UNITS_MAX).fill(0), rests: new Array(SEQ_UNITS_MAX).fill(0) };
    }
    if (st) {
      if (PAINT_SELS.includes(st.sel)) this.seq.sel = st.sel;
      this.seq.triplet = !!st.triplet;
      if (SEQ_EXTENTS.includes(st.bars)) this.seq.bars = st.bars;
      if ([0, 480, 240, 120].includes(st.blockQuant)) this.seq.blockQuant = st.blockQuant;
      for (const id of DRUM_LANES) {
        if (st.modes && st.modes[id]) this.seq.modes[id] = st.modes[id] === "seq" ? "seq" : "rhythm";
        const ln = st.lanes && st.lanes[id];
        if (ln && Array.isArray(ln.ons) && Array.isArray(ln.rests)) {
          const onA = new Array(SEQ_UNITS_MAX).fill(0);
          const restA = new Array(SEQ_UNITS_MAX).fill(0);
          ln.ons.slice(0, SEQ_UNITS_MAX).forEach((v, u) => { onA[u] = v === 1 ? 1 : 0; });
          ln.rests.slice(0, SEQ_UNITS_MAX).forEach((v, u) => { restA[u] = (v >= 1 && v <= 255) ? v : 0; });
          this.seq.lanes[id] = { ons: onA, rests: restA };
        } else if (st.cells && Array.isArray(st.cells[id]) && PAINT_SELS.includes(st.res)) {
          // legacy v1.4 snapshot (res-cell arrays): re-map onto the 40-tick lattice
          const cu = stepTicks(st.res) / SEQ_UNIT;
          const onA = new Array(SEQ_UNITS_MAX).fill(0);
          const restA = new Array(SEQ_UNITS_MAX).fill(0);
          st.cells[id].forEach((v, i) => {
            const u = i * cu;
            if (u >= SEQ_UNITS_MAX) return;
            if (v === 1) onA[u] = 1;
            else if (v === 2) restA[u] = cu;
          });
          this.seq.lanes[id] = { ons: onA, rests: restA };
          this.seq.sel = st.res;
        }
      }
    }
    this._markSeqDirty();
    this._seqRephase();
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
    this._lfos = {};   // fresh LFO service; oscillators spawn lazily per rate
    for (const s of this.slots) {
      s.part = s.block ? this._buildPart(s.block, false) : null;
    }
    // seq cursors: per-lane read heads over the merged timeline, tick-0 aligned
    this.seq.cursors = {};
    for (const id of DRUM_LANES) this.seq.cursors[id] = { rep: 0, idx: 0 };
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
    this._killLfos();
    this.playing = false;
    this._segments = null; this._pending = null; // discard uncommitted tempo
    this.seq.cursors = null;
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
    // ribbons live on the master grid — re-align means back to timeline start too
    if (this.seq.cursors) {
      for (const id of DRUM_LANES) this.seq.cursors[id] = { rep: 0, idx: 0 };
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
      this._resyncLfos();   // musical-cycle LFOs retune at the same boundary
      this.emit();
    }
    const horizon = this._tickAt(now + LOOKAHEAD_SEC);

    if (this.mode === "master") {
      const ci = Math.floor(cur / this.cycleLen);
      if (ci > this._cycleIdx) { this._cycleIdx = ci; this.resyncAllToTop(); }
    }

    for (const s of this.slots) {
      if (s.muted) continue; // cursor freeze-through; catches up on unmute
      const voice = getVoice(s.voiceId);
      if (!voice.melodic && this.seq.modes[s.voiceId] === "seq") {
        this._scheduleSeq(s, voice, ctx, now, cur, horizon);
        continue;
      }
      const p = s.part;
      if (!p) continue;
      for (;;) {
        const evIdx = p.cursor.idx;
        const o = p.onsets[evIdx];
        const abs = p.anchor + p.cursor.rep * p.loop + o.tick;
        if (abs >= horizon) break;
        // audible window: after entry gate, and not stale (tab throttle guard)
        if (abs >= p.entry && abs >= cur - 2) {
          const at = Math.max(this._timeAt(abs), now + 0.004);
          const dur = o.soundingTicks / this._tpsBase;
          // v1.5/v1.7: modulation context whenever the voice has ∿ mods
          // (melodic AND drums) — {tick: master tick at onset, oscFor: shared LFO}
          const md = hasMods(voice.id)
            ? { tick: abs, oscFor: (r) => this._lfo(r) }
            : undefined;
          if (voice.melodic) {
            for (const midi of this._pitchStackFor(abs, p, evIdx, voice, s))
              voice.trigger(ctx, this.bus, at, dur, NOTE_VELOCITY, midi, md);
          } else {
            voice.trigger(ctx, this.bus, at, dur, NOTE_VELOCITY, 0, md);
          }
        }
        if (++p.cursor.idx >= p.onsets.length) { p.cursor.idx = 0; p.cursor.rep++; }
      }
    }
  }

  // ribbon clock (v1.6): per-lane {rep, idx} over the MERGED TIMELINE —
  // raw-or-quantized block hits ∪ painted hits − rest windows. Positions are
  // exact 40-tick-lattice ticks; the paint dial never influences this path.
  _scheduleSeq(slot, voice, ctx, now, cur, horizon) {
    const c = this.seq.cursors && this.seq.cursors[voice.id];
    if (!c) return;
    const tl = this._seqTimeline(voice.id);
    if (!tl.length) return;
    const loop = this.seqLoopTicks;
    for (;;) {
      const abs = c.rep * loop + tl[c.idx];
      if (abs >= horizon) break;
      if (abs >= cur - 2) { // stale guard mirrors the part loop
        const at = Math.max(this._timeAt(abs), now + 0.004);
        const nextT = c.idx + 1 < tl.length ? tl[c.idx + 1] : loop + tl[0];
        const gap = Math.max(SEQ_UNIT, nextT - tl[c.idx]);
        const dur = Math.min(240, gap) / this._tpsBase;
        const md = hasMods(voice.id)
          ? { tick: abs, oscFor: (r) => this._lfo(r) }
          : undefined;
        voice.trigger(ctx, this.bus, at, dur, NOTE_VELOCITY, 0, md);
      }
      if (++c.idx >= tl.length) { c.idx = 0; c.rep++; }
    }
  }
}
