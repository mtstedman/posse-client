import fs from "node:fs/promises";
import path from "node:path";
import { isPosseRuntimePath, isPosseRuntimeOnlyGitignoreContent } from "../../../runtime/functions/ignore.js";

const MAX_BOOTSTRAP_IGNORE_BYTES = 16 * 1024;

// A zero-hit index query is not proof of an empty checkout. Only skip
// discovery when the current root contains bootstrap metadata alone. Any
// other entry (including docs, hidden files, directories and symlinks) keeps
// normal prefetch. Do not cache this: a developer may just have added files.
export async function isBootstrapOnlyRepository(cwd) {
  if (!cwd) return false;
  try {
    const root = await fs.opendir(cwd);
    for await (const entry of root) {
      if (entry.name === ".git" || isPosseRuntimePath(entry.name)) continue;
      if (entry.name !== ".gitignore" || !entry.isFile()) return false;
      const file = await fs.open(path.join(cwd, entry.name), "r");
      try {
        const buffer = Buffer.alloc(MAX_BOOTSTRAP_IGNORE_BYTES + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length > MAX_BOOTSTRAP_IGNORE_BYTES
          || !isPosseRuntimeOnlyGitignoreContent(cwd, buffer.toString("utf8", 0, length))) return false;
      } finally {
        await file.close();
      }
    }
    return true;
  } catch {
    // Missing or unreadable entries mean unknown, not empty.
    return false;
  }
}
