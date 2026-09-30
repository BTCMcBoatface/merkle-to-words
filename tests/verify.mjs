// tests/verify.mjs — cross-language sync check: docs/js/protocol.js must
// reproduce the Python reference E(R) exactly (fixtures.json from
// make-fixtures.py). Run: node tests/verify.mjs
//
// Covers both conformance levels: derivation (E(R) events) and full
// (SMF bytes == mido output for the wrapped root).

import { readFile } from "node:fs/promises";
import { derivePattern } from "../docs/js/protocol.js";
import { writeMidiBytes } from "../docs/js/smf.js";

const toBytesHex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
const fails = [];
let checks = 0;

function eq(actual, expected, where) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) fails.push(`${where}\n    js:  ${a}\n    py:  ${e}`);
}

const { fixtures } = JSON.parse(
  await readFile(new URL("./fixtures.json", import.meta.url), "utf8")
);

for (const f of fixtures) {
  const p = await derivePattern(f.root);
  eq(p.barCount, f.barCount, `${f.label}: barCount`);
  eq(p.firstTwoBits, f.firstTwoBits, `${f.label}: firstTwoBits`);
  eq(p.targetTicks, f.targetTicks, `${f.label}: targetTicks`);
  eq(p.notes.map(({ name, ticks, truncated }) => ({ name, ticks, truncated })),
     f.notes, `${f.label}: notes`);
  eq(p.onsets.map(({ tick, durationTicks, soundingTicks }) => ({ tick, durationTicks, soundingTicks })),
     f.onsets, `${f.label}: onsets (§3 event grid)`);
  eq(p.onsets.reduce((a, o) => a + o.durationTicks, 0), f.sumTicks, `${f.label}: loop sum`);
  eq(p.noteCountWrapped, f.wrapped, `${f.label}: wrapped flag`);

  if (f.smfHex) {
    eq(toBytesHex(writeMidiBytes(p.notes)), f.smfHex, `${f.label}: SMF bytes == mido reference`);
  }
}

if (fails.length) {
  console.error(`FAIL — ${fails.length}/${checks} checks failed:\n`);
  for (const msg of fails) console.error("  ✗ " + msg);
  process.exit(1);
} else {
  console.log(`PASS — ${fixtures.length} golden vectors, ${checks} checks — JS E(R) matches Python reference (M2M-RHYTHM/1.0.0)`);
}
