// synth.js — Web Audio "808 classic" voices. No samples, no dependencies.
// Trigger signature is deliberately generic — (ctx, dest, time, durSec, vel,
// midiNote) — so the future transpose/chord overlay can pass a real pitch;
// drum voices ignore it. MIDI-PROTOCOL.md §11 keeps voice choice out of the
// protocol: this file is pure render-time.

const mtof = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

let _noiseCtx = null, _noiseBuf = null;
function noiseBuffer(ctx) {
  if (_noiseCtx !== ctx || !_noiseBuf) {
    const len = Math.floor(ctx.sampleRate * 1.2);
    _noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = _noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    _noiseCtx = ctx;
  }
  return _noiseBuf;
}

function envGain(ctx, dest, time, peak, decay, attack = 0.002) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, time);
  g.gain.linearRampToValueAtTime(peak, time + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, time + Math.max(0.02, decay));
  g.connect(dest);
  return g;
}

function startOsc(ctx, type, freq, time, stopAt) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, time);
  o.start(time);
  o.stop(stopAt);
  return o;
}

// ── Tone parameters (player-side, §11 render-time only) ─────────────────────
// Every default below is the ORIGINAL hard-coded constant of that voice — a
// fresh session sounds exactly like pre-1.3.0 builds. TONE_SCHEMA describes the
// dials the UI draws; the trigger functions read the live params at schedule
// time. Only what the synth already contains is exposed (waveform among the
// four built-in oscillator types, filter cutoff/Q, envelope times, organ
// drawbar levels, output level). Tempo-synced ∿ modulation lives on top of
// these (below) — still 100% Web Audio built-ins: sine osc + gain + param sum.
// Downloads stay canonical (MIDI-PROTOCOL.md §5/§11): this lives in the air,
// not in the derived event stream.

export const WAVES = ["sine", "square", "sawtooth", "triangle"];

// ── Tempo-synced sine modulation (v1.5) ───────────────────────────────────
// Any slider can oscillate: value(t) = base + sin(2π·Δticks/cycleTicks) × span×depth/2
// (depth 1 + mid-slider base = the full min↔max swing; sweep endpoints are
// remapped across the full range at full depth). Cycle lengths are musical
// TICKS (whole..16th over the 480-PPQ grid) so BPM changes retune the wobble.
// modTarget splits the mechanism:
//   "scalar"  — resolved per note at onset (envelope times, levels, drawbars)
//   "param"   — continuous: a shared, transport-phase-locked sine oscillator
//               (engine-owned) summed into the AudioParam via a per-note
//               depth gain — true analog-style filter wobble on long notes.
// NOT BOXING IN (owner directive): every mod state is stored as
// {rate, depth, lo, hi} where lo/hi DEFAULT to the schema min/max and are
// honored by the mapping formula — the future min/max markers UI plugs in by
// setting lo/hi, no storage or math change. `wave` is sine-only for now per
// owner spec but modTarget/depth math is wave-agnostic. Drum params can join
// later by adding modTarget to their schema entries.

export const LFO_RATES = [
  { steps: 1, label: "𝅝", name: "whole" },
  { steps: 2, label: "𝅗𝅥", name: "half" },
  { steps: 4, label: "♩", name: "quarter" },
  { steps: 8, label: "♪", name: "eighth" },
  { steps: 16, label: "♬", name: "sixteenth" },
];
export const LFO_DEFAULT_RATE = 8;
const BAR_TICKS_S = 1920; // 480 PPQ × 4 — local mirror of protocol BAR_TICKS (cycle math)
export const lfoCycleTicks = (rateSteps) => BAR_TICKS_S / rateSteps;

