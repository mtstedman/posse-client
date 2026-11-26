import fs from 'node:fs/promises';
import path from 'node:path';
import { unpackCorpusResource } from './corpus-archive.js';
import { EXPERIMENT_CORPUS_LIMITS as L } from '../../../catalog/experiment-corpus.js';

export function validCorpusFilename(value) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 240 && !/[\\/\u0000-\u001f]/.test(value) && !['.', '..'].includes(value);
}
export function validResourceBinding(binding) {
  return binding && /^[a-f0-9]{64}$/.test(binding.resource_id || '') && binding.file_id === 'payload' && validCorpusFilename(binding.name);
}

export async function readCorpusResource(resource) {
  const info = await fs.lstat(resource.archive_path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > L.resourceBytes + 1048576 || await fs.realpath(resource.archive_path) !== resource.archive_path) throw new Error('Invalid corpus archive file.');
  return unpackCorpusResource(await fs.readFile(resource.archive_path), resource.manifest);
}

// Called inside the sandbox's temporary run directory. Only public resource
// bytes are staged; manifests, answer keys and corpus metadata stay with owner.
// The existing sandbox finally/recovery cleanup removes this entire directory.
export async function stageCorpusInputs(evaluation, runDirectory) {
  const directory = path.join(runDirectory, 'input-files');
  await fs.mkdir(directory, { mode: 0o755 });
  const staged = new Map(), cases = new Map(); let bytesTotal = 0;
  for (const item of evaluation.cases) {
    const files = {};
    for (const [alias, binding] of Object.entries(item.resources)) {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(alias) || !validResourceBinding(binding)) throw new Error('Invalid resource alias or binding.');
      const id = binding.resource_id, resource = evaluation.resources[id];
      if (!resource || resource.manifest.resource_id !== id) throw new Error('Resource registry binding is missing.');
      const resourceDirectory = path.join(directory, id);
      if (!staged.has(id)) {
        const bytes = await readCorpusResource(resource);
        bytesTotal += bytes.length; if (bytesTotal > L.importBytes) throw new Error('Run input byte budget exceeded.');
        await fs.mkdir(resourceDirectory, { mode: 0o755 });
        await fs.writeFile(path.join(resourceDirectory, 'payload'), bytes, { flag: 'wx', mode: 0o444 });
        staged.set(id, new Set(['payload']));
      }
      if (!staged.get(id).has(binding.name)) {
        // Hard links are confined to the private staging directory and mounted
        // read-only. Alternate aliases do not duplicate large unpacked ROMs.
        await fs.link(path.join(resourceDirectory, 'payload'), path.join(resourceDirectory, binding.name));
        staged.get(id).add(binding.name);
      }
      files[alias] = `/input-files/${id}/${binding.name}`;
    }
    cases.set(item.id, files);
  }
  return { directory, cases };
}
