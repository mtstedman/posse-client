import path from 'node:path';
import { EXPERIMENT_ENVIRONMENT_EXCLUDED_PARTS as EXCLUDED, EXPERIMENT_ENVIRONMENT_PHP_EXTENSIONS as PHP } from '../../../catalog/experiment-environment.js';
import { safeSetupSource } from '../classes/ExperimentSetupSource.js';
import { experimentDigest } from './snapshots.js';

const entries = value => value ? (Array.isArray(value) ? value : [value]) : [];
const compact = values => values.length === 1 ? values[0] : values;
const identity = value => value.manifest || value.requirements;
export const environmentRecipeGroups = recipe => ['npm', 'pip', 'composer'].flatMap(manager => entries(recipe?.[manager]).map(spec => ({ manager, ...spec })));

// Preserve the complete prepared environment when the agent asks for an addition.
export function mergeEnvironmentRecipe(base, additions = {}) {
  if (!base) return structuredClone(additions);
  if (additions.profile && additions.profile !== base.profile) throw new Error('Additional dependencies must preserve the prepared runtime profile.');
  if (additions.base_image && base.base_image && additions.base_image !== base.base_image) throw new Error('Additional dependencies must preserve the original pinned base image.');
  const result = { ...base, ...additions, profile: base.profile, system_packages: [...new Set([...(base.system_packages || []), ...(additions.system_packages || [])])].sort() };
  for (const manager of ['npm', 'pip', 'composer']) {
    const specs = new Map(entries(base[manager]).map(spec => [identity(spec), spec]));
    for (const spec of entries(additions[manager])) specs.set(identity(spec), spec);
    if (specs.size) result[manager] = compact([...specs.values()].sort((a, b) => identity(a).localeCompare(identity(b))));
  }
  return result;
}

export async function discoverEnvironment(source, options = {}) {
  if (options.auto === false) return { state: 'disabled', recipe: null, projects: [], issues: [], digest: experimentDigest({ auto: false }) };
  const roots = options.roots || ['work'];
  if (roots.some(root => root !== 'work' && (!root.startsWith('work/') || !safeSetupSource(root.slice(5))))) throw new Error('Environment roots must be safe frozen work/ directories.');
  const inventory = source.dependencyInventory || source.inventory;
  const scoped = inventory.filter(file => roots.some(root => file.path.startsWith(`${root}/`)) && !file.path.split('/').some(part => EXCLUDED.includes(part)));
  const names = new Set(scoped.map(file => file.path)), groups = { npm: [], pip: [], composer: [] }, issues = [], packages = new Set(options.system_packages || []);
  const read = name => source.loadDependency ? source.loadDependency(name) : source.load(name);
  for (const file of [...scoped].sort((a, b) => a.path.localeCompare(b.path))) {
    const name = path.posix.basename(file.path), directory = path.posix.dirname(file.path);
    if (name === 'package.json') {
      const manifest = JSON.parse(await read(file.path)), lockfile = `${directory}/package-lock.json`;
      if (manifest.packageManager && !manifest.packageManager.startsWith('npm@')) { issues.push({ path: file.path, reason: 'The declared package manager is not supported by the isolated npm installer.' }); continue; }
      if (manifest.workspaces) { issues.push({ path: file.path, reason: 'npm workspace/local dependency graphs are not supported by the isolated installer yet.' }); continue; }
      if (names.has(lockfile)) groups.npm.push({ manifest: file.path, lockfile });
      else if (['dependencies', 'devDependencies', 'optionalDependencies'].some(key => Object.keys(manifest[key] || {}).length)) issues.push({ path: file.path, reason: 'A supported package-lock.json is required for deterministic npm installation.' });
    } else if (name === 'composer.json') {
      const lockfile = `${directory}/composer.lock`;
      if (!names.has(lockfile)) { issues.push({ path: file.path, reason: 'composer.lock is required for deterministic Composer installation.' }); continue; }
      groups.composer.push({ manifest: file.path, lockfile });
      const manifest = JSON.parse(await read(file.path)), lock = JSON.parse(await read(lockfile));
      for (const requirements of [manifest.require, ...(lock.packages || []).map(pkg => pkg.require)]) {
        for (const extension of Object.keys(requirements || {})) if (PHP[extension]) packages.add(PHP[extension]);
      }
    } else if (name === 'requirements.txt') groups.pip.push({ requirements: file.path });
    else if (name === 'pyproject.toml' && !names.has(`${directory}/requirements.txt`)) issues.push({ path: file.path, reason: 'Pinned requirements.txt is required for the current Python installer.' });
  }
  if (Object.values(groups).reduce((count, group) => count + group.length, 0) > 16 || issues.length > 32) throw new Error('Repository environment discovery exceeds its bounded scope; supply narrower environment.roots.');
  const projects = Object.entries(groups).flatMap(([manager, specs]) => specs.map(spec => ({ manager, root: path.posix.dirname(identity(spec)), ...spec })));
  let recipe = null;
  if (projects.length || packages.size) {
    recipe = { profile: options.profile || (groups.npm.length || groups.composer.length ? 'node' : 'python'), system_packages: [...packages].sort() };
    for (const [manager, specs] of Object.entries(groups)) if (specs.length) recipe[manager] = compact(specs);
  }
  return { state: recipe ? 'pending' : issues.length ? 'unsupported' : 'no_dependencies', recipe, projects, issues, digest: experimentDigest({ recipe, issues, roots }) };
}
