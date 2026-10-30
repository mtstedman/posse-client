import fs from "node:fs";
import path from "node:path";
import { adminGitExec } from "../../git/functions/admin-git-exec.js";
import { ATLAS_INDEXABLE_SOURCE_EXTENSIONS } from "../../../catalog/files.js";
import { WORKSPACE_TRAVERSAL_PROFILES } from "../../../catalog/workspace-traversal.js";

// Repository property only: no task text, repository names, or corpus flags.
// The sorted file list is included only while the repository is small enough
// for the direct route (the sole reader, routing.js, gates on the same
// threshold); a larger repository carries its file count instead, so the
// persisted project map and the preflight payload stay bounded.
export function repositorySourceInventory(projectDir, { sourceListMaxBytes = Infinity } = {}) {
  if (!projectDir) return null;
  try {
    const listed = String(adminGitExec(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], projectDir));
    const files = [];
    let bytes = 0;
    for (const file of new Set(listed.split("\0").filter(Boolean))) {
      if (!ATLAS_INDEXABLE_SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase())
        || file.split("/").some(part => WORKSPACE_TRAVERSAL_PROFILES.unit_tests.has(part))) continue;
      const stat = fs.lstatSync(path.join(projectDir, file));
      if (!stat.isFile()) continue;
      bytes += stat.size;
      files.push(file);
    }
    return bytes <= sourceListMaxBytes
      ? { eligible_source_bytes: bytes, source_files: files.sort() }
      : { eligible_source_bytes: bytes, source_file_count: files.length };
  } catch { return null; } // Unknown size never becomes a small-repository decision.
}
