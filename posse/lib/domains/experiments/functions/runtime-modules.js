import fs from 'node:fs/promises';
import path from 'node:path';
import { safeSetupSource } from '../classes/ExperimentSetupSource.js';
import { EXPERIMENT_RUNTIME_NODE_MODULES_LABEL } from '../../../catalog/experiment-runtime.js';

export function runtimeModuleRoots(labels = {}) {
  const encoded = labels?.[EXPERIMENT_RUNTIME_NODE_MODULES_LABEL];
  if (encoded === undefined) return {};
  if (typeof encoded !== 'string' || encoded.length > 16384) throw new Error('Invalid runtime module mapping.');
  const roots = JSON.parse(encoded);
  if (!roots || typeof roots !== 'object' || Array.isArray(roots) || Object.keys(roots).length > 16) throw new Error('Invalid runtime module mapping.');
  for (const [root, target] of Object.entries(roots)) {
    if ((root !== 'work' && (!root.startsWith('work/') || !safeSetupSource(root.slice(5))))
      || root.split('/').includes('node_modules') || typeof target !== 'string'
      || !/^\/posse-runtime\/npm(?:\/[a-f0-9]{64})?\/node_modules$/.test(target)) throw new Error('Invalid runtime module mapping.');
  }
  return roots;
}

// Payload source has already been written as regular files. These dangling host
// links resolve only inside the immutable image after the read-only bind mount.
export async function stageRuntimeModules(directory, roots) {
  for (const [root, target] of Object.entries(roots)) {
    const destination = path.join(directory, root, 'node_modules');
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
    await fs.symlink(target, destination);
  }
}
