# Posse Windows Installer

PowerShell counterpart of the Linux installer: the same lifecycle, summary
contract, and idempotent repair behavior, plus a Windows-specific C++ Build
Tools decision during bootstrap.

ATLAS is built into Posse — there is no separate ATLAS checkout, build, or
server process. ATLAS runtime configuration lives in `~\.posse\account.db`
(managed through `posse admin`), not environment variables.

## Design

- **Never dies mid-run.** Every step is fenced: failures are recorded, the
  installer keeps going where it can, steps that depend on a failed step are
  marked `blocked`, and the summary always prints.
- **Idempotent.** Re-running is safe; fresh steps are skipped. `-Force`
  reinstalls npm deps, `-DryRun` previews everything.
- **PS 5.1 and 7+ safe.** Native executables run directly with redirected
  output (batch launchers use a minimal `cmd.exe` wrapper), so stderr cannot surface as a
  terminating `NativeCommandError` (the classic Windows PowerShell 5.1
  failure mode of the old installer).
- **Self-sufficient.** Installs Git, host helper CLIs, and a Node 24+-capable
  distribution via winget when missing
  (`-NoInstallNode` opts out) and refreshes `PATH` from the registry after
  winget installs so new tools are visible without a new terminal.
- **Observable.** A splash, numbered steps (`[ 3/16]`), a spinner with
  elapsed time on capable terminals (Windows Terminal / PS 7+), and full
  command output captured to
  `%USERPROFILE%\.posse\logs\install-<timestamp>.log` (failures print the
  output tail inline).

## What It Does (steps)

1. **SCIP language selection** — validates `-ScipLanguages` or offers the
   interactive default selection when input is available.
2. **Preflight checks** — validates the optional smoke-test repo and reports
   provider credential / Git identity gaps.
3. **System packages** — installs missing Git and helper CLIs via winget: ripgrep,
   Tesseract OCR, ImageMagick, FFmpeg, Python 3, PHP. Each tool tries its
   winget id candidates independently, so one failure can't sink the rest.
   Tesseract's install dir is probed and added to `PATH` when its installer
   doesn't do so.
4. **C++ Build Tools** — detects an existing MSVC C++ workload. When it is
   missing and input is interactive, explains the several-GB/UAC/reboot impact
   and asks whether Posse should install Visual Studio Build Tools with the
   Desktop development with C++ workload. A yes answer is handled automatically
   through winget; no or non-interactive input continues with a clear warning.
5. **Node.js runtime** — accepts an existing Node ≥ 24; otherwise tries the
   winget Node distributions and verifies the installed major before continuing.
   Node 24 is a minimum, not an exact-version pin; newer majors are accepted.
6. **Posse checkout** — uses the checkout containing this installer when
   available; cloning is only a fallback for standalone use.
7. **Composer (SCIP PHP)** — uses a global `composer` when present; otherwise
   downloads a signature-verified `composer.phar` into Posse's `scip\bin`
   (skipped when PHP is absent).
8. **npm dependencies** — `npm install --include=optional` (skipped when
   `node_modules` is fresh; one automatic retry). If the user declined Build
   Tools and the log shows node-gyp/MSBuild errors, re-run and accept the prompt.
9. **Shell wiring** — writes `%USERPROFILE%\.config\posse\atlas.env.ps1`,
   installs a UTF-8 `posse.cmd` shim in `%USERPROFILE%\.local\bin`, and puts
   that directory on the user `PATH`. Profile sourcing is added only when the
   effective PowerShell execution policy can run it.
10. **Account settings** — seeds missing ATLAS keys into `~\.posse\account.db`
   (merge-only; existing values are never overwritten).
11. **Runtime doctor** — runs `posse doctor`, Posse's own dependency engine,
   which builds the managed Python venv from `requirements.txt` and installs
   the SCIP language environments (replaces the old standalone
   `pip install --user` and inline SCIP steps).
12. **Provider CLI detection** — `posse admin init --non-interactive`.
13. **Provider API keys** — only with `-ConfigureKeys`: hidden SecureString
    prompts for `POSSE_KEY` / `OPENAI_API_KEY` / `XAI_API_KEY` /
    `CODEX_API_KEY`, written to
    `%USERPROFILE%\.config\posse\providers.env.ps1` with an NTFS ACL locked
    to the current user, plus optional `claude` / `codex login` launches.
14. **Native binaries** — downloads the current authenticated `posse-atlas`,
    `posse-git`, `posse-remote`, and `posse-vector` artifacts for the host
    platform. Existing verified versions are reused. Without `POSSE_KEY`, the
    step reports a warning and boot readiness retries later.
15. **Validation** — boots Posse (`node orchestrator.js status`) with a
    five-minute timeout.
16. **ATLAS smoke test** — only with `-RepoPath`.

## Prereqs

