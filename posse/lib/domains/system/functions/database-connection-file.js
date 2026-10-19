import fs from "node:fs";
import path from "node:path";
import { localPath } from "./environment-paths.js";
import { listIgnoredRepoPaths } from "../../git/functions/ignored-paths.js";

// Connection source comes from the planner/developer in the application's
// language. Setup never reads credentials into it or executes it. Approval
// includes the complete file, just like the other proposed setup writes.
export async function prepareDatabaseConnectionFile(connection, cwd, capture, { reservedPaths = [], assertWritable } = {}) {
  if (connection === undefined) return null;
  if (!connection || typeof connection !== "object" || Array.isArray(connection)
    || typeof connection.content !== "string" || !connection.content.trim()
    || Buffer.byteLength(connection.content) > 16 * 1024 || connection.content.includes("\0")) {
    throw new Error("Provide a new connection source file with nonempty text no larger than 16 KB.");
  }
  const file = localPath(cwd, connection.path);
  const relative = path.relative(cwd, file).replaceAll(path.sep, "/");
  if (reservedPaths.includes(relative)) throw new Error("The connection module must be separate from other setup files.");
  if (fs.existsSync(file)) throw new Error("Connection file already exists. Reuse the application's existing connector; setup never replaces it.");
  if ((await listIgnoredRepoPaths(cwd, [relative])).length) throw new Error("The connection source must be committable, not an ignored configuration or runtime file.");
  assertWritable?.(file);
  capture(relative, { writable: true });
  return { path: relative, content: connection.content };
}
