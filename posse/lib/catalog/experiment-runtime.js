const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const sourcePath = { type: 'string', minLength: 6, maxLength: 240, pattern: '^work/' };
export const EXPERIMENT_RUNTIME_RECEIPT_SCHEMA = 'posse.experiment.runtime-install.v1';
export const EXPERIMENT_RUNTIME_INSTALL_LIMITS = { wallSeconds: 900, memoryMB: 2048, cpus: 2, pids: 128, outputBytes: 1048576, fileBytes: 262144, filesBytes: 1048576, packages: 64, receiptBytes: 32768 };
export const EXPERIMENT_RUNTIME_BASE_IMAGES = { node: 'node:24-bookworm-slim', python: 'python:3.12-slim' };
export const EXPERIMENT_RUNTIME_INSTALL_SCHEMA = object({
  profile: { enum: ['node', 'python'] }, base_image: { type: 'string', minLength: 1, maxLength: 240 },
  system_packages: { type: 'array', maxItems: 64, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 160 } },
  npm: object({ manifest: sourcePath, lockfile: sourcePath }), pip: object({ requirements: sourcePath }), composer: object({ manifest: sourcePath, lockfile: sourcePath }),
}, ['profile']);
export const EXPERIMENT_INSTALL_DEPS_TOOL = { name: 'setup.install_deps', description: 'Install declared dependencies into an isolated reusable runtime image, never the host repository. Choose node or python; optional Debian system_packages, npm package.json + package-lock.json, pinned pip requirements.txt, or Composer composer.json + composer.lock from frozen work/ source paths. Uses public registries only; no local/workspace dependencies or credentials. npm includes dev dependencies with lifecycle scripts disabled; pip accepts pinned wheel packages; Composer disables scripts/plugins. Returns immutable image, source hashes and import/autoload paths. Actual experiments remain network-off.', parameters: EXPERIMENT_RUNTIME_INSTALL_SCHEMA };
export const EXPERIMENT_RUNTIME_PATHS = { root: '/posse-runtime', npm: '/node_modules', python: '/posse-runtime/python', composer: '/posse-runtime/composer/vendor/autoload.php' };