- PowerShell 5.1 (ships with Windows) or PowerShell 7+.
- `winget` (App Installer from the Microsoft Store) so the installer can
  fetch Git, Node, and host tools automatically. Without it, missing tools are
  reported and everything else still runs.
- `git` for the clone fallback; the packages step installs it through winget
  when possible.

## Run

```powershell
cd <posse-dir>\installers\windows
powershell -ExecutionPolicy Bypass -File .\install-posse-atlas.ps1
```

With a smoke test against a repo:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-posse-atlas.ps1 `
  -RepoPath C:\repos\your-target-repo
```

> **Execution policy.** If PowerShell blocks the script, either set
> `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once, or invoke with
> `-ExecutionPolicy Bypass` as shown above.

## Flags

| Flag | Purpose |
|------|---------|
| `-InstallRoot <path>` | Base directory for installs (default: `$env:USERPROFILE\claude-tools`) |
| `-PosseDir <path>` | Posse checkout directory (default: installer checkout, else `<InstallRoot>\posse`) |
| `-PosseRepoUrl <url>` | Fallback Git URL when no checkout is detected |
| `-RepoId <id>` | ATLAS repo id for the smoke test |
| `-RepoPath <path>` | ATLAS repo path for the smoke test |
| `-SmokeQuery <q>` | Query used for atlas-smoke (default: `auth`) |
| `-SmokeProvider <p>` | Provider for atlas-smoke (default: `openai`) |
| `-ScipLanguages <csv>` | Initial SCIP languages to install/index: `typescript`, `python`, `php`, `go`, `rust`, `clang`, or `all`. Omit for an interactive multi-select prompt. |
| `-NoSmoke` | Skip the smoke test |
| `-NoPersistEnv` | Don't write user `PATH` / `$PROFILE` wiring |
| `-SkipSettings` | Don't seed `~\.posse\account.db` |
| `-SkipHostTools` | Don't install helper CLIs or offer the C++ Build Tools install (missing tools are still reported) |
| `-NoInstallNode` | Don't auto-install Node via winget when Node 24+ is missing |
| `-ConfigureKeys` | Prompt for provider API keys (SecureString input, user-only ACL file) |
| `-Force` | Re-run `npm install` even when `node_modules` looks fresh |
| `-DryRun` | Print what would happen; make no changes |
| `-Plain` | Disable colors, splash gradient, and spinners (also honors `NO_COLOR`) |

## Re-running and troubleshooting

- The summary marks each step `ok`, `skipped`, `partial`, `failed`,
  `blocked`, or `dry-run`, with warnings listed underneath and the log path
  at the end.
- Every command's output lands in
  `%USERPROFILE%\.posse\logs\install-<timestamp>.log`; a failing step prints
  its last lines inline.
- Tools installed by winget sometimes need a new terminal before they're
  visible; the installer refreshes `PATH` from the registry to minimize this
  and says so when a tool still isn't visible.
- If the doctor step is `partial`, run `posse doctor` after fixing the tools
  it names; it repairs incrementally.
- `atlas.env.ps1` is rewritten each run. `providers.env.ps1` is **only**
  touched when `-ConfigureKeys` is passed, and only the keys you enter are
  updated — other lines are preserved. Account settings are merged, never
  overwritten.

## Provider API keys

With `-ConfigureKeys`, the installer prompts (hidden via
`Read-Host -AsSecureString`) for:

| Var | Purpose |
|-----|---------|
| `POSSE_KEY` | Posse remote prompt/tool catalog and native artifact API key |
| `OPENAI_API_KEY` | OpenAI provider |
| `XAI_API_KEY` | Grok (xAI) provider |
| `CODEX_API_KEY` | Codex API-key auth (optional — the `codex` CLI can also use `~\.codex\auth.json` from `codex login`) |

- Any var already set in your environment is detected and skipped; empty
  input skips the prompt.
- Values are stored **plaintext** in
  `%USERPROFILE%\.config\posse\providers.env.ps1`. The installer applies an
  NTFS ACL granting only the current Windows user access (inheritance
  disabled) — the strongest protection available without DPAPI/Credential
  Manager integration.
- Claude and Codex CLI logins can't be fully scripted — after the key
  prompts, the installer offers to launch `claude` and/or `codex login`.

If you prefer to manage keys yourself, omit `-ConfigureKeys` and set them
with `setx`, 1Password CLI, or however you already manage secrets. The
installer only detects and warns in that mode.

## Parity with the Linux script

Both installers expose the same lifecycle and failure-summary contract. Windows
adds the interactive C++ Build Tools decision and uses winget instead of distro
package managers + nvm,
`atlas.env.ps1` / conditional `$PROFILE` wiring instead of `atlas.env` /
`.bashrc`, a policy-independent `posse.cmd` shim instead of a bash shim, and
NTFS ACLs instead of `chmod 600`.