export const TONE_SCHEMA = {
  "lead-synth": [
    { key: "wave", label: "waveform", type: "enum", options: WAVES },
    { key: "cutoff", label: "filter open", unit: "Hz", type: "f", min: 200, max: 8000, step: 25, modTarget: "param" },
    { key: "cutoffEnd", label: "filter close", unit: "Hz", type: "f", min: 80, max: 6000, step: 25, modTarget: "param" },
    { key: "q", label: "resonance", type: "f", min: 0.3, max: 18, step: 0.1, modTarget: "param" },
    { key: "attack", label: "attack", unit: "s", type: "f", min: 0.001, max: 0.1, step: 0.001, modTarget: "scalar" },
    { key: "gate", label: "length", unit: "s", type: "f", min: 0.1, max: 1.5, step: 0.01, modTarget: "scalar" },
    { key: "release", label: "release", unit: "s", type: "f", min: 0.01, max: 0.6, step: 0.01, modTarget: "scalar" },
    { key: "level", label: "level", type: "f", min: 0, max: 1, step: 0.01, modTarget: "scalar" },
  ],
  "bass-synth": [
    { key: "wave", label: "waveform", type: "enum", options: WAVES },
    { key: "cutoff", label: "filter cut", unit: "Hz", type: "f", min: 80, max: 2000, step: 10, modTarget: "param" },
    { key: "q", label: "resonance", type: "f", min: 0.3, max: 18, step: 0.1, modTarget: "param" },
    { key: "attack", label: "attack", unit: "s", type: "f", min: 0.001, max: 0.1, step: 0.001, modTarget: "scalar" },
    { key: "gate", label: "length", unit: "s", type: "f", min: 0.1, max: 1.5, step: 0.01, modTarget: "scalar" },
    { key: "level", label: "level", type: "f", min: 0, max: 1, step: 0.01, modTarget: "scalar" },
  ],
  "organ": [
    { key: "p1", label: "drawbar 1×", type: "f", min: 0, max: 1, step: 0.01, modTarget: "scalar" },
    { key: "p2", label: "drawbar 2×", type: "f", min: 0, max: 1, step: 0.01, modTarget: "scalar" },
    { key: "p3", label: "drawbar 3×", type: "f", min: 0, max: 1, step: 0.01, modTarget: "scalar" },
    { key: "p4", label: "drawbar 4×", type: "f", min: 0, max: 1, step: 0.01, modTarget: "scalar" },
    { key: "attack", label: "attack", unit: "s", type: "f", min: 0.001, max: 0.2, step: 0.001, modTarget: "scalar" },
    { key: "gate", label: "length", unit: "s", type: "f", min: 0.1, max: 1.5, step: 0.01, modTarget: "scalar" },
    { key: "release", label: "release", unit: "s", type: "f", min: 0.01, max: 0.6, step: 0.01, modTarget: "scalar" },
    { key: "level", label: "level", type: "f", min: 0, max: 1, step: 0.01, modTarget: "scalar" },
  ],
};

export const TONE_DEFAULTS = {
  "lead-synth": { wave: "sawtooth", cutoff: 3000, cutoffEnd: 800, q: 6, attack: 0.01, gate: 0.55, release: 0.08, level: 0.5 },
  "bass-synth": { wave: "square", cutoff: 260, q: 2, attack: 0.004, gate: 0.7, level: 0.9 },
  "organ": { p1: 1, p2: 0.5, p3: 0.25, p4: 0.12, attack: 0.02, gate: 0.9, release: 0.12, level: 0.5 },
};

const toneParams = {};
for (const id of Object.keys(TONE_DEFAULTS)) toneParams[id] = { ...TONE_DEFAULTS[id] };

// live params object for a melodic voice (drums have none — sound design there
// is the frozen 808 flavor; per owner scope the dials cover lead/bass/organ)
export function toneFor(voiceId) {
  return toneParams[voiceId] || null;
}
export function setTone(voiceId, params) {
  if (!toneParams[voiceId]) return null;
  toneParams[voiceId] = { ...params };
  return toneParams[voiceId];
}
export function resetTone(voiceId) {
  if (!toneParams[voiceId]) return null;
  toneParams[voiceId] = { ...TONE_DEFAULTS[voiceId] };
  return toneParams[voiceId];
}

