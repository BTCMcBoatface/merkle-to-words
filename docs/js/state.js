// state.js — session persistence. URL query is the shareable source of truth;
// localStorage mirrors it for convenience. Full merkle roots are stored so a
// restored session derives locally with ZERO API calls.
//
//   ?v=1&b=<height>~<root64>,...&s=<blockIdx|->(x7)&m=ind|master
//          [&t=..][&u=..][&p=<b64 map cells>][&q=<1|2|4|8|16>][&o=p][&h=<±capo>][&g=m]
//          [&e=<paint steps/bar 1|2|4|6|8|12|16>][&w=<³ flag>][&j=<seq bars>][&k=<blockquant ticks>]
//          [&i=<rrrr.. lane modes r|s>][&f=<b64 paint events>; legacy v1.4 &d cell arrays still decode]
//
// Blocks with unknown height (manual roots) use height "-".
// &p = base64url of count-prefixed column stacks over the 128-col store
//      (M2M-NOTES v2.1 encodeCells; trailing empties trimmed, so a shrunken map's
//      hidden tail still round-trips); &q = looping extent in bars (default 4);
// &o = polyphony on; &h = map-level capo ±1..±11; &g = merkle source.
// Legacy v1 payloads (64 one-byte columns, no &q) decode as mono over 8 bars.

import { encodeCells, decodeCells, decodeLegacyCells, MAP_MAX_COLS } from "./notes.js";
import { encodeLanes, decodeLanes, lanesHaveEdits, lanesFromLegacy, DRUM_LANES, SEQ_EXTENTS, SEQ_DEFAULT_BARS, SEQ_DEFAULT_SEL, EFFECTIVE_STEPS, PAINT_SELS, paintStepsPerBar } from "./seq.js";

const LS_KEY = "m2m-session-v1";
const LS_KEY_LEGACY = "m2m-rhyth…n-v1"; // pre-v1.5 shipped constant (stray “…” glyph — intentional literal, used only for one-time migration)
const V = "1";
const HEX64 = /^[0-9a-f]{64}$/;

// browsers that ran pre-1.5 builds stored the session mirror under the corrupted key
function migrateLS() {
  try {
    if (localStorage.getItem(LS_KEY) === null && localStorage.getItem(LS_KEY_LEGACY) !== null) {
      localStorage.setItem(LS_KEY, localStorage.getItem(LS_KEY_LEGACY));
      localStorage.removeItem(LS_KEY_LEGACY);
    }
  } catch (e) { /* private mode */ }
}

