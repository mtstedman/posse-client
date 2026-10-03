# Install Posse on Windows

Start with [access, keys, requirements, and first-task usage](../README.md).
Use a normal, **non-Administrator** PowerShell window. PowerShell 5.1 and 7+
are supported. Node.js 24+ and npm are installed automatically when missing or
unusable; winget is no longer required for Node installation.

## Install with Posse Setup (recommended)

Download **PosseSetup.exe** from the
[latest Posse release](https://github.com/mtstedman/posse-client/releases/latest)
and double-click it. Do not use "Run as administrator"; Posse installs into
your own account. The wizard:

1. asks for your **POSSE_KEY**, unless one is already saved: in your user or
   system environment variables, `.config\posse\.env`, or an older installer's
   `providers.env.ps1`,
2. asks which languages your projects use and installs each one's toolchain
   (see [Language toolchains](#language-toolchains)), and whether to add the
   optional media tools (Tesseract OCR, ImageMagick, FFmpeg) that Posse's OCR
   and image/video conversion use,
3. installs Git, Node.js, and Posse into `%LOCALAPPDATA%\Programs\Posse`,
   wires the `posse` command, and runs `posse doctor`. One bar shows overall
   progress and a second shows the item being installed right now (real
   percentages for downloads); full detail goes to the log, and **Open log**
   appears when something needs a look,
4. offers a desktop shortcut. The **Posse** shortcuts open Bossy, the fleet
   view (`posse --bossy`); **Posse Terminal** in the Start menu opens
   PowerShell ready for `posse` commands.

Posse appears in **Settings > Apps > Installed apps**. Uninstall it there; the
uninstaller removes the `posse` command, its PATH entry, profile lines,
shortcuts, and the automation startup task, and optionally your settings, saved
keys, and downloaded runtimes. Your projects are never touched.

Release builds are code-signed through Azure Artifact Signing, so Windows names
the verified publisher. A brand-new release can still get a SmartScreen "protected
your PC" notice until it builds download reputation; choose **More info**, check
the publisher, then **Run anyway**. (Maintainers: build signed packages with
`node scripts/package-windows-installer.mjs --sign`; settings live in
`~/.config/posse/signing.env`, see `scripts/sign-windows-artifact.mjs`.)

Unattended installs: `PosseSetup.exe /S [/LANGUAGES=typescript,python,go] [/MEDIATOOLS] [/DESKTOPSHORTCUT]`
with `POSSE_KEY` in the environment or already saved. Unattended uninstall:
`"%LOCALAPPDATA%\Programs\Posse\uninstall.exe" /S [/REMOVEDATA]`.

Run Posse Setup again to repair an install. To add a language later, turn it
on in `posse admin`, then run setup again to install its tools.
`posse update` keeps Posse itself current.

## Install from a script

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

## Language toolchains

Each selected indexing language gets the toolchain `posse doctor` needs:

| Language | Installed when missing |
|---|---|
| TypeScript / JavaScript | Node.js (always installed) |
| Python | Python 3 (winget) |
| PHP | PHP (winget) and Composer; enables PHP's OpenSSL, cURL, and ZIP extensions |
| Go | Go from the official go.dev zip, checked against its published SHA-256 and installed per user (no approval prompt). An existing Go must be 1.21+ |
| Rust | Rust via rustup with the GNU toolchain and rust-analyzer; the download is checked against its published SHA-256 before it runs |
| C / C++ | Not available on Windows (no Windows build of scip-clang) |

Before installing anything, the installer looks for an existing copy: on PATH,
in Windows' installed-apps list and App Paths, in Python's and Git's registry
entries, in Scoop, Chocolatey, and winget folders, and in each tool's usual
install folder (for PHP also XAMPP and Laragon). A copy that runs and meets
Posse's minimum version (PHP 8.2, Go 1.21, Python 3.9, ImageMagick 7) counts
as installed; if it is missing from PATH it is added to your user PATH instead
of being reinstalled. Only missing or too-old tools are installed. After installing, every tool is checked
against the **saved** user/machine PATH that a new terminal uses, not just the
installer's own session, and repaired there when needed. PHP's real folder is
placed ahead of winget's `Links` alias, because PHP looks for `php.ini` and its
extensions beside the file it was started from.

## Node and other prerequisites

The installer first accepts a working Node 24+ installation with npm. If
needed, it tries winget's Node distributions, then falls back to an official
Node ZIP in `%LOCALAPPDATA%\Posse\runtimes`. The ZIP is checked against Node's
published SHA-256 checksum before extraction and use. The fallback does not
require administrator privileges and is reused on later installer runs.
The generated launcher puts its Node directory on PATH for subprocesses.

Git, Python, GitHub CLI, and ripgrep still use winget when missing, and so do
Tesseract, ImageMagick, and FFmpeg when you ask for media tools
(`-WithMediaTools`). winget installs only for your account (`--scope user`),
so setup never waits on an administrator prompt. A package with no per-user
installer is reported as needing an administrator; today that includes
Tesseract. Each package install is limited to `-PackageTimeoutSeconds`
(default 10 minutes), and a download or package-source failure gets one more
try. GitHub CLI is optional unless you use GitHub-backed push
authentication or Session provisioning. Install **App Installer** to provide
winget, or provision these tools manually if your Windows edition/environment does not include it. Node
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
| `-WithMediaTools` | Also install Tesseract OCR, ImageMagick, and FFmpeg (OCR and image/video conversion) |
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
| `-PackageTimeoutSeconds <seconds>` | Limit for each winget package install, default 600; range 60–86400 |
| `-DoctorTimeoutSeconds <seconds>` | Doctor limit, default 7500; range 60–86400 |
| `-DryRun` | Preview without installing; a diagnostic log is still written |
| `-Plain` | Disable colors and spinners |
| `-KeyFile <path>` | Read keys from a `NAME=value` file, save them like typed keys, and delete the file (used by Posse Setup) |
| `-Uninstall` | Remove this checkout's `posse` command, PATH entry, profile lines, and automation task; delete the checkout folder yourself afterwards |
| `-RemoveUserData` | With `-Uninstall`, also delete settings, saved keys, logs, and managed runtimes |

## Troubleshooting

Logs: `%USERPROFILE%\.posse\logs\install-<timestamp>.log`. Failed commands
print their last output and the full log path. The log records each command's
exit code and duration and ends with a `steps:` line of step durations.
Before installing anything, setup stops if less than 1 GB is free and warns
about less than 3 GB or about hosts it cannot reach. Rerun after correcting the
reported issue; existing usable installations are reused.

| Symptom | Action |
|---|---|
| winget absent | Node uses the ZIP fallback; provision Git/Python/helper tools manually or install App Installer |
| Node checksum/download failure | Fix HTTPS/proxy access to nodejs.org; rerun. Failed archives are not installed |
| Administrator-profile error | Rerun in a normal PowerShell window under the account that will use Posse |
| PowerShell blocks the script | Use the invocation above; organization-enforced policies may require your administrator's help |
| SQLite `.node` sharing violation | Close other Posse processes using this installation, then rerun installer or doctor |
| Known valid key reports `invalid posse_key` | Check key status and synchronize Windows time; native heartbeat tokens tolerate only a small clock difference |
| Missing native binaries/model | Confirm POSSE_KEY/network/disk access and run `posse doctor`. A model that did not download leaves an install with a warning and lexical-only code search until doctor completes it |
| "needs an administrator" for a tool | winget has no per-user installer for it; install it yourself (as an administrator), then rerun setup |
| Dependency boot guard fails | Doctor attempted repair; resolve its reported requirement and retry before running jobs |

Keys are plaintext with restricted access, not encrypted. Keep `.env` and the
legacy provider files private. Installer reconfiguration repairs file ACLs;
secrets are written to a restricted temporary file before replacing the old file.
