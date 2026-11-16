// pnpm serializes false npm_config values as empty strings for lifecycle
// scripts. Reapply this at every entry, including nested `pnpm` commands, so
// verification cannot silently download/switch package-manager versions.
const entry = require.resolve('./node_modules/pnpm/bin/pnpm.cjs');
const result = require('node:child_process').spawnSync(process.execPath, [entry, ...process.argv.slice(2)], {
  env: { ...process.env, npm_config_manage_package_manager_versions: 'false' },
  stdio: 'inherit',
  windowsHide: true,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
