import { gitExecAsync } from '../../git/functions/utils.js';
import { integrationRelativePath } from '../functions/integration-config.js';
import { SETUP_AGENT_LIMITS as L } from '../../../catalog/experiment-setup-agent.js';
import { ExperimentSourceIndex } from './ExperimentSourceIndex.js';
import { fileExcerpt, prefetchSource } from '../functions/agent-context.js';

// Only bounded regular blobs at one Git commit. Never read the working tree,
// untracked inputs, owner state, private key files, or an unrestricted Atlas view.
export const safeSetupSource = name => name.length <= 235 && integrationRelativePath(name) && !name.split('/').some(part =>
  /^(?:\.env(?:rc|\..*)?|\.ssh|\.aws|\.npmrc|\.netrc|\.?credentials?(?:\..*)?|\.?secrets?(?:\..*)?|\.?keys?(?:\.json)?|id_(?:rsa|ed25519|ecdsa))$/i.test(part))
  && !/\.(?:pem|key|p12|pfx|keystore)$/i.test(name);

export class ExperimentSetupSource {
  constructor(repo, { git = gitExecAsync, index = new ExperimentSourceIndex() } = {}) { this.repo = repo; this.git = git; this.index = index; this.files = {}; this.bytes = 0; }
  async open() {
    this.base = String(await this.git(['rev-parse', 'HEAD'], this.repo)).trim();
    const tree = String(await this.git(['ls-tree', '-rz', '--long', this.base], this.repo, { trim: false }));
    this.inventory = tree.split('\0').flatMap(row => {
      const match = /^(100644|100755) blob [a-f0-9]+\s+(\d+)\t(.+)$/.exec(row);
      return match && safeSetupSource(match[3]) && Number(match[2]) <= L.fileBytes ? [{ path: `work/${match[3]}`, bytes: Number(match[2]) }] : [];
    });
    if (this.inventory.length > L.sourceFiles) throw new Error('Repository source inventory exceeds the setup limit.');
    return this;
  }
  inventoryPage({ query = '', offset = 0 } = {}) {
    const rows = this.inventory.filter(f => f.path.toLowerCase().includes(query.toLowerCase()));
    return { files: rows.slice(offset, offset + L.page), total: rows.length, next_offset: offset + L.page < rows.length ? offset + L.page : null };
  }
  async load(name) {
    if (!this.inventory.some(f => f.path === name)) throw new Error('Source is outside the safe frozen Git inventory.');
    if (!Object.hasOwn(this.files, name)) {
      const source = String(await this.git(['show', `${this.base}:${name.slice(5)}`], this.repo, { trim: false }));
      if (source.includes('\0') || /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(source)) throw new Error('Binary or private key content is unavailable to setup.');
      const bytes = Buffer.byteLength(source);
      if (bytes > L.fileBytes || this.bytes + bytes > L.snapshotBytes) throw new Error('Setup source snapshot byte budget exhausted.');
      this.files[name] = source; this.bytes += bytes;
    }
    return this.files[name];
  }
  plan() { return { files: Object.keys(this.files).map(path => ({ path, mode: 'read', instructions: 'Frozen repository source; setup cannot edit it.' })) }; }
  async prefetch(objective, signal) {
    const words = objective.toLowerCase().match(/[a-z]{4,}/g) || [];
    const selected = [...this.inventory].sort((a, b) => {
      const rank = f => words.filter(w => f.path.toLowerCase().includes(w)).length * 2 + Number(/(?:package\.json|pyproject\.toml|README\.md)$/.test(f.path));
      return rank(b) - rank(a) || a.bytes - b.bytes;
    }).slice(0, 8);
    const unavailable = [];
    for (const file of selected) { signal.throwIfAborted(); try { await this.load(file.path); } catch { unavailable.push(file.path); } }
    const overview = await this.index.overview(this.plan(), this.files, signal);
    const targets = overview.files.flatMap(file => file.anchors.slice(0, 1).map(anchor => ({ path: file.path, sha256: file.sha256, start_line: anchor[2], line_count: anchor[3] })));
    return { overview, unavailable, reads: prefetchSource(this.plan(), this.files, targets, overview) };
  }
  async lookup(call, signal) {
    const args = call.arguments;
    if (args.version !== 'accepted') throw new Error('Setup can inspect only the frozen accepted source.');
    if (call.name === 'test.read') { await this.load(args.path); return { version: 'accepted', ...fileExcerpt(this.files, args, 16384) }; }
    if (call.name !== 'test.search') throw new Error('Only source read/search requests may be batched.');
    if (args.path) await this.load(args.path);
    // Broad searches cover loaded snapshots; inventory filters find additional
    // paths without silently reading the entire repository into model context.
    return { ...await this.index.search(this.plan(), this.files, args, signal), search_scope: args.path ? 'selected_path' : 'loaded_files', unloaded_files: this.inventory.length - Object.keys(this.files).length };
  }
}
