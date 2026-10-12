// @ts-check

import fs from "node:fs";
import path from "node:path";

export function firstMissingAncestor(directory) {
  let missing = null;
  let cursor = directory;
  while (!fs.existsSync(cursor)) {
    missing = cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return missing;
}

export function removeEmptyDirectories(directory, stopAt) {
  if (!stopAt) return;
  let cursor = directory;
  for (;;) {
    try {
      fs.rmdirSync(cursor);
    } catch {
      return;
    }
    if (cursor === stopAt) return;
    cursor = path.dirname(cursor);
  }
}
