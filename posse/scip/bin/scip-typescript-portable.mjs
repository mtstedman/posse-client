#!/usr/bin/env node
// Portable TypeScript SCIP adapter for source fixtures that cannot load their
// repository tsconfig without an uninstalled external preset, or whose test
// corpus intentionally contains parser-invalid syntax. It builds an isolated
// tracked-source project and never changes the target worktree.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const upstream = path.resolve(
  here,
  "..",
  "node",
  "node_modules",
  ".bin",
  process.platform === "win32" ? "scip-typescript.cmd" : "scip-typescript",
);
const repoRoot = process.cwd();
const args = process.argv.slice(2);

if (!fs.existsSync(upstream)) {
  console.error(`Posse portable TypeScript SCIP runtime is not installed: ${upstream}`);
  process.exit(1);
}

const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const excludedSegments = new Set([
  "test", "tests", "test-d", "__tests__", "fixture", "fixtures",
  "example", "examples", "benchmark", "benchmarks", "playground",
  "node_modules", "vendor", "dist", "build", "coverage", "target",
]);

function isSourcePath(relative) {
  const normalized = relative.replaceAll("\\", "/");
  return sourceExtensions.has(path.extname(normalized).toLowerCase());
}

function batchProjectFiles() {
  try {
    const project = JSON.parse(fs.readFileSync(path.join(repoRoot, "tsconfig.json"), "utf8"));
    if (!Array.isArray(project?.files) || project.files.length === 0) return [];
    return project.files
      .map((value) => String(value || "").replaceAll("\\", "/"))
      .filter((relative) => relative
        && !path.isAbsolute(relative)
        && !relative.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
        && isSourcePath(relative))
      .filter((relative) => fs.statSync(path.join(repoRoot, relative), { throwIfNoEntry: false })?.isFile());
  } catch {
    return [];
  }
}

function filesystemSourceFiles() {
  const found = [];
  const pending = [{ absolute: repoRoot, relative: "" }];
  let visitedDirectories = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    visitedDirectories += 1;
    if (visitedDirectories > 5_000 || found.length > 20_000) {
      throw new Error("portable TypeScript source discovery exceeded its isolated-project bound");
    }
    const entries = fs.readdirSync(current.absolute, { withFileTypes: true })
      .sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!excludedSegments.has(entry.name.toLowerCase()) && entry.name !== ".git" && entry.name !== ".posse") {
          pending.push({ absolute: path.join(current.absolute, entry.name), relative });
        }
      } else if (entry.isFile() && isSourcePath(relative)) {
        found.push(relative);
      }
    }
  }
  return found;
}

let candidates;
let isolatedBatch = false;
const batchFiles = batchProjectFiles();
if (batchFiles.length > 0) {
  // Batch views are created beneath <repo>/.posse, so Git can successfully
  // resolve the PARENT worktree from their cwd. The explicit files manifest is
  // the authority here; consulting `git ls-files` first would index unrelated
  // parent sources (or report no files because the view itself is ignored).
  isolatedBatch = true;
  candidates = batchFiles;
} else {
  const tracked = spawnSync("git", ["ls-files", "-z", "--cached"], {
    cwd: repoRoot,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  candidates = tracked.status === 0
    ? tracked.stdout.toString("utf8").split("\0").filter(Boolean)
    : filesystemSourceFiles();
}
candidates = candidates.filter((relative) => {
  const normalized = relative.replaceAll("\\", "/");
  if (!isSourcePath(normalized)) return false;
  if (isolatedBatch) return true;
  const segments = normalized.toLowerCase().split("/");
  return !segments.some((segment) => excludedSegments.has(segment));
});
const preferred = candidates.filter((relative) => {
  const normalized = relative.replaceAll("\\", "/");
  const segments = normalized.toLowerCase().split("/");
  return segments.length === 1 || segments.includes("src") || segments.includes("source");
});
const selected = isolatedBatch ? candidates : (preferred.length > 0 ? preferred : candidates);
if (selected.length === 0) {
  console.error("Posse portable TypeScript SCIP adapter found no source files");
  process.exit(1);
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "posse-scip-typescript-"));
const project = path.join(temporary, "tsconfig.json");
try {
  fs.writeFileSync(project, `${JSON.stringify({
    compilerOptions: {
      allowJs: true,
      allowSyntheticDefaultImports: true,
      checkJs: false,
      emitDecoratorMetadata: true,
      esModuleInterop: true,
      experimentalDecorators: true,
      module: "commonjs",
      moduleResolution: "node",
      noEmit: true,
      resolveJsonModule: true,
      skipLibCheck: true,
      strict: false,
      target: "ES2022",
      useDefineForClassFields: false,
    },
    files: selected.map((relative) => path.join(repoRoot, relative)),
  }, null, 2)}\n`, "utf8");
  const forwarded = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--infer-tsconfig") continue;
    forwarded.push(args[index]);
  }
  if (!forwarded.includes("--max-file-byte-size")) {
    // Compiler repositories legitimately keep multi-megabyte production
    // translation units (for example TypeScript's checker.ts). The upstream
    // 1 MB default would silently turn a successful fallback into a partial
    // semantic index.
    forwarded.push("--max-file-byte-size", "8mb");
  }
  forwarded.push("--no-global-caches", project);
  const command = process.platform === "win32"
    ? (process.env.ComSpec || process.env.COMSPEC || "cmd.exe")
    : upstream;
  const commandArgs = process.platform === "win32"
    ? ["/d", "/c", upstream, ...forwarded]
    : forwarded;
  const child = spawn(command, commandArgs, {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  child.on("error", (error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
  const code = await new Promise((resolve) => child.on("close", resolve));
  process.exitCode = Number(code) || 0;
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
