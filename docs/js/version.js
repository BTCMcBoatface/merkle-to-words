// version.js — web player version (single source). Displayed in the header,
// stamped into snapshots. Convention (PROJECT.md): MAJOR = breaking
// session/export semantics, MINOR = features added, PATCH = fixes.
// 1.0.0 = first ensemble build (retroactive); 1.1.0 = live conductor, snapshots,
// piano-roll map, shelf-by-default, assign dropdown, two-click clear;
// 1.2.0 = map subdivisions (1/2, 1/4), ♯-fold view, map capo ±1;
// 1.3.0 = voice tone panels (lead/bass/organ dials + favorites bank) +
// whole-mix reverb knob — all render-time, all localStorage, session URL
// semantics unchanged;
// 1.3.1 = tone panel is an instrument popup (≥2 card widths, ~70vw) instead of
// inline-folded (button overflow); actions row wraps.
export const APP_VERSION = "1.3.1";
