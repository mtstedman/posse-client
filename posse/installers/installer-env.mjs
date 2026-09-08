// Installer bridge: secrets travel through inherited environment or captured
// stdout, never command-line arguments or the installer command log.
import { INSTALLER_PROVIDER_KEY_NAMES } from "../lib/catalog/provider-credentials.js";
import { formatUserProviderEnv, readUserProviderEnv, saveUserProviderEnv } from "../lib/shared/platform/functions/user-provider-env.js";

const [action, ...names] = process.argv.slice(2);
try {
  if (action === "read-json") {
    process.stdout.write(JSON.stringify(readUserProviderEnv()));
  } else if (action === "read-null") {
    for (const [name, value] of Object.entries(readUserProviderEnv())) {
      process.stdout.write(`${name}=${value}\0`);
    }
  } else if (action === "save" || action === "format") {
    if (names.some((name) => !INSTALLER_PROVIDER_KEY_NAMES.includes(name))) throw new Error("Unknown credential name");
    const values = { ...readUserProviderEnv() };
    for (const name of names) if (process.env[name]) values[name] = process.env[name];
    if (action === "save") saveUserProviderEnv(values);
    else process.stdout.write(formatUserProviderEnv(values));
  } else {
    throw new Error("Expected read-json, read-null, save, or format");
  }
} catch {
  process.stderr.write("Could not read/write the private Posse .env file; check permissions and key formatting.\n");
  process.exitCode = 1;
}
