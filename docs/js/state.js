// state.js — session persistence. URL query is the shareable source of truth;
// localStorage mirrors it for convenience. Full merkle roots are stored so a
// restored session derives locally with ZERO API calls.
//
//   ?v=1&b=<height>~<root64>,...&s=<blockIdx|->(x7)&m=ind|master
//          [&t=..][&u=..][&p=<b64 map cells>][&q=<1|2|4|8|16>][&o=p][&h=<±capo>][&g=m]
//
// Blocks with unknown height (manual roots) use height "-".
// &p = base64url of count-prefixed column stacks over the 128-col store
//      (M2M-NOTES v2.1 encodeCells; trailing empties trimmed, so a shrunken map's
//      hidden tail still round-trips); &q = looping extent in bars (default 4);
// &o = polyphony on; &h = map-level capo ±1..±11; &g = merkle source.
// Legacy v1 payloads (64 one-byte columns, no &q) decode as mono over 8 bars.

import { encodeCells, decodeCells, decodeLegacyCells, MAP_MAX_COLS } from "./notes.js";

const LS_KEY = "m2m-rhyth…n-v1";
const V = "1";
const HEX64 = /^[0-9a-f]{64}$/;

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

export function encode({ blocks, slots, mode, transpose, bpm, cells, mapBars, polyphony, mapOffset, source }) {
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
    return view;
  } catch (e) {
    return null; // malformed → fresh-session flow
  }
}

export function save(view) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(view)); } catch (e) { /* private mode */ }
  try { history.replaceState(null, "", encode(view)); } catch (e) { /* file:// */ }
}

export function load() {
  return decode(location.search) || decode(loadLSRaw());
}

function loadLSRaw() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    // re-encode through the query-string path for one shared validator
    return encode(v);
  } catch (e) { return null; }
}