// ── live modulation state (v1.5) ────────────────────────────────────────────
// voiceId -> { key: { rate, depth, lo, hi, phase } }. Only `rate` is UI-set
// today; depth/lo/hi/phase are RESERVED per owner directive (future min/max
// markers plug in here without storage or math changes) and every reader has
// a default: depth 1 (full 0–100% swing), lo/hi = schema min/max, phase 0.
const modState = {};
const SCHEMA_BY = {};
for (const id of Object.keys(TONE_SCHEMA)) {
  modState[id] = {};
  const o = {};
  for (const d of TONE_SCHEMA[id]) o[d.key] = d;
  SCHEMA_BY[id] = o;
}
export function getMods(voiceId) { return modState[voiceId] || null; }
export function setMods(voiceId, mods) {
  if (!(voiceId in modState)) return null;
  modState[voiceId] = mods && typeof mods === "object" ? mods : {};
  return modState[voiceId];
}
export function clearMods(voiceId) { if (modState[voiceId]) modState[voiceId] = {}; }
export function hasMods(voiceId) {
  const m = modState[voiceId];
  return !!m && Object.keys(m).length > 0;
}

// owner semantics: the parameter oscillates its FULL [lo,hi] span as a sine,
// phase-locked to the MASTER TICK grid (cycle = 1920/rate ticks, so BPM
// changes retune it; all voices/notes share one LFO clock). Scalar targets
// sample it per note; AudioParam targets get a live oscillator edge (engine
// provides it via the trigger's modCtx: {tick, tickAt, oscFor}).
function modSpan(d, md) {
  const lo = Number.isFinite(md.lo) ? Math.max(d.min, md.lo) : d.min;
  const hi = Number.isFinite(md.hi) ? Math.min(d.max, md.hi) : d.max;
  const depth = Number.isFinite(md.depth) ? Math.max(0, Math.min(1, md.depth)) : 1;
  return { mid: (lo + hi) / 2, amp: ((hi - lo) / 2) * depth };
}
function modSample(d, md, tick) {
  const { mid, amp } = modSpan(d, md);
  const cyc = lfoCycleTicks(md.rate || LFO_DEFAULT_RATE);
  return mid + amp * Math.sin(2 * Math.PI * (tick / cyc + (md.phase || 0)));
}
// continuous edge on a real AudioParam: automation carries the mid, this
// oscillator+depth-gain adds amp·sin for the life of the note
function attachModEdge(ctx, m, voiceId, key, param, endT) {
  const md = (modState[voiceId] || {})[key];
  if (!md || !m || typeof m.oscFor !== "function") return;
  const osc = m.oscFor(md.rate || LFO_DEFAULT_RATE);
  if (!osc) return;
  const { amp } = modSpan(SCHEMA_BY[voiceId][key], md);
  const g = ctx.createGain();
  g.gain.value = amp;
  osc.connect(g); g.connect(param);
  const ms = Math.max(40, (endT - ctx.currentTime) * 1000) + 60;
  setTimeout(() => { try { g.disconnect(); osc.disconnect(g); } catch (e) { /* gone */ } }, ms);
}

// ── Drum voices ──────────────────────────────────────────────────────────────

function triggerKick(ctx, dest, time, dur, vel) {
  const v = vel / 127;
  const len = Math.max(0.3, Math.min(dur * 1.4, 0.8));
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(155, time);
  osc.frequency.exponentialRampToValueAtTime(42, time + 0.07);
  const g = envGain(ctx, dest, time, v * 1.0, len, 0.001);
  osc.connect(g); osc.start(time); osc.stop(time + len + 0.05);
  // beater click
  const n = ctx.createBufferSource();
  n.buffer = noiseBuffer(ctx);
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass"; hp.frequency.value = 1500;
  const cg = envGain(ctx, dest, time, v * 0.35, 0.02, 0.001);
  n.connect(hp); hp.connect(cg);
  n.start(time, Math.random() * 0.5); n.stop(time + 0.03);
}

