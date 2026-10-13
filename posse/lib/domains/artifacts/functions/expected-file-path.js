import path from "node:path";
import { isInsideRoot } from "../../runtime/functions/fs-safety.js";

// Assessment and job execution must interpret manifest targets identically.
// Outside-root targets keep the existing basename comparison contract.
export function resolveExpectedFilePath(outputRoot, file) {
  const rootAbs = path.resolve(outputRoot);
  const fileAbs = path.resolve(file);
  const rel = path.relative(rootAbs, fileAbs).replace(/\\/g, "/");
  return isInsideRoot(fileAbs, rootAbs, { allowEqual: false }) ? rel : path.posix.basename(file);
}
