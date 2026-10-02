// tests/verify.mjs — cross-language sync check: docs/js/protocol.js must
// reproduce the Python reference E(R) exactly (fixtures.json from
// make-fixtures.py). Run: node tests/verify.mjs
//
// Covers both conformance levels: derivation (E(R) events) and full
// (SMF bytes == mido output for the wrapped root).

import { readFile } from "node:fs/promises";
import { derivePattern, deriveLeaves, hexToBytes } from "../docs/js/protocol.js";
import { deriveMelody, pitchByte, deriveScaleParams } from "../docs/js/notes.js";
import { writeMidiBytes, writeMappedMidiBytes } from "../docs/js/smf.js";

const toBytesHex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
const fails = [];
let checks = 0;

function eq(actual, expected, where) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) fails.push(`${where}\n    js:  ${a}\n    py:  ${e}`);
}

const doc = JSON.parse(
  await readFile(new URL("./fixtures.json", import.meta.url), "utf8")
);
const { fixtures } = doc;

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

  // ── M2M-NOTES v1.0.0 layer: scale params, pitch bytes, melody, mapped file ──
  if (f.melody) {
    const leaves = await deriveLeaves(f.root);
    eq(leaves.map(pitchByte), f.melody.pitchBytes, `${f.label}: pitchBytes (bits 11–18, disjoint)`);
    const jsScale = deriveScaleParams(hexToBytes(f.root));
    for (const [jk, pk] of [["modeIndex", "modeIndex"], ["modeName", "modeName"],
      ["rootNoteIndex", "rootNoteIndex"], ["rootNoteName", "rootNoteName"],
      ["baseOctave", "baseOctave"], ["octaveRange", "octaveRange"], ["scaleSize", "scaleSize"]]) {
      eq(jsScale[jk], f.melody.scale[pk], `${f.label}: scale.${jk}`);
    }
    const mel = await deriveMelody(f.root);
    eq(mel.melody32, f.melody.melody32, `${f.label}: melody32`);

    if (f.smfMappedHex) {
      const pitches = p.notes.map((_n, i) => f.melody.melody32[i % 32]);
      eq(toBytesHex(writeMappedMidiBytes(p.notes, pitches)), f.smfMappedHex,
        `${f.label}: mapped SMF bytes == notes-pipeline mido reference`);
    }
  }
}

if (fails.length) {
  console.error(`FAIL — ${fails.length}/${checks} checks failed:\n`);
  for (const msg of fails) console.error("  ✗ " + msg);
  process.exit(1);
} else {
  console.log(`PASS — ${fixtures.length} golden vectors, ${checks} checks — JS ≡ Python reference (${doc.protocol} + ${doc.notesProtocol})`);
}
