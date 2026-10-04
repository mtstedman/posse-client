# Install and start Posse

Posse runs AI-assisted jobs against your Git repositories. ATLAS code indexing
is included; you do not need a separate ATLAS checkout or server.

## 1. Get access and a key

Visit [yourposseai.com](https://yourposseai.com/) for the product and app downloads.
The service currently supports administrator-issued access keys. Ask the Posse
administrator who granted you access for your **POSSE_KEY**. The public website
does not currently document a self-service key signup flow.

You also need access to a model provider to run jobs. A Posse key authorizes
Posse's service, tool catalogs, and native downloads; it is separate from a
provider API key or provider CLI login. Configure the provider you intend to
use in `posse admin`. You do not need accounts with every provider.

The installer prompts for a missing Posse key in an interactive terminal. Input
is hidden. Paste the key and press Enter. Use `--configure-keys` on Linux or
`-ConfigureKeys` on Windows to enter or change provider keys too.

Keys entered into the installer are saved to:

- Linux: `~/.config/posse/.env`, readable/writable only by its owner (`0600`).
- Windows: `%USERPROFILE%\.config\posse\.env`, with an ACL restricted to the
  current user, SYSTEM, and local Administrators. New installs write only this
  file. A `providers.env.ps1` or user-environment entry left by an older
  installer is kept in sync when you rotate a key, but is never created.

Posse loads the five supported credential names from this file on launch:
`POSSE_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`, and
`CODEX_API_KEY`. Existing
process environment values take precedence. This is an account-wide file
outside your projects, so you do not need to put credentials in each repo's
`.env`. Do not commit or share it. Older installer provider files are read as
literal data for compatibility; their shell commands are never executed by
Posse's credential loader.
`npm run pull:native` loads the same file, so it works outside the launcher.

For containers and automation, inject environment variables at runtime. The
installer uses injected values without copying them to disk. A noninteractive
full install fails clearly if no Posse key is available; `--setup-only` /
`-SetupOnly` intentionally defers that requirement.

## 2. Check requirements

| Requirement | Details |
|---|---|
| Operating system | Windows with PowerShell 5.1/7+, or Linux with glibc 2.34+ and Bash 4.4+ (RHEL/Alma/Rocky 9+, Amazon Linux 2023, Ubuntu 22.04+, Debian 12+); Posse's native binaries and SQLite driver cannot load on older glibc. Start with Debian/Ubuntu for containers. Alpine/musl is unsupported. |
| Node.js | Node **24+ and npm**. Both installers automatically provision them when missing or unusable. |
| Writable storage | A writable home directory, Posse checkout, and target Git repository. Runtime tools and model downloads need additional disk space. |
| Network | HTTPS access to GitHub, Node/npm registries, your distro repositories, Python/indexer sources, Posse services, and your chosen provider. Model downloads can take much longer than the core install. |
| System tools | Git, Python 3.9+, optional GitHub CLI, and language/build tools. Linux installs missing packages using root or sudo; Windows uses winget for host tools, per user only. Media tools (Tesseract OCR, ImageMagick, FFmpeg) are opt-in: `--with-media-tools` / `-WithMediaTools`, or the setup wizard's checkbox. |
| Disk | About 3 GB free for a full install (more with Rust). The installer stops before installing anything below 1 GB and warns below 3 GB. |
| Git identity | Configure `git config --global user.name "Your Name"` and `git config --global user.email "you@example.com"` before running jobs that commit. |

Node provisioning is separate from helper-tool installation. `--skip-host-tools`
or `-SkipHostTools` does **not** disable automatic Node installation.
Use `--no-install-node` / `-NoInstallNode` only when managing Node yourself.

## 3. Install

- **Windows:** download and run **PosseSetup.exe** from the
  [latest Posse release](https://github.com/mtstedman/posse-client/releases/latest).
  It is a standard setup wizard; Posse then appears in Installed apps.
- **Linux:** run
  `curl -fsSL https://raw.githubusercontent.com/mtstedman/posse-client/main/posse/installers/linux/install-posse-atlas.sh | bash`
  in a normal user terminal.

Both ask which languages your projects use and install each language's
indexing toolchain. Details, options, and troubleshooting:

- [Linux installation, containers, and troubleshooting](linux/README.md)
- [Windows installation and troubleshooting](windows/README.md)

The installer installs dependencies, wires the `posse` command, captures keys,
and runs `posse doctor` to provision Python/SCIP environments, authenticated
native binaries, and the embedding model. It then checks that Posse boots.
A failed required step produces a nonzero exit code and a log location.
If only the embedding model fails to download (after one retry), the install
finishes with a warning: Posse works with lexical code search until
`posse doctor` downloads the model. npm dependencies install from the
checkout's `package-lock.json`, so every install gets the tested versions.
The log ends with a `steps:` line giving each step's duration.

A setup-only image build installs the core files and command but does **not**
claim that the authenticated runtime is ready. Complete installation under the
runtime user after injecting the key.

## 4. Run your first task

Open a new terminal after installation, then enter the **project you want
Posse to work on**, rather than the Posse installation directory:

```bash
cd /path/to/your/git-project
posse doctor
posse admin
posse add "Describe the change you want"
posse go
```

`posse admin` lets you configure providers and account settings. `posse go`
plans and runs queued work. Work that modifies the repository uses Git
worktrees. Review the resulting changes before publishing them.

| Command | Purpose |
|---|---|
| `posse help` | Full command reference |
| `posse queue` | List queued work |
| `posse status` | Inspect work and job status |
| `posse plan` | Plan queued work without starting execution |
| `posse run` | Execute planned jobs |
| `posse review` | Review completed work and approval decisions |
| `posse doctor` | Repair dependencies and verify native/model requirements |
| `posse update` | Update the client and repair runtime dependencies |

`posse run` / `posse go` repair Posse's own npm dependencies before loading
SQLite. The run boot then checks project/runtime dependencies, runs the doctor
repair engine if the check is unhealthy, and verifies the result **before
starting the scheduler**. Unresolved requirements stop boot with an error.
Doctor repairs automatically; you do not need to pipe `y` into it. It does not
invent missing credentials or grant system privileges.

## 5. Recover from a failed install

Read the failed step and the last command output in the installer summary.
Fix the reported access, package, disk, or network issue and rerun the same
installer. Successful work is reused where possible. `posse doctor` repairs
runtime dependencies after the command itself has been installed.

Keep the installation and runtime under the same user. A container built as
root installs into root's home unless you explicitly choose a different user;
switching users afterwards does not transfer its keys, PATH, or runtimes.
