# ATLAS v2 corpus

Small multi-language fixture used by `test-atlas-v2-corpus.test.js` to
exercise the full retrieval surface and lock down v2 output via
snapshots.

## Layout

- `src/greeter.ts` — TS class with inheritance + method
- `src/runner.ts` — TS function calling into greeter
- `src/util.py` — Python module exercising the python extractor
- `src/lib.rs` — Rust trait + struct + impl
- `src/Main.java` — Java class with imports
- `src/main.go` — Go package
- `cmd/script.sh` — Shell script with source includes

## Snapshot semantics

`test-atlas-v2-corpus.test.js` runs `dispatch()` for every action in
`ATLAS_TOOL_ACTIONS` against a freshly-built view of this corpus and
compares each result against `snapshots/<action>.json`. The snapshot
files are committed; the test fails on drift unless `UPDATE_ATLAS_SNAPSHOTS=1`
is set, which rewrites them in place.

These snapshots are the native v2 self-consistency baseline for the
in-tree ledger/view backend.
