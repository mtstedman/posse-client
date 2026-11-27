const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const sourcePath = { type: 'string', minLength: 6, maxLength: 240, pattern: '^work/' };
const projects = schema => ({ oneOf: [schema, { type: 'array', minItems: 1, maxItems: 16, items: schema }] });
export const EXPERIMENT_RUNTIME_RECEIPT_SCHEMA = 'posse.experiment.runtime-install.v1';
export const EXPERIMENT_RUNTIME_NODE_MODULES_LABEL = 'posse.experiment.runtime.node-modules';
export const EXPERIMENT_RUNTIME_INSTALL_LIMITS = { wallSeconds: 900, memoryMB: 2048, cpus: 2, pids: 128, outputBytes: 1048576, fileBytes: 1048576, filesBytes: 8388608, files: 80, packages: 64, receiptBytes: 131072 };
export const EXPERIMENT_RUNTIME_BASE_IMAGES = { node: 'node:24-bookworm-slim', python: 'python:3.12-slim' };
export const EXPERIMENT_RUNTIME_INSTALL_SCHEMA = object({
  profile: { enum: ['node', 'python'] }, base_image: { type: 'string', minLength: 1, maxLength: 240 },
  system_packages: { type: 'array', maxItems: 64, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 160 } },
  npm: projects(object({ manifest: sourcePath, lockfile: sourcePath })), pip: projects(object({ requirements: sourcePath })), composer: projects(object({ manifest: sourcePath, lockfile: sourcePath })),
}, ['profile']);
export const EXPERIMENT_INSTALL_DEPS_TOOL = { name: 'setup.install_deps', description: 'Add missing dependencies to the prepared reusable runtime image, preserving its existing dependencies. Repository dependencies are installed deterministically before setup starts; request only additions. Omit profile when a runtime is already prepared, otherwise choose node or python. Optional Debian system_packages, npm package.json + package-lock.json, pinned pip requirements, or Composer composer.json + composer.lock from frozen work/ source paths. Each manager accepts one object or up to sixteen project objects. npm/Composer projects remain separate; pip requirements resolve together. Uses public registries only; no local/workspace dependencies or credentials. npm includes dev dependencies with lifecycle scripts disabled; pip accepts pinned wheel packages; Composer disables scripts/plugins. Returns immutable image and project import/autoload paths. Actual experiments remain network-off.', parameters: { ...EXPERIMENT_RUNTIME_INSTALL_SCHEMA, required: [] } };
export const EXPERIMENT_RUNTIME_PATHS = { root: '/posse-runtime', npm: '/node_modules', python: '/posse-runtime/python', composer: '/posse-runtime/composer/vendor/autoload.php' };
