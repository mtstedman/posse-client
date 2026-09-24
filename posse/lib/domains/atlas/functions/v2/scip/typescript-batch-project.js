// @ts-check
//
// Repository-aware TypeScript project for an isolated SCIP batch view.
//
// A batch view holds only its batch's files. Its tsconfig extends the
// repository tsconfig (paths, target, lib, ...) and maps the view onto the
// repository with `rootDirs`, so imports into other batches resolve to the real
// repository files. Every ancestor `package.json` of a batch file is copied into
// the view, so scip-typescript names a definition identically whether the file
// is indexed in its own batch or referenced from another one; that identity is
// what cross-batch binding joins on.

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * @typedef {{ mode: "isolated" }
 *   | { mode: "repository", extendsPath: string | null, forceCommonjs: boolean }
 *   | { mode: "invalid", error: string }} TypeScriptBatchProject
 */

/**
 * Decide the batch-view project for one TypeScript stage plan. Repositories
 * without a root package.json keep the isolated view: their definitions have no
 * stable package identity across views. A repository tsconfig TypeScript cannot
 * load makes the project invalid instead of silently indexing without it.
 *
 * @param {string} repoRoot
 * @param {{ command: string }} plan
 * @returns {TypeScriptBatchProject}
 */
export function resolveTypeScriptBatchProject(repoRoot, plan) {
  if (!fs.existsSync(path.join(repoRoot, "package.json"))) return { mode: "isolated" };
  const tsconfigPath = path.join(repoRoot, "tsconfig.json");
  // The portable adapter exists for repositories whose tsconfig cannot load
  // (an uninstalled preset). It builds its own project from the view's files
  // and rootDirs, so the repository tsconfig is never extended there.
  if (!fs.existsSync(tsconfigPath) || path.basename(plan.command).startsWith("scip-typescript-portable")) {
    return { mode: "repository", extendsPath: null, forceCommonjs: false };
  }
  let ts;
  try {
    // Evaluate with the compiler the indexer itself runs.
    ts = createRequire(fs.realpathSync(plan.command))("typescript");
  } catch (err) {
    return {
      mode: "invalid",
      error: `cannot load the TypeScript compiler of ${plan.command}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const read = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  const parsed = read.error ? null : ts.parseJsonConfigFileContent(read.config, ts.sys, repoRoot, undefined, tsconfigPath);
  // TS18003 (no inputs) is irrelevant: the batch view supplies its own files.
  const errors = read.error ? [read.error] : parsed.errors.filter((/** @type {any} */ error) => error.code !== 18003);
  if (errors.length > 0) {
    return {
      mode: "invalid",
      error: `repository tsconfig.json cannot be loaded: ${ts.flattenDiagnosticMessageText(errors[0].messageText, " ")}`,
    };
  }
  const options = parsed.options;
  // Without an explicit module, a modern target selects an ES module kind and
  // with it classic resolution, which cannot see package entry points.
  const forceCommonjs = options.module === undefined
    && options.moduleResolution === undefined
    && ts.getEmitModuleResolutionKind(options) === ts.ModuleResolutionKind.Classic;
  return { mode: "repository", extendsPath: tsconfigPath, forceCommonjs };
}

/**
 * Write the repository-aware project into a batch view.
 *
 * @param {{ repoRoot: string, viewRoot: string, paths: string[], project: { extendsPath: string | null, forceCommonjs: boolean } }} args
 */
export async function writeTypeScriptBatchProject({ repoRoot, viewRoot, paths, project }) {
  const directories = new Set([""]);
  for (const repoRelPath of paths) {
    for (let dir = path.posix.dirname(repoRelPath); dir !== "." && !directories.has(dir); dir = path.posix.dirname(dir)) {
      directories.add(dir);
    }
  }
  for (const dir of directories) {
    const source = path.join(repoRoot, dir, "package.json");
    if (!fs.existsSync(source)) continue;
    await fs.promises.mkdir(path.join(viewRoot, dir), { recursive: true });
    await fs.promises.copyFile(source, path.join(viewRoot, dir, "package.json"));
  }
  await fs.promises.writeFile(path.join(viewRoot, "tsconfig.json"), JSON.stringify({
    ...(project.extendsPath ? { extends: project.extendsPath } : {}),
    compilerOptions: {
      allowJs: true,
      rootDirs: [viewRoot, repoRoot],
      ...(project.forceCommonjs ? { module: "commonjs" } : {}),
    },
    include: [],
    files: paths,
  }), "utf8");
}
