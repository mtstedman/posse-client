import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EXPERIMENT_WORKSPACE_SCHEMA, EXPERIMENT_WORKSPACE_ACTIONS } from '../../../catalog/experiment-workspace.js';
import { privateJson } from './workspace-init.js';
import { experimentDigest } from './snapshots.js';
import { validateExperimentSetup } from './setup.js';

async function save(filename, value) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, filename);
  } finally { await fs.rm(temporary, { force: true }); }
}

export async function workspaceExperimentCommand(action, directory, { request = isolatedOwnerRequest } = {}) {
  if (!EXPERIMENT_WORKSPACE_ACTIONS.includes(action)) throw new Error('Unsupported workspace command.');
  directory = path.resolve(directory);
  if (await fs.realpath(directory) !== directory) throw new Error('Workspace must not contain symlinks.');
  const manifest = await privateJson(path.join(directory, 'workspace.json'));
  if (manifest.schema !== EXPERIMENT_WORKSPACE_SCHEMA || manifest.directory !== directory || !path.isAbsolute(manifest.owner)) throw new Error('Invalid experiment workspace manifest.');
  const launch = await privateJson(path.join(directory, 'launch.json'));
  const setup = await privateJson(path.join(directory, 'setup.json'));
  const validation = validateExperimentSetup(launch.setup);
  if (!validation.ok || experimentDigest(setup) !== manifest.setup_digest || validation.setup_digest !== manifest.setup_digest || launch.setup_digest !== manifest.setup_digest || launch.idempotency_key !== manifest.idempotency_key) throw new Error('Prepared setup changed; initialize a new experiment.');
  const runtime = await privateJson(path.join(manifest.owner, 'experiment-runtime.json'));
  if (experimentDigest(runtime) !== manifest.runtime_digest) throw new Error('Prepared runtime changed; initialize a new experiment.');
  let args = launch;
  if (action !== 'launch') {
    let receipt;
    try { receipt = await privateJson(path.join(directory, 'launch-receipt.json')); }
    catch (error) { if (error.code === 'ENOENT') throw new Error('Launch this workspace first. Replaying launch safely recovers a missing receipt.'); throw error; }
    args = { id: receipt.id, ...(action === 'case-results' ? { which: 'latest' } : {}) };
  }
  const result = await request(manifest.owner, `experiment.${action === 'status' ? 'report' : action.replaceAll('-', '_')}`, args);
  if (action === 'launch') await save(path.join(directory, 'launch-receipt.json'), result);
  if (action === 'case-results') await save(path.join(directory, 'case-results.json'), result);
  if (action === 'status') await save(path.join(directory, 'report.json'), result);
  return result;
}

async function isolatedOwnerRequest(owner, operation, args) {
  // CLI process only. Do not redirect a long-lived service or share this scope
  // with parallel requests: each prepared workspace owns its own daemon.
  const keys = ['POSSE_AUTOMATION_DATA_DIR', 'POSSE_AUTOMATION_DB_PATH', 'POSSE_AUTOMATION_SOCKET', 'POSSE_REGISTERED_AGENT_SOCKET'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    process.env.POSSE_AUTOMATION_DATA_DIR = owner;
    const { AutomationOwnerClient, ensureAutomationOwner } = await import('../../automation/classes/AutomationOwnerClient.js');
    await ensureAutomationOwner({ timeoutMs: 15000 });
    return await new AutomationOwnerClient({ operator: true, timeoutMs: 60000 }).request(operation, args);
  } finally {
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  }
}
