// @ts-check

import fs from "fs";
import path from "path";
import { bucketPathsByLanguage } from "./language-buckets.js";
import { emitParseEvent } from "./events.js";

const SKIP_DIRS = new Set([".git", ".posse", ".posse-worktrees", ".posse-test-suites", "node_modules", "vendor", "dist", "build", "target"]);

/**
 * @param {{ repoRoot?: string, onEvent?: ((event: { kind: string, [k: string]: unknown }) => void) | null }} [args]
 */
export async function discoverParseFiles({ repoRoot, onEvent } = {}) {
  const root = path.resolve(String(repoRoot || process.cwd()));
  emitParseEvent(onEvent, { kind: "atlas.parse.discover.started" });
  const paths = [];
  await walk(root, "");
  const buckets = bucketPathsByLanguage(paths);
  const totals = Object.fromEntries([...buckets.entries()].map(([lang, files]) => [lang, files.length]));
  emitParseEvent(onEvent, { kind: "atlas.parse.discover.completed", totals, durationMs: null });
  return { paths, buckets, totals };

  async function walk(absDir, relDir) {
    let entries = [];
    try { entries = await fs.promises.readdir(absDir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(path.join(absDir, entry.name), relDir ? `${relDir}/${entry.name}` : entry.name);
      } else if (entry.isFile()) {
        paths.push(relDir ? `${relDir}/${entry.name}` : entry.name);
      }
    }
  }
}
