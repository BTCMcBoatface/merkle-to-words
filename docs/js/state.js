// state.js — session persistence. URL query is the shareable source of truth;
// localStorage mirrors it for convenience. Full merkle roots are stored so a
// restored session derives locally with ZERO API calls.
//
//   ?v=1&b=<height>~<root64>,...&s=<blockIdx|->(x7)&m=ind|master[&t=..][&u=..][&p=..][&g=m]
//
// Blocks with unknown height (manual roots) use height "-".
// &p = base64url of the 64 melody-map bytes (M2M-NOTES §7); &g = melody source.

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

export function encode({ blocks, slots, mode, transpose, bpm, map, source }) {
  const b = blocks.map((k) => `${k.height ?? "-"}~${k.rootHex}`).join(",");
  const s = slots.map((i) => (i == null || i < 0 ? "-" : i)).join(",");
  const m = mode === "master" ? "master" : "ind";
  let q = `?v=${V}&b=${b}&s=${s}&m=${m}`;
  if (Array.isArray(transpose) && transpose.some((x) => x | 0)) {
    q += `&t=${transpose.map((x) => Math.max(-24, Math.min(24, x | 0))).join(",")}`;
  }
  if (bpm && bpm !== 120) q += `&u=${Math.round(bpm)}`;
  if (Array.isArray(map) && map.length === 64 && map.some((x) => x | 0)) {
    q += `&p=${b64uEncode(map)}`;
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
      const cells = b64uDecode(pParam);
      if (cells.length !== 64) return null;
      // sanitize: 0 or a MIDI note 21–108, else 0
      view.map = cells.map((v) => (v >= 21 && v <= 108 ? v : 0));
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
