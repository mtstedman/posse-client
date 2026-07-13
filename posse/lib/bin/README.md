# Posse Native Binaries

This directory can stage local development overrides for the native binaries Posse uses. The Rust helper binaries
(`posse-atlas`, `posse-git`, `posse-ml`, `posse-remote`, and the opt-in
`posse-atlas-vector`)
are remotely built, runtime-managed tools; their binary payloads are ignored by
Git. The
registry that describes them — package names, per-OS/arch build targets, and
filenames — lives in the catalog at
[`lib/catalog/binary.js`](../catalog/binary.js), the single source of truth for
both the deploy scripts and the runtime resolver
([`lib/shared/tools/classes/BinaryManager.js`](../shared/tools/classes/BinaryManager.js)).

Bossy is a standalone fleet TUI rather than a runtime helper. Its own
green-gated deployment workflow stages release builds under `lib/bin/bossy/`;
it is intentionally not registered in the helper-binary catalog.

## Layout

Windows and Linux ship a build per architecture; macOS ships a single lipo'd
universal binary at the OS level.

```text
lib/bin/
  atlas/
    windows/x64/posse-atlas.exe
    windows/arm64/posse-atlas.exe
    linux/x64/posse-atlas
    linux/arm64/posse-atlas
    macos/posse-atlas            # universal (x64 + arm64)
  git/
    windows/{x64,arm64}/posse-git.exe
    linux/{x64,arm64}/posse-git
    macos/posse-git              # universal
  ml/
    windows/{x64,arm64}/posse-ml.exe
    linux/{x64,arm64}/posse-ml
    macos/posse-ml               # universal
  remote/
    windows/{x64,arm64}/posse-remote.exe
    linux/{x64,arm64}/posse-remote
    macos/posse-remote           # universal
  vector/
    windows/{x64,arm64}/posse-atlas-vector.exe
    linux/{x64,arm64}/posse-atlas-vector
    macos/posse-atlas-vector     # universal
  bossy/
    windows/{x64,arm64}/bossy.exe
    linux/{x64,arm64}/bossy
    macos/bossy                  # universal in CI
```

The runtime resolver selects `<tool>/<os>/<arch>/<file>` for the host, falling
back to `<tool>/<os>/<file>` (the universal-macOS location). os/arch are mapped
from `process.platform` / `process.arch` by
[`lib/shared/platform/functions/native-platform.js`](../shared/platform/functions/native-platform.js).

## Pull, build, and deploy

Pull every server-issued binary for the current OS and architecture into the
verified, versioned native bin directory inside this Posse installation:

```bash
npm run pull:native
```

The command mints an `artifacts:read` pulse, selects the exact package versions
issued by the server, verifies each SHA-256, and reuses a valid cached artifact.
Normal `posse run` boot performs the same check for every enabled binary, so the
explicit pull is primarily useful for prefetching or diagnosing artifact access.
Boot is the automatic update boundary: once a run accepts a valid artifact, the
process keeps that version for the rest of the run. Ordinary runtime availability
checks may recover a missing or invalid binary, but they do not refresh issued
versions or replace a valid live handle mid-run.

Rebuild native binaries from the sibling `posse-bin` workspace
(flush + cargo build + deploy) for the current host OS:

```bash
npm run rebuild:rust-binaries -- --rust-root <path-to-posse-bin>
```

Build each platform on its matching host. Windows uses the MSVC x64 and ARM64
targets; Linux uses GNU x64 and ARM64 targets. The macOS entry is built for
both Darwin architectures and combined with `lipo`.

Windows ARM64 builds require the Visual Studio ARM64 C++ tools plus
`rustup target add aarch64-pc-windows-msvc`. Linux ARM64 builds require the
`aarch64-linux-gnu-g++` cross toolchain configured by `posse-bin/.cargo/config.toml`.

```bash
npm run rebuild:rust-binaries -- --platform current --rust-root <path-to-posse-bin>
```

`posse-atlas-vector` is also owned by the consolidated workspace. An explicitly staged
`lib/bin/<tool>/...` build remains a development override for every tool. Run
boot otherwise mints an `artifacts:read` pulse, reads each current package
version signed into that pulse, downloads the exact current OS/architecture
artifact from Posse Remote, verifies its SHA-256, and caches it under
`lib/bin/<package>/<version>/<os>/<arch>/<file>` in the Posse installation.
Package names come only from `lib/catalog/binary.js`; for example, vector is
always `lib/bin/posse-atlas-vector/<version>/...`, never `lib/bin/vector/...`.
Each package keeps its independently issued versions in its own directory.

