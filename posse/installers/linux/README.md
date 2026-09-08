# Install Posse on Linux

Start with [access, keys, requirements, and first-task usage](../README.md).
Node.js 24+ and npm are installed automatically when missing or unusable.

## Install in a normal terminal

If you already have the public client checkout:

```bash
cd posse-client/posse
bash installers/linux/install-posse-atlas.sh
```

For a new machine, download the standalone installer first. This needs only
Bash and an HTTPS download tool; the script installs Git and other prerequisites:

```bash
curl -fL --retry 3 --connect-timeout 15 --max-time 120 \
  https://raw.githubusercontent.com/mtstedman/posse-client/main/posse/installers/linux/install-posse-atlas.sh \
  -o install-posse-atlas.sh
bash install-posse-atlas.sh
```

On a minimal Debian/Ubuntu host without curl, first install the download tools:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl
```

Use a normal user shell for the installer; it requests sudo only for system
packages. A direct root shell is supported for containers. Do not invoke the
whole installer through sudo.

Choose your indexing languages when prompted (default: TypeScript/JavaScript
and Python), then paste your Posse key into the hidden prompt. PHP and Composer
are installed only when you select PHP. To enter/change provider keys as well:

```bash
bash install-posse-atlas.sh --configure-keys
```

Open a new shell, or load the generated PATH configuration:

```bash
source ~/.config/posse/atlas.env
cd /path/to/your/git-project
posse doctor
posse admin
posse add "Describe a small first task"
posse go
```

The generated launcher also sets the selected Node directory on PATH, so its
subprocesses can find Node/npm when launched without `.bashrc`.
Credentials load directly from `~/.config/posse/.env`; shell profile sourcing
is not required to load the key.

## Containers and unattended installs

Use a glibc image such as `debian:bookworm-slim`. Alpine is unsupported. You
need a writable home and checkout; use a writable volume or a user-owned clone
instead of installing into a read-only source mount. No systemd is required by
the installer. Privileged Docker mode is not required.

For a full unattended install, inject `POSSE_KEY` and provider credentials into
the process environment and run:

```bash
bash install-posse-atlas.sh --non-interactive --scip-languages typescript,python
```

For an image build, defer keys and the authenticated/model setup:

```dockerfile
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl
RUN curl -fL --retry 3 --connect-timeout 15 --max-time 120 \
      https://raw.githubusercontent.com/mtstedman/posse-client/main/posse/installers/linux/install-posse-atlas.sh \
      -o /tmp/install-posse-atlas.sh \
    && bash /tmp/install-posse-atlas.sh --non-interactive --setup-only --plain
ENV PATH="/root/.local/bin:${PATH}"
WORKDIR /workspace
CMD ["bash"]
```

This example deliberately uses root for both build and runtime. If your
container runs as a non-root user, provision OS packages as root first, then
run the Posse installer as that runtime user with a writable home and checkout.
`--skip-host-tools` is useful after the image's OS packages are provisioned.

Start the image with runtime secrets, for example using Docker's `--env-file`
with a private file outside your repository. Inside the running container,
complete installation without `--setup-only`:

```bash
bash /tmp/install-posse-atlas.sh --non-interactive --scip-languages typescript,python
cd /workspace/your-project
posse doctor
posse status
```

The second pass provisions account settings and Python/SCIP/native/model state.
Persist the runtime user's home and writable checkout, along with your project,
if you want to reuse downloads and state across container recreation. Do not
bake production keys into Dockerfile `ARG`, `ENV`, or image layers. The installer
does not persist injected environment keys. Restrict memory/concurrency through
your deployment and Posse settings if indexing exhausts the container's limits.

## What setup handles

- Missing Git, CA certificates, download/extraction tools, process tools,
  C++/make/pkg-config, Python/pip/venv, and helper CLIs through apt/dnf/yum/pacman/zypper.
- Node 24 through pinned nvm when the current Node/npm pair is unusable. The
  nvm installer script is verified against a SHA-256 embedded in this script
  before it runs, and all downloads are HTTPS-only across redirects. nvm's
  binary-only installation avoids accidentally compiling Node in a slim image.
- A writable existing checkout, or a staged clone of the public client. Failed
  clones are removed without leaving the final destination half-installed.
- npm dependencies, including a SQLite ABI probe before reusing an old install.
- A `~/.local/bin/posse` launcher and optional shell profile wiring.
- Hidden key entry into a private `.env`, then native downloads and runtime doctor.

## Options

| Option | Purpose |
|---|---|
| `--configure-keys` | Enter or replace keys; Enter keeps an existing value |
| `--non-interactive` | Disable prompts; use environment variables or saved keys |
| `--setup-only` | Install core files; defer settings, keys, runtime doctor, and validation |
| `--scip-languages <csv>` | `typescript,python,php,go,rust,clang`, or `all`; default `typescript,python` |
| `--posse-dir <path>` | Use/create this writable checkout; nested `posse/` is detected |
| `--install-root <path>` | Fallback clone base; default `~/claude-tools` |
| `--posse-repo-url <url>` | Override fallback public Git URL |
| `--skip-host-tools` | Skip all OS package installation; still provision Node |
| `--no-install-node` | Require an existing working Node 24+ and npm |
| `--no-persist-env` | Skip shell profile edits; still write launcher/PATH file |
| `--skip-settings` | Preserve account settings without seeding defaults |
| `--force` | Reinstall npm dependencies |
| `--repo-path <path>` | Run an ATLAS smoke test against this project |
| `--repo-id <id>` | Optional smoke-test repository identifier |
| `--smoke-query <text>` | Smoke query; default `auth` |
| `--smoke-provider <name>` | Smoke provider; default `openai` |
| `--no-smoke` | Skip smoke testing |
| `--command-timeout <seconds>` | Command limit, default 1800; range 60–86400 |
| `--doctor-timeout <seconds>` | Doctor limit, default 7500; range 60–86400 |
| `--dry-run` | Preview steps without installing; a diagnostic log is still written |
| `--plain` | Disable colors and spinners |
| `--help` | Show options |

## Troubleshooting

Logs: `~/.posse/logs/install-<timestamp>.log`. The summary reports `ok`,
`skipped`, `partial`, `failed`, or `blocked`. Setup-only success means core
installation completed; it does not mean the runtime is ready.

| Symptom | Action |
|---|---|
| `posse: command not found` | Use `~/.local/bin/posse` or source `~/.config/posse/atlas.env`; set PATH explicitly in containers |
| Node/npm missing after opening a shell | Rerun the installer; use its launcher, which includes the selected Node directory |
| Python venv/ensurepip failure | On Debian/Ubuntu install `python3-venv`; rerun installer/doctor |
| Read-only/permission error | Use a writable home and checkout belonging to the runtime user |
| apt lock/network failure | Wait for other package operations or fix repository/network access; installer retries downloads and waits for apt locks |
| Missing Posse key | Rerun in a terminal for hidden input, or inject `POSSE_KEY` at runtime |
| Keys step says the checkout predates this installer | Run `git pull` (or `posse update`) in the checkout, then rerun |
| `invalid posse_key` with a known valid key | Check host clock synchronization as well as key status; containers share the host clock |
| Native addon ABI error | Rerun installer with `--force`, or `posse doctor` |
| Boot reports dependency repair failure | Read the doctor failure, fix the requirement, then retry; work does not start while the dependency guard is failing |
