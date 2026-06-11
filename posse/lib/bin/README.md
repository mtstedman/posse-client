# Posse Native Binaries

This directory stages the compiled Rust helper binaries Posse ships
(`posse-atlas`, `posse-git`, `posse-remote`). The registry that describes them — package names,
per-OS/arch build targets, and filenames — lives in the catalog at
[`lib/catalog/binary.js`](../catalog/binary.js), the single source of truth for
both the deploy scripts and the runtime resolver
([`lib/classes/tools/BinaryManager.js`](../classes/tools/BinaryManager.js)).

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
```

The runtime resolver selects `<tool>/<os>/<arch>/<file>` for the host, falling
back to `<tool>/<os>/<file>` (the universal-macOS location). os/arch are mapped
from `process.platform` / `process.arch` by
[`lib/shared/platform/functions/native-platform.js`](../shared/platform/functions/native-platform.js).

## Build & deploy

Rebuild from the sibling `posse-encoder-rust` workspace (flush + cargo build +
deploy) for the current host OS:

```bash
npm run rebuild:rust-binaries -- --rust-root <path-to-posse-encoder-rust>
```

Use the all-platform wrapper when the machine has working cross-build
toolchains. The macOS entry is built for both `aarch64-apple-darwin` and
`x86_64-apple-darwin` and combined with `lipo`.

```bash
npm run rebuild:rust-binaries:all -- --rust-root <path-to-posse-encoder-rust>
```

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