function triggerSnare(ctx, dest, time, dur, vel) {
  const v = vel / 127;
  // noise body
  const n = ctx.createBufferSource();
  n.buffer = noiseBuffer(ctx);
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass"; bp.frequency.value = 1800; bp.Q.value = 0.7;
  const ng = envGain(ctx, dest, time, v * 0.85, 0.2, 0.001);
  n.connect(bp); bp.connect(ng);
  n.start(time, Math.random() * 0.5); n.stop(time + 0.25);
  // tonal snap
  const o = startOsc(ctx, "triangle", 185, time, time + 0.12);
  const og = envGain(ctx, dest, time, v * 0.55, 0.1, 0.001);
  o.connect(og);
}

function triggerHat(ctx, dest, time, dur, vel, open) {
  const v = vel / 127;
  const decay = open ? 0.4 : 0.055;
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass"; hp.frequency.value = open ? 6500 : 8000;
  const g = envGain(ctx, dest, time, v * (open ? 0.35 : 0.45), decay, 0.001);
  hp.connect(g);
  // classic 808 metallic: six inharmonic square oscillators
  const f0 = 40;
  for (const ratio of [1, 2, 4.16, 5.43, 6.79, 8.21]) {
    const o = startOsc(ctx, "square", f0 * ratio, time, time + decay + 0.05);
    o.connect(hp);
  }
}

// ── Melodic voices (pitch comes via midiNote; transposition overlay later) ──
// Optional 7th arg `m` = modulation context {tick, tickAt, oscFor} — present
// only when the voice has active ∿ mods (engine builds it per note). Scalar
// params sample the global sine at the note's master tick; param targets keep
// their automation (at the span mid when modulated) plus a live osc edge.

function triggerLead(ctx, dest, time, dur, vel, midi, m) {
  const id = "lead-synth";
  const p = toneFor(id);
  const mods = m ? getMods(id) : null;
  const sc = (key) => {
    const md = mods && mods[key];
    return md ? modSample(SCHEMA_BY[id][key], md, m.tick) : p[key];
  };
  const v = (vel / 127) * sc("level");
  const attack = Math.max(0.0005, sc("attack"));
  const release = Math.max(0.005, sc("release"));
  const gate = Math.max(0.08, Math.min(dur, sc("gate")));
  const mC = mods && mods.cutoff, mE = mods && mods.cutoffEnd, mQ = mods && mods.q;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  if (mQ) { lp.Q.value = modSpan(SCHEMA_BY[id].q, mQ).mid; attachModEdge(ctx, m, id, "q", lp.Q, time + gate + release); }
  else lp.Q.value = p.q;
  const cStart = mC ? modSpan(SCHEMA_BY[id].cutoff, mC).mid : p.cutoff;
  const cEnd = mE ? modSpan(SCHEMA_BY[id].cutoffEnd, mE).mid : p.cutoffEnd;
  lp.frequency.setValueAtTime(Math.max(20, cStart), time);
  lp.frequency.exponentialRampToValueAtTime(Math.max(20, cEnd), time + gate);
  if (mC) attachModEdge(ctx, m, id, "cutoff", lp.frequency, time + gate + release);
  if (mE) attachModEdge(ctx, m, id, "cutoffEnd", lp.frequency, time + gate + release);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, time);
  g.gain.linearRampToValueAtTime(v, time + attack);
  g.gain.setValueAtTime(v, time + gate * 0.7);
  g.gain.exponentialRampToValueAtTime(0.0001, time + gate + release);
  lp.connect(g); g.connect(dest);
  startOsc(ctx, p.wave, mtof(midi), time, time + gate + release + 0.02).connect(lp);
}

