// smf.js — Standard MIDI File writer (MIDI-PROTOCOL.md §10).
// Reproduces the reference layout: format 1, single track, division 480,
// tempo meta first, note events per §3, EOT at delta 0. Output is
// event-equivalent to E(R); bytes match the mido reference.

import {
  TICKS_PER_QUARTER,
  MICROSECONDS_PER_BEAT,
  MIDI_DRUM_CHANNEL,
  MIDI_DRUM_NOTE,
  NOTE_VELOCITY,
  dutySplit,
} from "./protocol.js";

// ── Variable-length quantity (§10): 7 bits/byte, MSB set except last ──
export function vlq(value) {
  const bytes = [value & 0x7f];
  value >>>= 7;
  while (value) {
    bytes.unshift((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  return bytes;
}

function ascii(s) {
  return [...s].map((c) => c.charCodeAt(0));
}

function u16(v) {
  return [(v >>> 8) & 0xff, v & 0xff];
}

function u32(v) {
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}

// notes: [{ticks, truncated}] from fillRhythmToTarget (or with .name)
// Uses running status (optional per §10) so bytes are identical to the mido
// reference files, not just event-equivalent.
export function writeMidiBytes(notes) {
  const track = [];
  let lastStatus = -1;
  const pushEvent = (delta, status, d1, d2) => {
    track.push(...vlq(delta));
    if (status !== lastStatus) track.push(status); // running-status compression
    lastStatus = status;
    track.push(d1, d2);
  };

  // set_tempo FF 51 03 <3-byte BE µs/quarter> at delta 0 (meta: doesn't affect lastStatus)
  track.push(0x00, 0xff, 0x51, 0x03,
    (MICROSECONDS_PER_BEAT >> 16) & 0xff,
    (MICROSECONDS_PER_BEAT >> 8) & 0xff,
    MICROSECONDS_PER_BEAT & 0xff);

  const onStatus = 0x90 | MIDI_DRUM_CHANNEL;   // 0x99
  const offStatus = 0x80 | MIDI_DRUM_CHANNEL;  // 0x89

  for (const n of notes) {
    const { sounding, gap } = dutySplit(n.ticks);
    pushEvent(0, onStatus, MIDI_DRUM_NOTE, NOTE_VELOCITY);
    pushEvent(sounding, offStatus, MIDI_DRUM_NOTE, 0x00);
    if (gap > 0) pushEvent(gap, offStatus, MIDI_DRUM_NOTE, 0x00);
  }

  // End of track: delta 0, FF 2F 00
  track.push(0x00, 0xff, 0x2f, 0x00);

  const header = [
    ...ascii("MThd"), ...u32(6),
    ...u16(1),                      // format 1 (mido default; §10)
    ...u16(1),                      // one track
    ...u16(TICKS_PER_QUARTER),      // division 480, metric
  ];

  const out = new Uint8Array(header.length + 8 + track.length);
  out.set(header);
  let p = header.length;
  out.set(ascii("MTrk"), p); p += 4;
  out.set(u32(track.length), p); p += 4;
  out.set(track, p);
  return out;
}

// §10 file naming convention
export function midiFileName(rootHex, height = null) {
  const prefix = rootHex.slice(0, 8);
  return height != null ? `${height}_merkle_${prefix}.mid` : `merkle_${prefix}.mid`;
}

// ── M2M-NOTES v2 §6: mapped export ──
// Same timing container as the canonical file; channel 0, one program_change 0
// after tempo. `pitchSets[i]` = array of simultaneous pitches (1..7) for event i.
// Per-event byte order (normative for poly exports): all note-ons ascending at
// delta 0, then their note-offs at delta = sounding (first carries it, rest 0),
// then gap offs likewise. Monophonic (k=1) collapses to the mido notes-script
// layout exactly — fixture-verified. Running status like mido.
export function writeMappedMidiBytes(notes, pitchSets) {
  const track = [];
  let lastStatus = -1;
  const pushEvent = (delta, status, d1, d2) => {
    track.push(...vlq(delta));
    if (status !== lastStatus) track.push(status);
    lastStatus = status;
    track.push(d1, d2);
  };

  track.push(0x00, 0xff, 0x51, 0x03,
    (MICROSECONDS_PER_BEAT >> 16) & 0xff,
    (MICROSECONDS_PER_BEAT >> 8) & 0xff,
    MICROSECONDS_PER_BEAT & 0xff);
  track.push(0x00, 0xc0, 0x00); // program_change ch0 prog0 (OP4: fixed)
  lastStatus = -1;

  for (let i = 0; i < notes.length; i++) {
    const { sounding, gap } = dutySplit(notes[i].ticks);
    const set = [...(pitchSets[i] || [])].sort((a, b) => a - b);
    if (!set.length) continue;
    for (const key of set) pushEvent(0, 0x90, key, NOTE_VELOCITY);
    set.forEach((key, j) => pushEvent(j === 0 ? sounding : 0, 0x80, key, 0x00));
    if (gap > 0) set.forEach((key, j) => pushEvent(j === 0 ? gap : 0, 0x80, key, 0x00));
  }

  track.push(0x00, 0xff, 0x2f, 0x00);

  const header = [
    ...ascii("MThd"), ...u32(6),
    ...u16(1), ...u16(1), ...u16(TICKS_PER_QUARTER),
  ];
  const out = new Uint8Array(header.length + 8 + track.length);
  out.set(header);
  let p = header.length;
  out.set(ascii("MTrk"), p); p += 4;
  out.set(u32(track.length), p); p += 4;
  out.set(track, p);
  return out;
}

export function mappedMidiFileName(rootHex, height = null) {
  const prefix = rootHex.slice(0, 8);
  return height != null ? `${height}_merkle_${prefix}_notes.mid` : `merkle_${prefix}_notes.mid`;
}

export function downloadMidiMapped(notes, pitchSets, rootHex, height = null) {
  const bytes = writeMappedMidiBytes(notes, pitchSets);
  const blob = new Blob([bytes], { type: "audio/midi" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = mappedMidiFileName(rootHex, height);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function downloadMidi(notes, rootHex, height = null) {
  const bytes = writeMidiBytes(notes);
  const blob = new Blob([bytes], { type: "audio/midi" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = midiFileName(rootHex, height);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
