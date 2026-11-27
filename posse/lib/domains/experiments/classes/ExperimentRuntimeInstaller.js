import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EXPERIMENT_RUNTIME_INSTALL_LIMITS as L, EXPERIMENT_RUNTIME_BASE_IMAGES, EXPERIMENT_RUNTIME_RECEIPT_SCHEMA as SCHEMA, EXPERIMENT_RUNTIME_PATHS as P } from '../../../catalog/experiment-runtime.js';
import { runtimeRecipe, runtimeSourcesMatch, validateRuntimeReceipt, runtimeImageReference } from '../functions/runtime-install.js';
import { experimentDigest } from '../functions/snapshots.js';

const exec = promisify(execFile), docker = '/usr/bin/docker';
const environment = () => ({ PATH: '/usr/local/bin:/usr/bin:/bin', HOME: os.homedir(), XDG_RUNTIME_DIR: `/run/user/${process.getuid()}`, DOCKER_HOST: 'unix:///var/run/docker.sock' });
const failure = (message, code) => Object.assign(new Error(message), { code });
const identity = id => { if (!/^posse-runtime-[a-f0-9-]{36}$/.test(id || '')) throw new Error('Invalid runtime installation identity.'); return id; };
const quote = text => `'${text.replaceAll("'", "'\\''")}'`;

