// state.js — session persistence. URL query is the shareable source of truth;
// localStorage mirrors it for convenience. Full merkle roots are stored so a
// restored session derives locally with ZERO API calls.
//
//   ?v=1&b=<height>~<root64>,...&s=<blockIdx|->(x7)&m=ind|master
//
// Blocks with unknown height (manual roots) use height "-".

const LS_KEY = "m2m-rhyth…n-v1";
const V = "1";
const HEX64 = /^[0-9a-f]{64}$/;

export function encode({ blocks, slots, mode }) {
  const b = blocks.map((k) => `${k.height ?? "-"}~${k.rootHex}`).join(",");
  const s = slots.map((i) => (i == null || i < 0 ? "-" : i)).join(",");
  const m = mode === "master" ? "master" : "ind";
  return `?v=${V}&b=${b}&s=${s}&m=${m}`;
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
    return { blocks, slots, mode };
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
