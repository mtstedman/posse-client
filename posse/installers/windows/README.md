# Install Posse on Windows

Start with [access, keys, requirements, and first-task usage](../README.md).
Use a normal, **non-Administrator** PowerShell window. PowerShell 5.1 and 7+
are supported. Node.js 24+ and npm are installed automatically when missing or
unusable; winget is no longer required for Node installation.

## Install

From an existing public client checkout:

```powershell
cd posse-client\posse
powershell -NoProfile -ExecutionPolicy Bypass -File .\installers\windows\install-posse-atlas.ps1
```

On a new machine, download the standalone installer:

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -UseBasicParsing `
  -Uri 'https://raw.githubusercontent.com/mtstedman/posse-client/main/posse/installers/windows/install-posse-atlas.ps1' `
  -OutFile .\install-posse-atlas.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-posse-atlas.ps1
```

> **Scripts are disabled?** Run the `powershell -NoProfile -ExecutionPolicy Bypass
> -File ...` command above from PowerShell or Command Prompt. Its policy option
> applies to that new PowerShell process; it does not permanently relax your
> account or machine policy. A company Group Policy can override it.
>
> **Downloaded file blocked?** After checking that you downloaded the trusted
> installer, run `Unblock-File .\install-posse-atlas.ps1` in PowerShell and retry.
> This removes the downloaded-file marker; it does not override execution policy.
>
> **Still blocked by your organization?** Run `Get-ExecutionPolicy -List` and
> share the policy/error with your administrator. Do not change machine-wide
> policy just to install Posse. `RemoteSigned` also permits local unsigned
> scripts; a downloaded unsigned installer may still need `Unblock-File`.
>
> **Command not found after install?** Open a new terminal. Existing terminals
> and VS Code processes may retain their old PATH. You can always invoke the
> generated `posse.cmd` by its full path below.

See [Microsoft’s execution-policy reference](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_execution_policies) for policy precedence.

Choose indexing languages (default: TypeScript/JavaScript and Python). When
prompted, paste your **POSSE_KEY** and press Enter. Input is hidden. The key is
saved to `%USERPROFILE%\.config\posse\.env` with a restricted NTFS ACL. Posse
loads it directly on future launches, including launches from Command Prompt,
VS Code, and scheduled processes running as the same user.

To enter or change provider keys too:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-posse-atlas.ps1 -ConfigureKeys
```

New installs store keys only in `.env`. If an older installer left a
`providers.env.ps1` (dot-sourced by your PowerShell profile) or a `POSSE_KEY`
user-environment entry, the installer updates those on rotation so they cannot
shadow the new key, but it no longer creates them. Parent process environment
values take precedence over the private `.env`, so restart old terminals after
rotating a key if they still hold an older value. Rerunning the installer
against an older checkout that lacks `installers\installer-env.mjs` stops at
the keys step with an update instruction.

Open a new terminal after installation:

```powershell
cd C:\repos\your-project
posse doctor
posse admin
posse add "Describe a small first task"
posse go
```

The installer creates a per-user Scheduled Task for the automation owner, so
approved schedules resume after sign-in. Check it with
`posse automation service status`.

If PATH has not refreshed, invoke
`& "$env:USERPROFILE\.local\bin\posse.cmd" help` directly.

## Node and other prerequisites

The installer first accepts a working Node 24+ installation with npm. If
needed, it tries winget's Node distributions, then falls back to an official
Node ZIP in `%LOCALAPPDATA%\Posse\runtimes`. The ZIP is checked against Node's
published SHA-256 checksum before extraction and use. The fallback does not
require administrator privileges and is reused on later installer runs.
The generated launcher puts its Node directory on PATH for subprocesses.

Git, Python, ripgrep, Tesseract, ImageMagick, and FFmpeg still use winget when
missing. Install **App Installer** to provide winget, or provision these tools
manually if your Windows edition/environment does not include it. Node
fallback alone does not install Git or Python. PHP/Composer are opt-in through
`-ScipLanguages php` (or `all`).

