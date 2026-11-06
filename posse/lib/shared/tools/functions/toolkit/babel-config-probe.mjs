import { createRequire } from "node:module";
import path from "node:path";

// Run repository configuration in a bounded child, never in the orchestrator.
const [core, config] = process.argv.slice(2);
const require = createRequire(import.meta.url);
let result;
try {
  const babel = require(core);
  const loaded = await babel.loadPartialConfigAsync({
    cwd: process.cwd(), configFile: config, babelrc: false, envName: "test",
    filename: path.join(path.dirname(config), "__posse_config_probe__.js"),
    caller: { name: "babel-jest", supportsStaticESM: false },
  });
  result = loaded ? { status: "passed" }
    : { status: "unavailable", message: "Babel configuration excludes the validation input" };
} catch (error) {
  result = { status: "failed", message: String(error?.message || error), line: error?.loc?.line || null };
}
process.stdout.write(`\n${JSON.stringify(result)}\n`);
