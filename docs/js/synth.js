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
  const v = vel / 127;
  const gate = Math.max(0.08, Math.min(dur, 0.55));
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass"; lp.Q.value = 6;
  lp.frequency.setValueAtTime(3000, time);
  lp.frequency.exponentialRampToValueAtTime(800, time + gate);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, time);
  g.gain.linearRampToValueAtTime(v * 0.5, time + 0.01);
  g.gain.setValueAtTime(v * 0.5, time + gate * 0.7);
  g.gain.exponentialRampToValueAtTime(0.0001, time + gate + 0.08);
  lp.connect(g); g.connect(dest);
  startOsc(ctx, "sawtooth", mtof(midi), time, time + gate + 0.1).connect(lp);
}

function triggerBass(ctx, dest, time, dur, vel, midi) {
  const v = vel / 127;
  const gate = Math.max(0.08, Math.min(dur, 0.7));
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass"; lp.frequency.value = 260; lp.Q.value = 2;
  const g = envGain(ctx, lp, time, v * 0.9, gate, 0.004);
  lp.connect(dest);
  startOsc(ctx, "square", mtof(midi - 12), time, time + gate + 0.05).connect(g);
  startOsc(ctx, "sine", mtof(midi - 24), time, time + gate + 0.05).connect(g);
}

function triggerOrgan(ctx, dest, time, dur, vel, midi) {
  const v = vel / 127;
  const gate = Math.max(0.1, Math.min(dur, 0.9));
  const out = ctx.createGain();
  out.gain.setValueAtTime(0.0001, time);
  out.gain.linearRampToValueAtTime(v * 0.5, time + 0.02);
  out.gain.setValueAtTime(v * 0.5, time + gate);
  out.gain.exponentialRampToValueAtTime(0.0001, time + gate + 0.12);
  out.connect(dest);
  // drawbar-ish partials: [harmonic multiple, amplitude]
  const base = mtof(midi);
  for (const [mult, amp] of [[1, 1], [2, 0.5], [3, 0.25], [4, 0.12]]) {
    const o = startOsc(ctx, "sine", base * mult, time, time + gate + 0.15);
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
