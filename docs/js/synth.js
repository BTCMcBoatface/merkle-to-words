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
// drawbar levels, output level) — no new signal sources, no LFO routing.
// Downloads stay canonical (MIDI-PROTOCOL.md §5/§11): this lives in the air,
// not in the derived event stream.

export const WAVES = ["sine", "square", "sawtooth", "triangle"];

export const TONE_SCHEMA = {
  "lead-synth": [
    { key: "wave", label: "waveform", type: "enum", options: WAVES },
    { key: "cutoff", label: "filter open", unit: "Hz", type: "f", min: 200, max: 8000, step: 25 },
    { key: "cutoffEnd", label: "filter close", unit: "Hz", type: "f", min: 80, max: 6000, step: 25 },
    { key: "q", label: "resonance", type: "f", min: 0.3, max: 18, step: 0.1 },
    { key: "attack", label: "attack", unit: "s", type: "f", min: 0.001, max: 0.1, step: 0.001 },
    { key: "gate", label: "length", unit: "s", type: "f", min: 0.1, max: 1.5, step: 0.01 },
    { key: "release", label: "release", unit: "s", type: "f", min: 0.01, max: 0.6, step: 0.01 },
    { key: "level", label: "level", type: "f", min: 0, max: 1, step: 0.01 },
  ],
  "bass-synth": [
    { key: "wave", label: "waveform", type: "enum", options: WAVES },
    { key: "cutoff", label: "filter cut", unit: "Hz", type: "f", min: 80, max: 2000, step: 10 },
    { key: "q", label: "resonance", type: "f", min: 0.3, max: 18, step: 0.1 },
    { key: "attack", label: "attack", unit: "s", type: "f", min: 0.001, max: 0.1, step: 0.001 },
    { key: "gate", label: "length", unit: "s", type: "f", min: 0.1, max: 1.5, step: 0.01 },
    { key: "level", label: "level", type: "f", min: 0, max: 1, step: 0.01 },
  ],
  "organ": [
    { key: "p1", label: "drawbar 1×", type: "f", min: 0, max: 1, step: 0.01 },
    { key: "p2", label: "drawbar 2×", type: "f", min: 0, max: 1, step: 0.01 },
    { key: "p3", label: "drawbar 3×", type: "f", min: 0, max: 1, step: 0.01 },
    { key: "p4", label: "drawbar 4×", type: "f", min: 0, max: 1, step: 0.01 },
    { key: "attack", label: "attack", unit: "s", type: "f", min: 0.001, max: 0.2, step: 0.001 },
    { key: "gate", label: "length", unit: "s", type: "f", min: 0.1, max: 1.5, step: 0.01 },
    { key: "release", label: "release", unit: "s", type: "f", min: 0.01, max: 0.6, step: 0.01 },
    { key: "level", label: "level", type: "f", min: 0, max: 1, step: 0.01 },
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

function triggerLead(ctx, dest, time, dur, vel, midi) {
  const p = toneFor("lead-synth");
  const v = (vel / 127) * p.level;
  const gate = Math.max(0.08, Math.min(dur, p.gate));
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass"; lp.Q.value = p.q;
  lp.frequency.setValueAtTime(p.cutoff, time);
  lp.frequency.exponentialRampToValueAtTime(p.cutoffEnd, time + gate);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, time);
  g.gain.linearRampToValueAtTime(v, time + p.attack);
  g.gain.setValueAtTime(v, time + gate * 0.7);
  g.gain.exponentialRampToValueAtTime(0.0001, time + gate + p.release);
  lp.connect(g); g.connect(dest);
  startOsc(ctx, p.wave, mtof(midi), time, time + gate + p.release + 0.02).connect(lp);
}

function triggerBass(ctx, dest, time, dur, vel, midi) {
  const p = toneFor("bass-synth");
  const v = (vel / 127) * p.level;
  const gate = Math.max(0.08, Math.min(dur, p.gate));
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass"; lp.frequency.value = p.cutoff; lp.Q.value = p.q;
  const g = envGain(ctx, lp, time, v, gate, p.attack);
  lp.connect(dest);
  startOsc(ctx, p.wave, mtof(midi - 12), time, time + gate + 0.05).connect(g);
  startOsc(ctx, "sine", mtof(midi - 24), time, time + gate + 0.05).connect(g);
}

function triggerOrgan(ctx, dest, time, dur, vel, midi) {
  const p = toneFor("organ");
  const v = (vel / 127) * p.level;
  const gate = Math.max(0.1, Math.min(dur, p.gate));
  const out = ctx.createGain();
  out.gain.setValueAtTime(0.0001, time);
  out.gain.linearRampToValueAtTime(v, time + p.attack);
  out.gain.setValueAtTime(v, time + gate);
  out.gain.exponentialRampToValueAtTime(0.0001, time + gate + p.release);
  out.connect(dest);
  // drawbar-ish partials: [harmonic multiple, level] — levels are the dials
  const base = mtof(midi);
  const partials = [[1, p.p1], [2, p.p2], [3, p.p3], [4, p.p4]];
  for (const [mult, amp] of partials) {
    if (amp <= 0) continue;
    const o = startOsc(ctx, "sine", base * mult, time, time + gate + p.release + 0.03);
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