export class ExperimentRuntimeInstaller {
  constructor({ cacheRoot = path.join(os.homedir(), '.local', 'state', 'posse', 'experiment-runtimes'), command, now = Date.now } = {}) {
    this.cacheRoot = path.resolve(cacheRoot); this.now = now;
    this.command = command || (async (program, args, options = {}) => {
      try { return (await exec(program, args, { env: environment(), timeout: 30000, maxBuffer: L.outputBytes, ...options })).stdout.trim(); }
      catch (error) {
        const detail = String(error.stderr || error.stdout || error.message).slice(-2400);
        throw Object.assign(new Error(`Runtime provisioning command failed: ${detail}`), { code: error.code });
      }
    });
  }
  async directory() {
    await fs.mkdir(path.join(this.cacheRoot, 'receipts'), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(this.cacheRoot, 'recipes'), { recursive: true, mode: 0o700 });
    for (const directory of [this.cacheRoot, path.join(this.cacheRoot, 'receipts'), path.join(this.cacheRoot, 'recipes')]) {
      const info = await fs.lstat(directory);
      if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077) || await fs.realpath(directory) !== directory) throw new Error('Runtime cache must use private owned directories without symlinks.');
    }
  }
  async json(filename) {
    const info = await fs.lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) || info.size > L.receiptBytes || await fs.realpath(filename) !== filename) throw new Error('Runtime receipt must be a bounded private regular file.');
    return JSON.parse(await fs.readFile(filename, 'utf8'));
  }
  async readReceipt(recipeDigest) {
    if (!/^[a-f0-9]{64}$/.test(recipeDigest || '')) throw new Error('Invalid runtime recipe digest.');
    const index = await this.json(path.join(this.cacheRoot, 'recipes', `${recipeDigest}.json`));
    if (!/^[a-f0-9]{64}$/.test(index.receipt_digest || '')) throw new Error('Invalid runtime cache index.');
    const receipt = validateRuntimeReceipt(await this.json(path.join(this.cacheRoot, 'receipts', `${index.receipt_digest}.json`)));
    if (receipt.receipt_digest !== index.receipt_digest || receipt.recipe_digest !== recipeDigest) throw new Error('Runtime cache receipt binding changed.');
    return receipt;
  }
  async imageDetails(image, signal) {
    if (!runtimeImageReference(image)) throw new Error('Invalid runtime image reference.');
    const details = JSON.parse(await this.command(docker, ['image', 'inspect', image], { signal }))[0];
    if (!/^sha256:[a-f0-9]{64}$/.test(details?.Id || '') || Object.keys(details.Config?.Volumes || {}).length) throw new Error('Runtime image must have an immutable identity and no declared volumes.');
    return details;
  }
  async isAvailable(receipt, { signal } = {}) {
    validateRuntimeReceipt(receipt);
    let image;
    try { image = await this.imageDetails(receipt.image, signal); } catch (error) { signal?.throwIfAborted(); if (error.code === 'ENOENT') throw error; return false; }
    return image.Id === receipt.image && image.Config?.Labels?.['posse.experiment.runtime.recipe'] === receipt.recipe_digest;
  }
  async validateReceipt(receipt, { source, signal } = {}) {
    validateRuntimeReceipt(receipt); signal?.throwIfAborted();
    if (source && !await runtimeSourcesMatch(receipt, source)) throw failure('Runtime dependency source hashes changed.', 'runtime_sources_changed');
    if (!await this.isAvailable(receipt, { signal })) throw failure('Provisioned runtime image is missing or its recipe label changed.', 'runtime_image_missing');
    return receipt;
  }
  async cleanup(id) {
    const name = identity(id);
    await this.command('/usr/bin/systemctl', ['--user', 'stop', `${name}.service`], { timeout: 15000 }).catch(() => {});
    await this.command(docker, ['rm', '--force', name], { timeout: 15000 }).catch(() => {});
    try {
      if (String(await this.command(docker, ['ps', '--all', '--quiet', '--filter', `name=^/${name}$`], { timeout: 15000 })).trim()) throw new Error('Container still exists.');
    } catch { throw Object.assign(new Error('Runtime installation cleanup is unconfirmed.'), { cleanupUnconfirmed: true }); }
  }
  script(recipe) {
    const packages = new Set(recipe.system_packages);
    if (recipe.composer) for (const name of ['composer', 'php-cli', 'unzip', 'ca-certificates']) packages.add(name);
    if (recipe.pip && recipe.profile === 'node') for (const name of ['python3', 'python3-pip']) packages.add(name);
    if (recipe.npm && recipe.profile === 'python') for (const name of ['nodejs', 'npm']) packages.add(name);
    const commands = ['#!/bin/sh', 'set -eu', 'umask 022'];
    if (packages.size) commands.push('export DEBIAN_FRONTEND=noninteractive', 'apt-get update', `apt-get install -y --no-install-recommends -- ${[...packages].sort().map(quote).join(' ')}`, 'rm -rf /var/lib/apt/lists/*');
    if (recipe.npm) commands.push(`cd ${P.root}/npm`, ': > /tmp/posse-npm-user.npmrc', ': > /tmp/posse-npm-global.npmrc',
      'npm ci --include=dev --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org --userconfig=/tmp/posse-npm-user.npmrc --globalconfig=/tmp/posse-npm-global.npmrc',
      `if [ -e ${P.npm} ] || [ -L ${P.npm} ]; then test "$(readlink ${P.npm})" = ${P.root}/npm/node_modules; else ln -s ${P.root}/npm/node_modules ${P.npm}; fi`);
    if (recipe.pip) commands.push(`python3 -m pip --isolated install --no-cache-dir --disable-pip-version-check --only-binary=:all: --index-url https://pypi.org/simple --target ${P.python} --requirement ${P.root}/pip/requirements.txt`,
      `python3 -c ${quote(`import pathlib, site; d=pathlib.Path(site.getsitepackages()[0]); d.mkdir(parents=True, exist_ok=True); (d/'posse-runtime.pth').write_text('${P.python}\n')`)}`);
    if (recipe.composer) commands.push('export COMPOSER_HOME=/tmp/composer-home COMPOSER_CACHE_DIR=/tmp/composer-cache COMPOSER_ALLOW_SUPERUSER=1',
      `export COMPOSER_VENDOR_DIR=${P.root}/composer/vendor`, `composer install --working-dir=${P.root}/composer --no-dev --no-interaction --no-progress --no-scripts --no-plugins --prefer-dist`);
    commands.push('chmod -R a+rX /posse-runtime', 'rm -f /posse-runtime/install.sh', 'echo POSSE_RUNTIME_INSTALL_COMPLETE');
    return commands.join('\n') + '\n';
  }
  async publish(receipt, guard) {
    await this.directory();
    const write = async (filename, value, immutable) => {
      const temporary = path.join(this.cacheRoot, `${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 }); guard();
        if (immutable) {
          try { await fs.link(temporary, filename); } catch (error) { if (error.code !== 'EEXIST' || experimentDigest(await this.json(filename)) !== experimentDigest(value)) throw error; }
        } else await fs.rename(temporary, filename);
      } finally { await fs.rm(temporary, { force: true }); }
    };
    await write(path.join(this.cacheRoot, 'receipts', `${receipt.receipt_digest}.json`), receipt, true);
    await write(path.join(this.cacheRoot, 'recipes', `${receipt.recipe_digest}.json`), { receipt_digest: receipt.receipt_digest }, false);
  }
  async install(args, { source, signal, guard = () => {}, reserve = () => {}, release = () => {} }) {
    const check = () => { signal?.throwIfAborted(); guard(); };
    check();
    const prepared = await runtimeRecipe(args, source); check();
    const requestedBase = args.base_image || EXPERIMENT_RUNTIME_BASE_IMAGES[args.profile];
    let base;
    try { base = await this.imageDetails(requestedBase, signal); }
    catch (error) {
      check();
      if (/^sha256:/.test(requestedBase)) throw failure('Pinned runtime base image is missing; restore it before provisioning.', 'runtime_image_missing');
      await this.command(docker, ['pull', requestedBase], { signal, timeout: 180000 }); check(); base = await this.imageDetails(requestedBase, signal);
    }
    const recipe = { ...prepared.recipe, base_image: base.Id }, recipeDigest = experimentDigest({ schema: SCHEMA, recipe, files: prepared.files });
    try { const cached = await this.readReceipt(recipeDigest); if (await this.isAvailable(cached, { signal })) { check(); return { ...cached, reused: true }; } }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    check();
    const info = JSON.parse(await this.command(docker, ['info', '--format', '{{json .}}'], { signal }));
    if (info.OSType !== 'linux' || info.CgroupVersion !== '2' || !info.MemoryLimit || !info.SwapLimit || !info.PidsLimit || !info.CpuCfsQuota || !info.SecurityOptions?.some(item => item.startsWith('name=seccomp'))) throw new Error('Required runtime provisioning isolation is unavailable.');
    await this.command('/usr/bin/systemctl', ['--user', 'show-environment'], { signal }); check();
    const id = `posse-runtime-${randomUUID()}`, staging = await fs.mkdtemp(path.join(os.tmpdir(), 'posse-runtime-inputs-'));
    let reserved = false, cleanupUnconfirmed = false, result, error;
    try {
      for (const [kind, spec] of Object.entries({ npm: recipe.npm, pip: recipe.pip, composer: recipe.composer })) if (spec) {
        const directory = path.join(staging, kind); await fs.mkdir(directory, { mode: 0o755 });
        for (const name of Object.values(spec)) await fs.writeFile(path.join(directory, path.posix.basename(name)), prepared.contents[name], { flag: 'wx', mode: 0o644 });
      }
      await fs.chmod(staging, 0o755); await fs.writeFile(path.join(staging, 'install.sh'), this.script(recipe), { flag: 'wx', mode: 0o444 });
      check(); await reserve({ id, recipe_digest: recipeDigest }); reserved = true; check();
      await this.command(docker, ['create', '--name', id, '--pull=never', '--network=bridge', '--user=0:0', '--cap-drop=ALL',
        ...['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETUID', 'SETGID'].map(cap => `--cap-add=${cap}`), '--security-opt=no-new-privileges',
        `--pids-limit=${L.pids}`, `--memory=${L.memoryMB}m`, `--memory-swap=${L.memoryMB}m`, `--cpus=${L.cpus}`, '--ipc=private', '--cgroupns=private',
        '--tmpfs=/tmp:rw,nosuid,nodev,size=512m', '--log-driver=none', '--no-healthcheck', '--init', '--workdir=/posse-runtime', '--env=HOME=/tmp',
        '--entrypoint=/bin/sh', base.Id, '/posse-runtime/install.sh'], { signal }); check();
      await this.command(docker, ['cp', `${staging}/.`, `${id}:${P.root}`], { signal }); check();
      await this.command('/usr/bin/systemd-run', ['--user', '--quiet', '--pipe', '--wait', '--collect', `--unit=${id}`,
        `--property=RuntimeMaxSec=${L.wallSeconds}`, '--property=TimeoutStopSec=5', `--property=ExecStopPost=/usr/bin/docker stop --time 1 ${id}`, '--', docker, 'start', '--attach', id], { signal, timeout: (L.wallSeconds + 30) * 1000 }); check();
      if (String(await this.command(docker, ['inspect', '--format', '{{.State.ExitCode}}', id], { signal })).trim() !== '0') throw new Error('Runtime package installation did not complete successfully.');
      check();
      const image = String(await this.command(docker, ['commit', '--change', `LABEL posse.experiment.runtime.recipe=${recipeDigest}`, '--change', 'USER 65534:65534', '--change', 'ENTRYPOINT []', '--change', `CMD ["${recipe.profile === 'node' ? 'node' : 'python3'}"]`, id], { signal, timeout: 120000 })).trim();
      check();
      const body = { schema: SCHEMA, recipe_digest: recipeDigest, recipe, profile: recipe.profile, base_image: base.Id, requested_base_image: requestedBase,
        image, files: prepared.files, paths: { ...(recipe.npm ? { node_modules: P.npm } : {}), ...(recipe.pip ? { python: P.python } : {}), ...(recipe.composer ? { composer_autoload: P.composer } : {}) }, created_at: this.now() };
      result = { ...body, receipt_digest: experimentDigest(body) };
      if (!await this.isAvailable(result, { signal })) throw new Error('Committed runtime image identity could not be verified.');
    } catch (caught) { error = caught; }
    finally {
      if (reserved) {
        try { await this.cleanup(id); } catch (caught) { cleanupUnconfirmed = true; error = caught; }
        try { await release({ cleanup_unconfirmed: cleanupUnconfirmed }); } catch (caught) { error ||= caught; }
      }
      await fs.rm(staging, { recursive: true, force: true });
    }
    if (error) throw error;
    check(); await this.publish(result, check); check(); return { ...result, reused: false };
  }
}
