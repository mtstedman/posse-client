import fs from "fs";
import path from "path";

export function createTextMutationHelpers() {
  function removeFileBestEffort(filePath) {
    try { fs.unlinkSync(filePath); } catch { /* best effort cleanup */ }
  }

  function writeTextFileAtomic(filePath, content) {
    const tempPath = path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
    );
    try {
      const existing = fs.statSync(filePath, { throwIfNoEntry: false });
      fs.writeFileSync(tempPath, content, "utf-8");
      if (existing) fs.chmodSync(tempPath, existing.mode);
      fs.renameSync(tempPath, filePath);
    } catch {
      removeFileBestEffort(tempPath);
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
