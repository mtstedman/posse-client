import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Vitest CLI file filters are substring/prefix matches, even for absolute
// paths. Select exact specifications before importing any test modules, while
// retaining the installed runner's config, projects, pools and setup hooks.
export async function runExactVitestFile(api, file, args) {
  if (typeof api.createVitest !== "function" || typeof api.parseCLI !== "function") {
    throw new Error("Posse Vitest adapter unavailable: installed Vitest lacks the public runner API");
  }
  const { options } = api.parseCLI(["vitest", "run", ...args]);
  const context = await api.createVitest("test", { ...options, run: true, watch: false });
  try {
    if (!["init", "globTestSpecifications", "runTestSpecifications", "close"].every((name) => typeof context[name] === "function")) {
      throw new Error("Posse Vitest adapter unavailable: installed Vitest lacks exact specification execution");
    }
    await context.init();
    const target = path.resolve(file);
    const discovered = await context.globTestSpecifications();
    if (!Array.isArray(discovered) || discovered.some((specification) => typeof specification?.moduleId !== "string")) {
      throw new Error("Posse Vitest adapter unavailable: installed Vitest returned unsupported specifications");
    }
    const specifications = discovered.filter((specification) => path.resolve(specification.moduleId) === target);
    if (!specifications.length) {
      console.error("No test files found");
      process.exitCode = 1;
      return;
    }
    await context.runTestSpecifications(specifications);
  } finally {
    await context.close?.();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [apiPath, file, ...args] = process.argv.slice(2);
  // Match Vitest's CLI preparation without introducing a dependency on Posse's
  // own install or downloading missing framework/environment packages.
  process.env.TEST = "true";
  process.env.VITEST = "true";
  process.env.NODE_ENV ??= "test";
  try {
    const api = await import(pathToFileURL(apiPath).href);
    await runExactVitestFile(api, file, args);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