function b64uEncode(arr) {
  let s = "";
  for (const x of arr) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64uDecode(str) {
  const raw = atob(str.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function encode({ blocks, slots, mode, transpose, bpm, cells, mapBars, polyphony, mapOffset, source, seq }) {
  const b = blocks.map((k) => `${k.height ?? "-"}~${k.rootHex}`).join(",");
  const s = slots.map((i) => (i == null || i < 0 ? "-" : i)).join(",");
  const m = mode === "master" ? "master" : "ind";
  let q = `?v=${V}&b=${b}&s=${s}&m=${m}`;
  if (Array.isArray(transpose) && transpose.some((x) => x | 0)) {
    q += `&t=${transpose.map((x) => Math.max(-24, Math.min(24, x | 0))).join(",")}`;
  }
  if (bpm && bpm !== 120) q += `&u=${Math.round(bpm)}`;
  if (Array.isArray(cells) && cells.some((c) => c && c.length)) {
    q += `&p=${b64uEncode(encodeCells(cells))}&q=${mapBars || 4}`;
    if (polyphony) q += `&o=p`;
    if (mapOffset) q += `&h=${mapOffset}`;
  }
  if (source === "merkle") q += `&g=m`;
  // drum sequencer (v1.6): only non-default bits travel — &e paint steps
  // (effective, incl 6/12), &w triplet flag, &j bars, &k block-quant ticks,
  // &i lane modes, &f event-lane payload (legacy v1.4 &d cell arrays decode)
  if (seq && seq.lanes && seq.modes) {
    const steps = paintStepsPerBar(seq.sel || SEQ_DEFAULT_SEL, !!seq.triplet);
    if (steps !== SEQ_DEFAULT_SEL || seq.triplet) q += `&e=${steps}`;
    if (seq.triplet) q += `&w=1`;
    if (seq.bars && seq.bars !== SEQ_DEFAULT_BARS && SEQ_EXTENTS.includes(seq.bars)) q += `&j=${seq.bars}`;
    if (seq.blockQuant) q += `&k=${seq.blockQuant}`;
    const mstr = DRUM_LANES.map((id) => (seq.modes[id] === "seq" ? "s" : "r")).join("");
    if (mstr.includes("s")) q += `&i=${mstr}`;
    if (lanesHaveEdits(seq.lanes)) q += `&f=${b64uEncode(encodeLanes(seq.lanes))}`;
  }
  return q;
}

export function shareURL(view) {
  return location.origin + location.pathname + encode(view);
}

export function decode(search) {
  try {
    if (!search) return null;
    const q = new URLSearchParams(search);
    if (q.get("v") !== V) return null;
    const bs = q.get("b"); const ss = q.get("s");
    if (!bs || !ss) return null;
    const blocks = bs.split(",").map((tok) => {
      const [h, root] = tok.split("~");
      if (!HEX64.test(root || "")) throw new Error("bad root");
      return { height: h === "-" ? null : parseInt(h, 10), rootHex: root };
    });
    if (blocks.length < 1 || blocks.length > 8) return null;
    if (blocks.some((k) => k.height != null && !Number.isInteger(k.height))) return null;
    const parts = ss.split(",");
    if (parts.length !== 7) return null;
    const slots = parts.map((p) => (p === "-" ? -1 : parseInt(p, 10)));
    if (slots.some((i) => i >= blocks.length)) return null;
    const mode = q.get("m") === "master" ? "master" : "independent";
    const view = { blocks, slots, mode };
    const tParam = q.get("t");
    if (tParam) {
      const ts = tParam.split(",");
      if (ts.length === 7) {
        view.transpose = ts.map((x) => {
          const n = parseInt(x, 10) || 0;
          return Math.max(-24, Math.min(24, n));
        });
      }
    }
    const u = parseInt(q.get("u") || "120", 10);
    if (u >= 20 && u <= 300) view.bpm = u;
    const pParam = q.get("p");
    if (pParam) {
      const bytes = b64uDecode(pParam);
      const bars = parseInt(q.get("q") || "0", 10);
      if (bars === 1 || bars === 2 || bars === 4 || bars === 8 || bars === 16) {
        view.cells = decodeCells(bytes, MAP_MAX_COLS);   // padded store; extent = bars
        view.mapBars = bars;
        view.polyphony = q.get("o") === "p";
        const h = parseInt(q.get("h") || "0", 10);
        if (h) view.mapOffset = Math.max(-11, Math.min(11, h));
      } else if (bytes.length === 64) {
        // legacy v1 payload: 64 one-byte mono columns over the 8-bar cycle
        view.cells = decodeLegacyCells(bytes);
        view.mapBars = 8;
      } else {
        return null;
      }
    }
    if (q.get("g") === "m") view.source = "merkle";
    // drum sequencer params (v1.6): &e paint steps &w ³ &j bars &k blockquant
    // &i modes &f events; legacy v1.4 &d (res-cell arrays) are re-mapped to the
    // 40-tick lattice via lanesFromLegacy
    const e = parseInt(q.get("e") || "0", 10);
    const jb = parseInt(q.get("j") || "0", 10);
    const im = q.get("i");
    const dd = q.get("d");
    const ff = q.get("f");
    const kq = parseInt(q.get("k") || "0", 10);
    if (EFFECTIVE_STEPS.includes(e) || q.get("w") || SEQ_EXTENTS.includes(jb) || im || dd || ff || [480, 240, 120].includes(kq)) {
      const seq = { sel: SEQ_DEFAULT_SEL, triplet: !!q.get("w"), bars: SEQ_DEFAULT_BARS, blockQuant: 0, modes: {}, lanes: null };
      if (e === 6) { seq.sel = 4; seq.triplet = true; }
      else if (e === 12) { seq.sel = 8; seq.triplet = true; }
      else if (PAINT_SELS.includes(e)) seq.sel = e;
      if (seq.triplet && seq.sel === 16) seq.sel = 8;
      if (SEQ_EXTENTS.includes(jb)) seq.bars = jb;
      if ([480, 240, 120].includes(kq)) seq.blockQuant = kq;
      if (im && im.length === 4 && /^[rs]{4}$/.test(im)) {
        DRUM_LANES.forEach((id, idx) => { seq.modes[id] = im[idx] === "s" ? "seq" : "rhythm"; });
      }
      if (ff) {
        const lanes = decodeLanes(b64uDecode(ff));
        if (!lanes) return null; // malformed events → fresh-session flow
        seq.lanes = lanes;
      } else if (dd) {
        const lanes = lanesFromLegacy(b64uDecode(dd), seq.sel); // old semantics: &e was the cell grid
        if (!lanes) return null;
        seq.lanes = lanes;
      }
      view.seq = seq;
    }
    return view;
  } catch (e) {
    return null; // malformed → fresh-session flow
  }
}

export function save(view) {
  migrateLS();
  try { localStorage.setItem(LS_KEY, JSON.stringify(view)); } catch (e) { /* private mode */ }
  try { history.replaceState(null, "", encode(view)); } catch (e) { /* file:// */ }
}

export function load() {
  return decode(location.search) || decode(loadLSRaw());
}

function loadLSRaw() {
  migrateLS();
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    // re-encode through the query-string path for one shared validator
    return encode(v);
  } catch (e) { return null; }
}