A writable checkout is required. The installer uses its own checkout when
writable, otherwise clones into a user-owned directory. An explicit read-only
`-PosseDir` fails with a remedy. Native binaries, managed Python/SCIP tools,
and generated state live under `%LOCALAPPDATA%\Posse`.

## Unattended setup

Inject `POSSE_KEY` and provider keys through the process environment, then run:

```powershell
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File .\install-posse-atlas.ps1 -NonInteractive -ScipLanguages typescript,python
```

Injected environment keys are not copied into `.env`. Use `-SetupOnly` to
install the core checkout, npm dependencies, and command while deferring
account settings, keys, authenticated downloads, doctor, and validation.
Rerun without `-SetupOnly` as the intended runtime user when credentials are
available. Windows containers are not covered by the Linux container recipe;
they also need compatible Windows images and host prerequisites.

## Options

| Option | Purpose |
|---|---|
| `-ConfigureKeys` | Enter/change provider keys; Enter keeps stored values |
| `-NonInteractive` | Disable prompts; supply environment variables or saved keys |
| `-SetupOnly` | Install core files, defer account/runtime setup and validation |
| `-ScipLanguages <csv>` | `typescript,python,php,go,rust,clang`, or `all` |
| `-PosseDir <path>` | Use/create this writable checkout; nested `posse\` detected |
| `-InstallRoot <path>` | Fallback clone base; default `%USERPROFILE%\claude-tools` |
| `-PosseRepoUrl <url>` | Override fallback public Git URL |
| `-SkipHostTools` | Skip missing host-tool installation; still provision Node |
| `-NoInstallNode` | Require working Node 24+ with npm |
| `-NoPersistEnv` | Skip persistent PATH/profile edits; still write the command shim |
| `-SkipSettings` | Skip seeding account settings |
| `-Force` | Reinstall npm dependencies |
| `-RepoPath <path>` | Run ATLAS smoke testing against this project |
| `-RepoId <id>` | Optional smoke-test repository identifier |
| `-SmokeQuery <text>` | Smoke query; default `auth` |
| `-SmokeProvider <name>` | Smoke provider; default `openai` |
| `-NoSmoke` | Skip smoke testing |
| `-CommandTimeoutSeconds <seconds>` | Command limit, default 1800; range 60–86400 |
| `-DoctorTimeoutSeconds <seconds>` | Doctor limit, default 7500; range 60–86400 |
| `-DryRun` | Preview without installing; a diagnostic log is still written |
| `-Plain` | Disable colors and spinners |

## Troubleshooting

Logs: `%USERPROFILE%\.posse\logs\install-<timestamp>.log`. Failed commands
print their last output and the full log path. Rerun after correcting the
reported issue; existing usable installations are reused.

| Symptom | Action |
|---|---|
| winget absent | Node uses the ZIP fallback; provision Git/Python/helper tools manually or install App Installer |
| Node checksum/download failure | Fix HTTPS/proxy access to nodejs.org; rerun. Failed archives are not installed |
| Administrator-profile error | Rerun in a normal PowerShell window under the account that will use Posse |
| PowerShell blocks the script | Use the invocation above; organization-enforced policies may require your administrator's help |
| SQLite `.node` sharing violation | Close other Posse processes using this installation, then rerun installer or doctor |
| Known valid key reports `invalid posse_key` | Check key status and synchronize Windows time; native heartbeat tokens tolerate only a small clock difference |
| Missing native binaries/model | Confirm POSSE_KEY/network/disk access and run `posse doctor` |
| Dependency boot guard fails | Doctor attempted repair; resolve its reported requirement and retry before running jobs |

Keys are plaintext with restricted access, not encrypted. Keep `.env` and the
legacy provider files private. Installer reconfiguration repairs file ACLs;
secrets are written to a restricted temporary file before replacing the old file.