An explicitly staged build is accepted only when its reported version matches
the server-issued version. The cache stores a SHA-256 sidecar and is re-verified on every process boot.
Downloads use a same-directory `.part` file, fsync, and atomic rename; a
checksum mismatch never becomes runnable. The raw `POSSE_KEY` is used only by
the existing heartbeat broker and is never sent to the artifact endpoint or
written to disk.

If the binaries were already built elsewhere, deploy existing artifacts:

```bash
npm run deploy:rust-binaries -- --artifact-root <path-to-rust-target>
npm run deploy:rust-binaries:all -- --artifact-root <path-to-rust-target>
```

Run with `--dry-run` first to see the planned actions.

## Runtime usage

Call sites invoke Rust-owned methods through a small domain wrapper. For ATLAS,
the migration rule is strict: mirror the Node function in Rust, A/B test against
the Node oracle until parity is exact, switch the production call to
`posse-atlas`, and delete the replaced Node implementation in the same change.
Do not add a long-lived JS fallback after a function has migrated.

```js
import { runAtlasNativeMethod } from "../domains/atlas/functions/v2/native/invoke.js";

const data = runAtlasNativeMethod("parser.parseBuffer", {
  repo_rel_path,
  lang,
  content_hash,
  bytes_base64,
});
```

Git and ATLAS are fully cut over: the native binary is the only
implementation path, hardwired on in `BinaryManager` — no setting or env
override can disable it, and there is no JS fallback. Tools still
mid-migration are gated per tool with `posse_native_<tool>` settings, or at
runtime with the `POSSE_NATIVE_BINARIES` (master) / `POSSE_NATIVE_<TOOL>`
env overrides. `POSSE_NATIVE_BIN_ROOT` overrides the staging root (used in tests).

## Worker host protocol — supervision ops (`posse.daemon.v1`)

The persistent `worker --stdio` hosts speak newline-delimited JSON envelopes.
The Node side (`Daemon` + `DaemonSupervisor`) layers a recovery ladder on top —
request abandon, liveness probe, graceful retire, circuit breaker — and asks
hosts to implement these protocol-level supervision ops so recovery rarely
needs process replacement at all. Until a host ships them, the Node side
degrades gracefully (see "compatibility" notes). Rust implementation lives in
the sibling `posse-bin` workspace.

All ops use `protocol: "posse.daemon.v1"` and the standard envelope:
`{ protocol, method, payload, id }` in → `{ id, ok, data | error }` out.

- `daemon.ping` → `{ ok: true, data: { uptime_ms, inflight, version } }`.
  Liveness probe with a short client deadline (~250ms). **Compatibility:** the
  Node prober treats ANY reply — including `{ ok: false, error: "unknown
  method" }` from an older host — as proof the request loop is alive; only
  silence past the deadline marks the host wedged. So shipping a real handler
  upgrades diagnostics but is not required for the probe to work.
- `daemon.shutdown` → drain in-flight requests, flush, `exit 0`. Hosts MUST
  also treat **EOF on stdin** as the same drain-and-exit signal — that is what
  the Node `retire(graceMs)` path sends today, with a hard kill only after the
  grace window. Never rely on the parent to kill you; exiting on EOF is what
  makes graceful replacement and clean shutdown possible.
- `daemon.reload` → re-read configuration/auth in place (for the ONNX encoder:
  swap models) and reply `{ ok: true }`. Lets an identity/key change become a
  protocol message instead of a process replacement. **Compatibility:** the
  Node side capability-detects via `daemon.ping`'s `version` and falls back to
  replace when absent.
- **Internal watchdog:** the host owns deadlines for its own subprocess work
  (e.g. a runaway `git` invocation): kill the child, reply with a structured
  `{ ok: false, error: { code: "GIT_TIMEOUT", ... } }`, and stay alive. A slow
  request must never become a dead host.
- **Busy heartbeat (optional):** while a request runs long, the host may emit
  `{ heartbeat: true }` lines (no `id`); the Node line parser ignores unknown
  shapes today, and future clients can use them to distinguish busy from hung.
