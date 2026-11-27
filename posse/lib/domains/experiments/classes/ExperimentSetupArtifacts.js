import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SETUP_ARTIFACT_SCHEMA, SETUP_AGENT_LIMITS as L } from '../../../catalog/experiment-setup-agent.js';
import { experimentDigest } from '../functions/snapshots.js';
import { ensurePosseGitInfoExcludeAsync } from '../../runtime/functions/ignore.js';

export class ExperimentSetupArtifacts {
  constructor(repo) { this.repo = repo; this.root = path.join(repo, '.posse', 'experiment-setups'); }
  async directory() {
    await ensurePosseGitInfoExcludeAsync(this.repo);
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    if (await fs.realpath(this.root) !== this.root) throw new Error('Setup artifact directory must not contain symlinks.');
  }
  async save(value, { guard = () => {} } = {}) {
    const artifact = { ...value, schema: SETUP_ARTIFACT_SCHEMA, repo_path: this.repo };
    const id = experimentDigest(artifact);
    if (Buffer.byteLength(JSON.stringify(artifact)) > L.artifactBytes) throw new Error('Setup artifact exceeds 512 KiB.');
    await this.directory();
    const temporary = path.join(this.root, `${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, JSON.stringify(artifact, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      guard();
      try { await fs.link(temporary, path.join(this.root, `${id}.json`)); }
      catch (error) { if (error.code !== 'EEXIST') throw error; await this.get(id); }
    } finally { await fs.rm(temporary, { force: true }); }
    return { artifact: id, ...artifact };
  }
  async get(id) {
    if (!/^[a-f0-9]{64}$/.test(id || '')) throw new Error('Use the immutable setup artifact digest.');
    const filename = path.join(this.root, `${id}.json`);
    if (await fs.realpath(filename) !== filename) throw new Error('Setup artifact path contains a symlink.');
    const info = await fs.lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) || info.size > L.artifactBytes * 2) throw new Error('Expected a private owned setup artifact.');
    const value = JSON.parse(await fs.readFile(filename, 'utf8'));
    if (value.schema !== SETUP_ARTIFACT_SCHEMA || value.repo_path !== this.repo || experimentDigest(value) !== id || !value.validation?.ok) throw new Error('Setup artifact identity or validation changed.');
    return { artifact: id, ...value };
  }
  async list({ offset = 0 } = {}) {
    if (!Number.isInteger(offset) || offset < 0) throw new Error('Invalid artifact offset.');
    let names;
    try { names = await fs.readdir(this.root); } catch (error) { if (error.code === 'ENOENT') return { artifacts: [], total: 0, next_offset: null }; throw error; }
    if (await fs.realpath(this.root) !== this.root) throw new Error('Setup artifact path contains a symlink.');
    const results = [];
    const all = names.filter(n => /^[a-f0-9]{64}\.json$/.test(n)).sort();
    for (const name of all.slice(offset, offset + 10)) {
      const a = await this.get(name.slice(0, -5));
      results.push({ artifact: a.artifact, objective: a.template.setup.plan.objective.slice(0, 240), corpus: a.template.corpus, base_commit: a.validation.base_commit });
    }
    const packet = () => ({ artifacts: results, total: all.length, next_offset: offset + results.length < all.length ? offset + results.length : null });
    while (Buffer.byteLength(JSON.stringify(packet())) > 8192 && results.length) results.pop();
    return packet();
  }
}
