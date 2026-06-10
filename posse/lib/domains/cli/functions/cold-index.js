import fs from "fs";
import path from "path";

import { atlasDir, embeddingsRoot, ledgerDbPath, viewsDir } from "../../atlas/functions/v2/runtime-paths.js";
import { removeSqliteFile } from "../../atlas/functions/v2/view-health.js";
import { C } from "../../../shared/format/functions/colors.js";

// --cold-index: wipe the ATLAS/SCIP index artifacts before boot so the next
// run rebuilds from scratch (handy for watching a cold boot / reproducing
// indexing issues). Clears the per-repo ledger, embeddings, SCIP staged output
// and hidden staging temps, and views under <repo>/.posse/atlas/, but NOT
// account.db / settings / the ONNX model cache (models/ is preserved so we
// don't re-download the encoder).
export function clearColdIndex(projectDir = process.cwd()) {
  const resolvedProjectDir = path.resolve(projectDir || process.cwd());
  const root = atlasDir(resolvedProjectDir);
  const failures = [];
  let removed = 0;

  const recordFailure = (label, targetPath, err) => {
    failures.push({
      label,
      path: targetPath,
      error: err instanceof Error ? err : new Error(String(err)),
    });
  };

  const removeDirectory = (label, targetPath) => {
    const existed = fs.existsSync(targetPath);
    try {
      fs.rmSync(targetPath, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
      if (fs.existsSync(targetPath)) {
        recordFailure(label, targetPath, new Error("path still exists after removal"));
        return;
      }
      if (existed) removed += 1;
    } catch (err) {
      recordFailure(label, targetPath, err);
    }
  };

  const removeSqlite = (label, targetPath) => {
    const sidecars = [targetPath, `${targetPath}-wal`, `${targetPath}-shm`];
    const existed = sidecars.some((candidate) => fs.existsSync(candidate));
    try {
      removeSqliteFile(targetPath);
      const remaining = sidecars.find((candidate) => fs.existsSync(candidate));
      if (remaining) {
        recordFailure(label, targetPath, new Error(`${remaining} still exists after removal`));
        return;
      }
      if (existed) removed += 1;
    } catch (err) {
      recordFailure(label, targetPath, err);
    }
  };

  removeSqlite("ledger", ledgerDbPath(resolvedProjectDir));
  removeDirectory("embeddings", embeddingsRoot(resolvedProjectDir));
  removeDirectory("scip", path.join(root, "scip"));
  removeDirectory("views", viewsDir(resolvedProjectDir));

  if (failures.length > 0) {
    const detail = failures
      .map((failure) => `${failure.label} (${failure.path}): ${failure.error.message}`)
      .join("; ");
    const err = new Error(`--cold-index failed to clear ATLAS index at ${root}: ${detail}`);
    /** @type {any} */ (err).failures = failures;
    throw err;
  }

  console.log(`  ${C.yellow}--cold-index:${C.reset} cleared ATLAS index at ${C.dim}${root}${C.reset} (models preserved; SCIP staging/view DB removed).`);
  return { root, removed };
}
