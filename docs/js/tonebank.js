// tonebank.js — localStorage persistence for the player's SOUND layer:
// live per-voice tone params, a named favorites bank per voice (reloaded one
// at a time), and the global reverb amount.
//
// Deliberately NOT part of the shareable session URL or snapshots: sound
// settings are local to the browser (owner ruling, v1.3.0), and downloads
// stay canonical regardless (MIDI-PROTOCOL.md §5/§11).

import { TONE_SCHEMA, TONE_DEFAULTS } from "./synth.js";

const LS_KEY = "m2m-ton…s-v1";
const FAV_CAP = 8; // named favorites per voice

const VOICE_IDS = Object.keys(TONE_SCHEMA);

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
  const tone = {}, favs = {};
  for (const id of VOICE_IDS) { tone[id] = { ...TONE_DEFAULTS[id] }; favs[id] = []; }
  return { tone, favs, reverb: 0 };
}

export function load() {
  try {
    const o = JSON.parse(localStorage.getItem(LS_KEY) || "null");
    if (!o || typeof o !== "object") return null;
    const b = blank();
    for (const id of VOICE_IDS) {
      b.tone[id] = sanitizeParams(id, o.tone && o.tone[id]);
      if (Array.isArray(o.favs && o.favs[id])) {
        b.favs[id] = o.favs[id]
          .filter((f) => f && typeof f === "object")
          .map((f) => ({ name: String(f.name || "").slice(0, 24), ts: f.ts | 0, params: sanitizeParams(id, f.params) }))
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
export function addFav(bank, voiceId, name, params) {
  const list = bank.favs[voiceId] || (bank.favs[voiceId] = []);
  list.push({ name: name || `tone ${new Date().toLocaleTimeString()}`, ts: Date.now(), params: sanitizeParams(voiceId, params) });
  if (list.length > FAV_CAP) list.splice(0, list.length - FAV_CAP);
  save(bank);
  return list;
}

export function removeFav(bank, voiceId, i) {
  if (bank.favs[voiceId]) bank.favs[voiceId].splice(i, 1);
  save(bank);
}
