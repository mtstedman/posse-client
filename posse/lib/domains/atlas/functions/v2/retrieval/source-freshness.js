// @ts-check
import { sha256Hex } from "../hash.js";

/** Never apply indexed ranges to different source bytes. */
export function staleSymbolSource(target, source) {
  if (!target || source == null) return null;
  const actualHash = sha256Hex(source);
  if (target.content_hash === actualHash) return null;
  return {
    code: "index_drift",
    message: "Indexed symbol does not match the current file. Refresh the WI index or use a file-based code.lens lookup; stale symbol ranges were not read.",
    details: { file: target.repo_rel_path, indexedHash: target.content_hash, actualHash },
  };
}