function triggerBass(ctx, dest, time, dur, vel, midi, m) {
  const id = "bass-synth";
  const p = toneFor(id);
  const mods = m ? getMods(id) : null;
  const sc = (key) => {
    const md = mods && mods[key];
    return md ? modSample(SCHEMA_BY[id][key], md, m.tick) : p[key];
  };
  const v = (vel / 127) * sc("level");
  const attack = Math.max(0.0005, sc("attack"));
  const gate = Math.max(0.08, Math.min(dur, sc("gate")));
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  const mC = mods && mods.cutoff, mQ = mods && mods.q;
  lp.frequency.value = mC ? modSpan(SCHEMA_BY[id].cutoff, mC).mid : p.cutoff;
  lp.Q.value = mQ ? modSpan(SCHEMA_BY[id].q, mQ).mid : p.q;
  if (mC) attachModEdge(ctx, m, id, "cutoff", lp.frequency, time + gate + 0.05);
  if (mQ) attachModEdge(ctx, m, id, "q", lp.Q, time + gate + 0.05);
  const g = envGain(ctx, lp, time, v, gate, attack);
  lp.connect(dest);
  startOsc(ctx, p.wave, mtof(midi - 12), time, time + gate + 0.05).connect(g);
  startOsc(ctx, "sine", mtof(midi - 24), time, time + gate + 0.05).connect(g);
}

function triggerOrgan(ctx, dest, time, dur, vel, midi, m) {
  const id = "organ";
  const p = toneFor(id);
  const mods = m ? getMods(id) : null;
  const sc = (key) => {
    const md = mods && mods[key];
    return md ? modSample(SCHEMA_BY[id][key], md, m.tick) : p[key];
  };
  const v = (vel / 127) * sc("level");
  const attack = Math.max(0.0005, sc("attack"));
  const release = Math.max(0.005, sc("release"));
  const gate = Math.max(0.1, Math.min(dur, sc("gate")));
  const out = ctx.createGain();
  out.gain.setValueAtTime(0.0001, time);
  out.gain.linearRampToValueAtTime(v, time + attack);
  out.gain.setValueAtTime(v, time + gate);
  out.gain.exponentialRampToValueAtTime(0.0001, time + gate + release);
  out.connect(dest);
  // drawbar-ish partials: [harmonic multiple, level] — levels are the dials (each modulatable)
  const base = mtof(midi);
  const partials = [[1, sc("p1")], [2, sc("p2")], [3, sc("p3")], [4, sc("p4")]];
  for (const [mult, amp] of partials) {
    if (amp <= 0) continue;
    const o = startOsc(ctx, "sine", base * mult, time, time + gate + release + 0.03);
    const pg = ctx.createGain();
    pg.gain.value = amp * 0.25; // partial mix level
    o.connect(pg);
    pg.connect(out);
  }
}

// ── Registry ─────────────────────────────────────────────────────────────────
// Order = the seven ensemble slots (player plan). defaultNote applies to
// melodic voices only until the transpose/chord overlay arrives.

export const VOICES = [
  { id: "bass-drum",  label: "Bass Drum",   melodic: false, defaultNote: 36, trigger: (c, d, t, du, v, m) => triggerKick(c, d, t, du, v) },
  { id: "snare",      label: "Snare",       melodic: false, defaultNote: 38, trigger: (c, d, t, du, v, m) => triggerSnare(c, d, t, du, v) },
  { id: "hat-closed", label: "Hi-Hat Closed", melodic: false, defaultNote: 42, trigger: (c, d, t, du, v, m) => triggerHat(c, d, t, du, v, false) },
  { id: "hat-open",   label: "Hi-Hat Open", melodic: false, defaultNote: 46, trigger: (c, d, t, du, v, m) => triggerHat(c, d, t, du, v, true) },
  { id: "lead-synth", label: "Lead Synth",  melodic: true,  defaultNote: 72, trigger: triggerLead },
  { id: "bass-synth", label: "Bass Synth",  melodic: true,  defaultNote: 36, trigger: triggerBass },
  { id: "organ",      label: "Organ",       melodic: true,  defaultNote: 60, trigger: triggerOrgan },
];

export function getVoice(id) {
  return VOICES.find((v) => v.id === id) || VOICES[0];
}
