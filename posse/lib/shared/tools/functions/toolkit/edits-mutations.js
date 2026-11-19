import fs from "fs";
import path from "path";

import { realpathExistingPrefix } from "../../../../domains/runtime/functions/fs-safety.js";

// The in-place rewrite is the fallback only when the temp-and-rename route is
// itself refused: a locked file or sticky directory (EACCES, EPERM, EBUSY), a
// single-file bind mount (EXDEV, EBUSY), or a temp name past the name limit.
// Any other failure (ENOSPC, EIO, EDQUOT, EROFS, EISDIR) would fail the same
// way in place after truncating the original, so it is rethrown instead.
const IN_PLACE_FALLBACK_CODES = new Set(["EACCES", "EPERM", "EBUSY", "EXDEV", "ENAMETOOLONG"]);

export function createTextMutationHelpers() {
  function removeFileBestEffort(filePath) {
    try { fs.unlinkSync(filePath); } catch { /* best effort cleanup */ }
  }

  // A file symlink is written through: the temp is renamed over the file the
  // link names, so `CLAUDE.md -> AGENTS.md` stays a link (decision E1). Callers
  // judge the boundary and scope on that same resolved path. A hardlink is
  // split instead: the rename gives this name a new inode and leaves the other
  // names as they were, because they may lie outside the workspace (a pnpm
  // store, a cp -al tree) where no check could vouch for an in-place write.
  function writeTextFileAtomic(lexicalPath, content) {
    const filePath = realpathExistingPrefix(lexicalPath);
    const tempPath = path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
    );
    try {
      const existing = fs.statSync(filePath, { throwIfNoEntry: false });
      fs.writeFileSync(tempPath, content, "utf-8");
      if (existing) fs.chmodSync(tempPath, existing.mode);
      fs.renameSync(tempPath, filePath);
    } catch (err) {
      removeFileBestEffort(tempPath);
      if (!IN_PLACE_FALLBACK_CODES.has(err?.code)) throw err;
      fs.writeFileSync(filePath, content, "utf-8");
    }
  }

  function setFileExecutable(filePath, executable) {
    const stat = fs.statSync(filePath);
    const permissions = stat.mode & 0o7777;
    const nextPermissions = executable ? permissions | 0o111 : permissions & ~0o111;
    if (nextPermissions !== permissions) fs.chmodSync(filePath, nextPermissions);
  }

  return { writeTextFileAtomic, setFileExecutable };
}
