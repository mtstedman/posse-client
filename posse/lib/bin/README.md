# Posse Native Binaries

This directory stages the native binaries Posse ships. The Rust helper binaries
(`posse-atlas`, `posse-git`, `posse-remote`, and the opt-in `posse-vector`)
are runtime-managed tools. The
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
  remote/
    windows/{x64,arm64}/posse-remote.exe
    linux/{x64,arm64}/posse-remote
    macos/posse-remote           # universal
  vector/
    windows/{x64,arm64}/posse-vector.exe
    linux/{x64,arm64}/posse-vector
    macos/posse-vector           # universal
  bossy/
    windows/{x64,arm64}/bossy.exe
    linux/{x64,arm64}/bossy
    macos/bossy                  # universal in CI
```

The runtime resolver selects `<tool>/<os>/<arch>/<file>` for the host, falling
back to `<tool>/<os>/<file>` (the universal-macOS location). os/arch are mapped
from `process.platform` / `process.arch` by
[`lib/shared/platform/functions/native-platform.js`](../shared/platform/functions/native-platform.js).

## Build & deploy

Rebuild atlas/git/remote from the sibling `posse-encoder-rust` workspace
(flush + cargo build + deploy) for the current host OS:

```bash
npm run rebuild:rust-binaries -- --rust-root <path-to-posse-encoder-rust>
```

Use the all-platform wrapper when the machine has working cross-build
toolchains. The macOS entry is built for both `aarch64-apple-darwin` and
`x86_64-apple-darwin` and combined with `lipo`.

```bash
npm run rebuild:rust-binaries:all -- --rust-root <path-to-posse-encoder-rust>
```

`posse-vector` is intentionally excluded from those build defaults because it
comes from the separate `posse-vector` workspace. An explicitly staged
`lib/bin/vector/...` build remains the development override. When native vector
mode is enabled and no staged build exists, run boot mints an
`artifacts:read` pulse, downloads the exact catalog-pinned version for the
current OS/architecture from Posse Remote, verifies its SHA-256, and caches it
under `~/.posse/native/bundles/posse-vector-<version>/vector/...` before ATLAS
opens embedding resources.

The cache stores a SHA-256 sidecar and is re-verified on every process boot.
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
the sibling `posse-encoder-rust` workspace.

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
