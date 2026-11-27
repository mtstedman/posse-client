import path from 'node:path';
import { EXPERIMENT_RUNTIME_INSTALL_SCHEMA, EXPERIMENT_RUNTIME_INSTALL_LIMITS as L, EXPERIMENT_RUNTIME_RECEIPT_SCHEMA, EXPERIMENT_RUNTIME_PATHS as P } from '../../../catalog/experiment-runtime.js';
import { validateToolArguments } from '../../../shared/tools/functions/schema-validation.js';
import { experimentDigest, fileDigest } from './snapshots.js';
import { safeSetupSource } from '../classes/ExperimentSetupSource.js';

export const runtimeImageReference = value => typeof value === 'string' && value.length <= 240 &&
  (/^sha256:[a-f0-9]{64}$/.test(value) || /^[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9_.-]+)?(?:@sha256:[a-f0-9]{64})?$/.test(value)) && !value.includes('..');
const publicUrl = (value, hosts) => {
  let url; try { url = new URL(value); } catch { return false; }
  return url.protocol === 'https:' && !url.username && !url.password && !url.port && hosts.includes(url.hostname)
    && ![...url.searchParams.keys()].some(key => /token|auth|password|secret|key/i.test(key));
};
const jsonObject = text => { const value = JSON.parse(text); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Dependency manifest must be a JSON object.'); return value; };
const registryVersion = value => typeof value === 'string' && value.length <= 240 && /^[A-Za-z0-9~^<>=*| .+_-]+$/.test(value);
export const runtimeProjects = value => value === undefined ? [] : Array.isArray(value) ? value : [value];
export function runtimeProjectDirectory(kind, spec, count) {
  return `${P.root}/${kind}${count > 1 ? `/${fileDigest(spec.manifest || spec.requirements)}` : ''}`;
}
export function runtimeProjectPaths(recipe) {
  const npm = runtimeProjects(recipe.npm), composer = runtimeProjects(recipe.composer);
  return { ...(npm.length ? { ...(npm.length === 1 ? { node_modules: P.npm } : {}), node_modules_by_root: Object.fromEntries(npm.map(spec => [path.posix.dirname(spec.manifest), `${runtimeProjectDirectory('npm', spec, npm.length)}/node_modules`])) } : {}),
    ...(recipe.pip ? { python: P.python } : {}),
    ...(composer.length ? { ...(composer.length === 1 ? { composer_autoload: P.composer } : {}), composer_autoload_by_root: Object.fromEntries(composer.map(spec => [path.posix.dirname(spec.manifest), `${runtimeProjectDirectory('composer', spec, composer.length)}/vendor/autoload.php`])) } : {}) };
}
const dependencyInventory = source => source.dependencyInventory || source.inventory;
const loadDependency = (source, name) => source.loadDependency ? source.loadDependency(name) : source.load(name);
function npmFiles(manifest, lock) {
  if (manifest.workspaces || manifest.bundleDependencies || manifest.bundledDependencies) throw new Error('npm workspaces and bundled/local dependencies are unsupported; use a standalone registry lockfile.');
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    if (manifest[key] && (typeof manifest[key] !== 'object' || Array.isArray(manifest[key]) || Object.values(manifest[key]).some(value => !registryVersion(value)))) throw new Error('npm dependencies must use public registry versions, not file, workspace, Git or URL references.');
  }
  const overrides = value => {
    if (typeof value === 'string' && !registryVersion(value)) throw new Error('npm overrides must use registry versions; local/URL aliases are unsupported.');
    if (value && typeof value === 'object') for (const nested of Object.values(value)) overrides(nested);
  };
  overrides(manifest.overrides);
  if (![1, 2, 3].includes(lock.lockfileVersion)) throw new Error('npm requires a package-lock.json lockfile version 1, 2 or 3.');
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (value.link === true || (typeof value.version === 'string' && /^(?:file:|link:|workspace:|git|https?:|\/|\.\.)/.test(value.version))) throw new Error('npm lockfile contains unsupported linked/local dependencies.');
    if (value.resolved !== undefined && !publicUrl(value.resolved, ['registry.npmjs.org'])) throw new Error('npm lockfile downloads must use https://registry.npmjs.org without credentials.');
    for (const nested of Object.values(value)) if (typeof nested === 'object') visit(nested);
  };
  for (const name of Object.keys(lock.packages || {})) if (name && (name.startsWith('/') || name.split('/').includes('..') || name.includes('\\') || !name.startsWith('node_modules/'))) throw new Error('npm lockfile package path escapes its isolated dependency directory.');
  visit(lock); visit(manifest.overrides);
}
function composerFiles(manifest, lock) {
  if (manifest.repositories !== undefined) throw new Error('Custom Composer repositories are unsupported; use public locked package archives.');
  if (Object.keys(manifest.config || {}).some(key => /(?:dir|home|auth|token|password)/i.test(key))) throw new Error('Composer cannot override installation paths or credentials.');
  for (const section of ['autoload', 'autoload-dev']) {
    const config = manifest[section] || {};
    if (config.files?.length) throw new Error('Composer root autoload.files needs project source; load project code explicitly from the experiment wrapper.');
    const paths = Object.values(config).flatMap(value => Array.isArray(value) ? value : typeof value === 'object' ? Object.values(value).flat() : [value]);
    if (paths.some(value => typeof value !== 'string' || path.posix.isAbsolute(value) || value.split('/').includes('..') || value.includes('\\'))) throw new Error('Composer project autoload paths must stay relative; use a separate wrapper for actual project source.');
  }
  if (!Array.isArray(lock.packages)) throw new Error('Composer requires a composer.lock packages array.');
  for (const item of [...lock.packages, ...(lock['packages-dev'] || [])]) {
    if (item.dist?.type !== 'zip' || !publicUrl(item.dist.url, ['api.github.com', 'github.com', 'codeload.github.com', 'repo.packagist.org', 'packagist.org'])) throw new Error('Composer dependencies require public HTTPS ZIP archives; path/VCS/private repositories are unsupported.');
    if (item.source?.url && !publicUrl(item.source.url, ['github.com', 'gitlab.com'])) throw new Error('Composer fallback source URLs must be public HTTPS repositories without credentials.');
  }
}

