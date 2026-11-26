import { CORPUS_PREP_DEFAULTS, CORPUS_PREP_TOOLS } from '../../../catalog/experiment-corpus-prep.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExperimentCorpusPrep } from '../classes/ExperimentCorpusPrep.js';
import { EXPERIMENT_CORPUS_ACTIONS, EXPERIMENT_CORPUS_EXAMPLE, EXPERIMENT_CORPUS_LIMITS } from '../../../catalog/experiment-corpus.js';
import { ExperimentCorpora } from '../classes/ExperimentCorpora.js';
import { scoreCorpusAnswer } from './corpus-scoring.js';
import { downloadCorpusInput } from './corpus-download.js';

export async function importCorpusItems(store, args, options = {}) {
  try { await store.load(args); }
  catch (error) {
    if (error.code !== 'ENOENT' || !args.contract) throw error;
    await store.create(args);
  }
  if (args.entries) return store.attach(args);
  const items = structuredClone(args.items), budget = { bytes: 0 };
  if (!Array.isArray(items) || !items.length || items.length > EXPERIMENT_CORPUS_LIMITS.batch) throw new Error('Import requires 1–100 cases.');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'posse-corpus-import-'));
  try {
  for (const item of items) {
    for (const [alias, resource] of Object.entries(item.resources || {})) {
      if (!resource?.url) continue;
      if (resource.path || resource.id) throw new Error('URL imports cannot also specify path or ID.');
      const downloaded = await downloadCorpusInput(resource.url, temporary, { ...options.download, budget });
      item.resources[alias] = { path: downloaded.path, sha256: resource.sha256 || downloaded.sha256, ...(resource.name ? { name: resource.name } : {}), label: resource.label || item.label || alias };
      item.provenance = { ...(item.provenance || {}), [alias]: downloaded };
    }
  }
  return await store.import({ ...args, items }, options);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

export async function runCorpusCli(argv, { input = process.stdin, print = value => console.log(value), open = () => ExperimentCorpora.open() } = {}) {
  const [action, ...rest] = argv;
  if (rest.length || !EXPERIMENT_CORPUS_ACTIONS.includes(action)) throw new Error('posse experiment corpus schema|choices|create|register|list|inspect|import|update|remove|score|prep < request.json');
  if (action === 'schema') { print(JSON.stringify({ actions: EXPERIMENT_CORPUS_ACTIONS, example: EXPERIMENT_CORPUS_EXAMPLE, prep: { defaults: CORPUS_PREP_DEFAULTS, tools: CORPUS_PREP_TOOLS },
    note: 'Import accepts path, existing resource ID, or public HTTPS URL. Answers supplied by the operator are verified; prep-generated labels are drafts. Every edit creates an immutable revision. Resource ZIPs are shared project-wide; case manifests and answer keys belong to the named experiment.' })); return 0; }
  if (action === 'choices') { print(JSON.stringify(await (await open()).choices())); return 0; }
  if (action === 'list') { print(JSON.stringify(await (await open()).list())); return 0; }
  const chunks = []; let bytes = 0;
  for await (const chunk of input) { const data = Buffer.from(chunk); bytes += data.length; if (bytes > EXPERIMENT_CORPUS_LIMITS.jsonBytes) throw new Error('Corpus request is too large.'); chunks.push(data); }
  let args; try { args = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Corpus request must be JSON.'); }
  if (action === 'score') { print(JSON.stringify(scoreCorpusAnswer(args.contract, args.expected, args.prediction))); return 0; }
  const store = await open(); let result;
  if (action === 'create') result = await store.create(args);
  else if (action === 'register') result = await store.register(args);
  else if (action === 'inspect') result = await store.inspect(args);
  else if (action === 'remove') result = await store.remove(args);
  else if (action === 'import' || action === 'update') {
    if (action === 'update' && !args.expected_revision) throw new Error('Updating a corpus requires expected_revision.');
    result = action === 'update' && args.entries ? await store.annotate(args) : await importCorpusItems(store, { ...args, replace: action === 'update' });
  } else if (action === 'prep') result = await new ExperimentCorpusPrep(store).run(args);
  print(JSON.stringify(result)); return result.state === 'failed' ? 1 : 0;
}
