// tonebank.js — localStorage persistence for the player's SOUND layer:
// live per-voice tone params, a named favorites bank per voice (reloaded one
// at a time), and the global reverb amount.
//
// Deliberately NOT part of the shareable session URL or snapshots: sound
// settings are local to the browser (owner ruling, v1.3.0), and downloads
// stay canonical regardless (MIDI-PROTOCOL.md §5/§11).

import { TONE_SCHEMA, TONE_DEFAULTS, LFO_RATES, LFO_DEFAULT_RATE } from "./synth.js";

const LS_KEY = "m2m-tones-v1";
const LS_KEY_LEGACY = "m2m-ton…s-v1"; // pre-v1.5 shipped constant (a stray “…” glyph — DO NOT "fix": it is the literal old key, kept for one-time data migration)
const FAV_CAP = 8; // named favorites per voice

const VOICE_IDS = Object.keys(TONE_SCHEMA);

// browsers that ran pre-1.5 builds stored under the corrupted key — adopt it once
function migrateLS() {
  try {
    if (localStorage.getItem(LS_KEY) === null && localStorage.getItem(LS_KEY_LEGACY) !== null) {
      localStorage.setItem(LS_KEY, localStorage.getItem(LS_KEY_LEGACY));
      localStorage.removeItem(LS_KEY_LEGACY);
    }
  } catch (e) { /* private mode */ }
}

function sanitizeMods(voiceId, raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  const rates = LFO_RATES.map((r) => r.steps);
  for (const d of TONE_SCHEMA[voiceId]) {
    const m = raw[d.key];
    if (!m || typeof m !== "object") continue;
    const e = { rate: rates.includes(m.rate) ? m.rate : LFO_DEFAULT_RATE };
    // reserved-for-future fields survive the round-trip when valid:
    if (Number.isFinite(m.depth)) e.depth = Math.max(0, Math.min(1, m.depth));
    if (Number.isFinite(m.lo) && Number.isFinite(m.hi) && m.lo >= d.min && m.hi <= d.max && m.lo < m.hi) {
      e.lo = m.lo; e.hi = m.hi;
    }
    if (Number.isFinite(m.phase)) e.phase = Math.max(0, Math.min(1, m.phase));
    out[d.key] = e;
  }
  return out;
}

// clamp/enum-check a raw param bag against the voice's schema, defaults fill gaps
function sanitizeParams(voiceId, raw) {
  const out = { ...TONE_DEFAULTS[voiceId] };
  if (!raw || typeof raw !== "object") return out;
  for (const d of TONE_SCHEMA[voiceId]) {
    const v = raw[d.key];
    if (v === undefined) continue;
    if (d.type === "enum") { if (d.options.includes(v)) out[d.key] = v; }
    else {
      const n = Number(v);
      if (Number.isFinite(n)) out[d.key] = Math.max(d.min, Math.min(d.max, n));
    }
  }
  return out;
}

export function blank() {
  const tone = {}, mods = {}, favs = {};
  for (const id of VOICE_IDS) {
    tone[id] = { ...TONE_DEFAULTS[id] };
    mods[id] = {};
    favs[id] = [];
  }
  return { tone, mods, favs, reverb: 0 };
}

export function load() {
  migrateLS();
  try {
    const o = JSON.parse(localStorage.getItem(LS_KEY) || "null");
    if (!o || typeof o !== "object") return null;
    const b = blank();
    for (const id of VOICE_IDS) {
      b.tone[id] = sanitizeParams(id, o.tone && o.tone[id]);
      b.mods[id] = sanitizeMods(id, o.mods && o.mods[id]);
      if (Array.isArray(o.favs && o.favs[id])) {
        b.favs[id] = o.favs[id]
          .filter((f) => f && typeof f === "object")
          .map((f) => ({
            name: String(f.name || "").slice(0, 24), ts: f.ts | 0,
            params: sanitizeParams(id, f.params),
            mods: sanitizeMods(id, f.mods),   // oscillations ride with the favorite
          }))
          .slice(-FAV_CAP);
      }
    }
    const r = Number(o.reverb);
    b.reverb = Number.isFinite(r) ? Math.max(0, Math.min(1, r)) : 0;
    return b;
  } catch (e) { return null; }
}

export function save(bank) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(bank)); } catch (e) { /* private mode */ }
}

// returns the (already capped) favorites list for the voice
export function addFav(bank, voiceId, name, params, mods) {
  const list = bank.favs[voiceId] || (bank.favs[voiceId] = []);
  list.push({ name: name || `tone ${new Date().toLocaleTimeString()}`, ts: Date.now(), params: sanitizeParams(voiceId, params), mods: sanitizeMods(voiceId, mods) });
  if (list.length > FAV_CAP) list.splice(0, list.length - FAV_CAP);
  save(bank);
  return list;
}

export function removeFav(bank, voiceId, i) {
  if (bank.favs[voiceId]) bank.favs[voiceId].splice(i, 1);
  save(bank);
}