export async function runtimeRecipe(args, source) {
  const checked = validateToolArguments({ name: 'setup.install_deps', parameters: EXPERIMENT_RUNTIME_INSTALL_SCHEMA }, args);
  if (!checked.ok) throw new Error(checked.message);
  if (args.base_image && !runtimeImageReference(args.base_image)) throw new Error('Invalid runtime base image reference.');
  const packages = [...new Set(args.system_packages || [])].sort();
  if (packages.some(value => !/^[a-z0-9][a-z0-9+.-]{0,79}(?::[a-z0-9]+)?(?:=[A-Za-z0-9.+:~_-]+)?$/.test(value))) throw new Error('System packages must be Debian package names or pinned package=version values, never command options.');
  if (!packages.length && !args.npm && !args.pip && !args.composer) throw new Error('Declare at least one dependency to install.');
  const files = [], contents = {}; let bytes = 0;
  const load = async (name, expected) => {
    if (!name.startsWith('work/') || !safeSetupSource(name.slice(5)) || path.posix.basename(name) !== expected || !dependencyInventory(source).some(file => file.path === name)) throw new Error(`Use a safe frozen ${expected} from the source inventory.`);
    const text = await loadDependency(source, name);
    if (typeof text !== 'string' || Buffer.byteLength(text) > L.fileBytes || text.includes('\0')) throw new Error('Dependency input exceeds its bounded text limit.');
    bytes += Buffer.byteLength(text);
    if (bytes > L.filesBytes) throw new Error('Dependency inputs exceed the installation byte limit.');
    if (Object.hasOwn(contents, name)) throw new Error('Dependency projects must name distinct manifest and lockfile paths.');
    files.push({ path: name, sha256: fileDigest(text) }); contents[name] = text; return text;
  };
  for (const spec of runtimeProjects(args.npm)) {
    if (path.posix.dirname(spec.manifest) !== path.posix.dirname(spec.lockfile)) throw new Error('npm manifest and lockfile must be adjacent.');
    npmFiles(jsonObject(await load(spec.manifest, 'package.json')), jsonObject(await load(spec.lockfile, 'package-lock.json')));
  }
  for (const spec of runtimeProjects(args.pip)) {
    const requirements = await load(spec.requirements, 'requirements.txt');
    const lines = requirements.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
    if (!lines.length || lines.some(line => !/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9_,.-]+\])?==[A-Za-z0-9][A-Za-z0-9.!+_-]*$/.test(line))) throw new Error('pip supports pinned package[extras]==version lines only; no includes, options, local paths, URLs or editable projects.');
  }
  for (const spec of runtimeProjects(args.composer)) {
    if (path.posix.dirname(spec.manifest) !== path.posix.dirname(spec.lockfile)) throw new Error('Composer manifest and lockfile must be adjacent.');
    composerFiles(jsonObject(await load(spec.manifest, 'composer.json')), jsonObject(await load(spec.lockfile, 'composer.lock')));
  }
  const recipe = { ...structuredClone(args), system_packages: packages };
  for (const kind of ['npm', 'pip', 'composer']) if (recipe[kind]) {
    const entries = runtimeProjects(recipe[kind]).sort((a, b) => (a.manifest || a.requirements).localeCompare(b.manifest || b.requirements));
    recipe[kind] = entries.length === 1 ? entries[0] : entries;
  }
  return { recipe, files: files.sort((a, b) => a.path.localeCompare(b.path)), contents };
}

export function validateRuntimeReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object') throw new Error('Invalid runtime receipt.');
  const { receipt_digest, reused: _reused, ...body } = receipt;
  const checked = validateToolArguments({ name: 'runtime receipt recipe', parameters: EXPERIMENT_RUNTIME_INSTALL_SCHEMA }, body.recipe);
  if (body.schema !== EXPERIMENT_RUNTIME_RECEIPT_SCHEMA || !/^[a-f0-9]{64}$/.test(body.recipe_digest || '') || !/^sha256:[a-f0-9]{64}$/.test(body.image || '')
    || !/^sha256:[a-f0-9]{64}$/.test(body.recipe?.base_image || '') || body.base_image !== body.recipe.base_image || !Array.isArray(body.files)
    || !checked.ok || body.files.length > L.files || body.files.some(file => typeof file.path !== 'string' || !file.path.startsWith('work/') || !safeSetupSource(file.path.slice(5)) || !/^[a-f0-9]{64}$/.test(file.sha256))
    || receipt_digest !== experimentDigest(body) || body.recipe_digest !== experimentDigest({ schema: EXPERIMENT_RUNTIME_RECEIPT_SCHEMA, recipe: body.recipe, files: body.files })) throw new Error('Runtime receipt identity changed.');
  return receipt;
}
export async function runtimeSourcesMatch(receipt, source) {
  validateRuntimeReceipt(receipt);
  for (const file of receipt.files) {
    if (!file || typeof file.path !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256) || !dependencyInventory(source).some(item => item.path === file.path)) return false;
    try { if (fileDigest(await loadDependency(source, file.path)) !== file.sha256) return false; } catch { return false; }
  }
  return true;
}
