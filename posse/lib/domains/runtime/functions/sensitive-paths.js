import fs from "node:fs";
import path from "node:path";

import { realpathExistingPrefix } from "./fs-safety.js";

const SENSITIVE_ENV_BASENAME_RE = /^\.env(?:\.|$)/i;

export function isSensitiveEnvFilePath(filePath) {
  return SENSITIVE_ENV_BASENAME_RE.test(path.basename(String(filePath || "")));
}

export function isSensitiveEnvFileOrTargetPath(filePath) {
  const resolved = path.resolve(String(filePath || ""));
  if (isSensitiveEnvFilePath(resolved)) return true;
  try {
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink()) {
      try {
        if (isSensitiveEnvFilePath(fs.realpathSync.native(resolved))) return true;
      } catch {
        return false;
      }
    }
  } catch {
    // Missing paths fall through to existing-prefix resolution below.
  }
  try {
    const realTarget = realpathExistingPrefix(resolved);
    return realTarget !== resolved && isSensitiveEnvFilePath(realTarget);
  } catch {
    return false;
  }
}
