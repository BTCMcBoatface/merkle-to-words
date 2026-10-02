#!/usr/bin/env python3
"""
make-fixtures.py — generate tests/fixtures.json: golden E(R) vectors derived
from midi-from-merkle.py (the Python reference; M2M-RHYTHM v1.0.2,
derivation frozen at 1.0.0).

These fixtures are the cross-language sync check: docs/js/protocol.js must
reproduce them exactly (run via tests/verify.mjs under Node).

Usage:
    pip install mido          # module-level dependency of the reference
    python3 make-fixtures.py
"""

import hashlib
import importlib.util
import io
import json
import contextlib
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent


def load_module(fname):
    spec = importlib.util.spec_from_file_location(fname.replace(".py", "").replace("-", "_"), HERE / fname)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


m = load_module("midi-from-merkle.py")
nm = load_module("notes-from-merkle.py")  # shares rhythm engine; adds pitch rules


def derive(root_hex):
    """Run the reference pipeline and return the fixture dict for one root."""
    leaves = m.derive_leaves(root_hex)
    durations = [m.leaf_to_duration(l) for l in leaves]
    bars, target_beats, bits = m.root_bits_to_bar_count(root_hex)
    target = target_beats * m.TICKS_PER_QUARTER
    notes = m.fill_rhythm_to_target(durations, target)

    total = sum(t for _, t, _ in notes)
    assert total == target, f"loop guarantee broken for {root_hex}: {total} != {target}"
    assert all(t > 0 for _, t, _ in notes), f"zero-length note for {root_hex}"

    onsets = []
    pos = 0
    for name, ticks, _tr in notes:
        onsets.append({
            "tick": pos,
            "durationTicks": ticks,
            "soundingTicks": int(ticks * m.DUTY_CYCLE),  # §7.3 floor
        })
        pos += ticks

    return {
        "root": root_hex,
        "barCount": bars,
        "firstTwoBits": bits,
        "targetTicks": target,
        "notes": [
            {"name": n, "ticks": t, "truncated": bool(tr)} for n, t, tr in notes
        ],
        "onsets": onsets,
        "sumTicks": total,
        "noteCount": len(notes),
        "wrapped": len(notes) > len(leaves),
    }


def scan(predicate, label, max_iter=200000):
    """Deterministic seed search for an interesting root."""
    for i in range(max_iter):
        root = hashlib.sha256(f"m2m-fixture:{label}:{i}".encode()).hexdigest()
        if predicate(root):
            return root
    raise RuntimeError(f"scan for '{label}' exhausted {max_iter} seeds")


def sum32(root_hex):
    return sum(t for _, t in map(m.leaf_to_duration, m.derive_leaves(root_hex)))


def exact_fill_before_end(root_hex, target):
    acc = 0
    for i, (_n, t) in enumerate(map(m.leaf_to_duration, m.derive_leaves(root_hex))):
        acc += t
        if acc == target:
            return i < 31  # exact hit with leaves remaining
        if acc > target:
            return False
    return False


def main():
    DEFAULT = "2e0f4eb72a525d443b731dce006d728a2f3575768a9e475fc1b4c66016475600"
    WRAPPED8 = "c0" + "0" * 60 + "01"  # e2e root from §7.4 resolution

    fixtures = []

    # 1-bar default root
    fixtures.append(derive(DEFAULT))
    fixtures[-1]["label"] = "default-1bar"

    # 8-bar with cyclic reuse (wrapped): sum32 < 15360
    assert sum32(WRAPPED8) < 15360
    fixtures.append(derive(WRAPPED8))
    fixtures[-1]["label"] = "wrapped-8bar"
    assert fixtures[-1]["wrapped"]

    # 8-bar that fills within 32 leaves (truncation, no wrap)
    r = scan(lambda x: x[:2] >= "c0" and sum32(x) >= 15360, "trunc8")
    fixtures.append(derive(r))
    fixtures[-1]["label"] = "truncating-8bar"
    assert not fixtures[-1]["wrapped"]

    # 2-bar exact-fill-before-exhaustion edge (protocol §7.4 exact rule)
    def exact2(x):
        return "40" <= x[:2] < "80" and exact_fill_before_end(x, 3840)
    r = scan(exact2, "exact2", 500000)
    fixtures.append(derive(r))
    fixtures[-1]["label"] = "exact-fill-2bar"
    assert fixtures[-1]["notes"][-1]["truncated"] is False

    # plain 4-bar and 2-bar
    r = scan(lambda x: "80" <= x[:2] < "c0", "plain4")
    fixtures.append(derive(r))
    fixtures[-1]["label"] = "plain-4bar"
    r = scan(lambda x: "40" <= x[:2] < "80", "plain2")
    fixtures.append(derive(r))
    fixtures[-1]["label"] = "plain-2bar"

    # full-conformance SMF byte reference for the wrapped root (via generate_midi)
    leaves = m.derive_leaves(WRAPPED8)
    durations = [m.leaf_to_duration(l) for l in leaves]
    notes = m.fill_rhythm_to_target(durations, 15360)
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "ref.mid"
        with contextlib.redirect_stdout(io.StringIO()):
            m.generate_midi(notes, str(p))
        smf_hex = p.read_bytes().hex()
    for f in fixtures:
        if f["label"] == "wrapped-8bar":
            f["smfHex"] = smf_hex

    # ── M2M-NOTES layer: deterministic melody + mapped-export reference ──
    for f in fixtures:
        lv = nm.derive_leaves(f["root"])
        pbs = [nm.leaf_to_pitch_byte(l) for l in lv]        # disjoint bits 11-18
        sp = nm.derive_scale_params(f["root"])
        mel = [nm.scale_degree_to_midi(pb % sp["scale_size"], sp) for pb in pbs]
        assert all(21 <= x <= 108 for x in mel), f"pitch out of range {f['label']}"
        f["melody"] = {
            "scale": {
                "modeIndex": sp["mode_index"], "modeName": sp["mode_name"],
                "rootNoteIndex": sp["root_note_index"], "rootNoteName": sp["root_note_name"],
                "baseOctave": sp["base_octave"], "octaveRange": sp["octave_range"],
                "scaleSize": sp["scale_size"],
            },
            "pitchBytes": pbs,
            "melody32": mel,
        }

    # mapped SMF bytes (notes-pipeline generate_midi) for the wrapped root
    wf = next(f for f in fixtures if f["label"] == "wrapped-8bar")
    mel32 = wf["melody"]["melody32"]
    notes4 = [(name, ticks, tr, mel32[i % 32])
              for i, (name, ticks, tr) in
              enumerate((n["name"], n["ticks"], n["truncated"]) for n in wf["notes"])]
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "ref_notes.mid"
        with contextlib.redirect_stdout(io.StringIO()):
            nm.generate_midi(notes4, str(p))
        wf["smfMappedHex"] = p.read_bytes().hex()

    out = HERE / "tests" / "fixtures.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps({
        "protocol": "M2M-RHYTHM/1.0.2",
        "notesProtocol": "M2M-NOTES/2.1.0",
        "fixtures": fixtures,
    }, indent=1) + "\n")

    print(f"wrote {out.relative_to(HERE)}")
    for f in fixtures:
        print(f"  {f['label']:20} {f['barCount']} bars  "
              f"{f['noteCount']:>3} notes  target={f['targetTicks']}"
              + ("  [wrapped]" if f["wrapped"] else "")
              + ("  [smf ref]" if "smfHex" in f else ""))


if __name__ == "__main__":
    main()
