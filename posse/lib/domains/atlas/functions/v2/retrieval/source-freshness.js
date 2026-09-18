// @ts-check
import { sha256Hex } from "../hash.js";

/**
 * Never apply indexed ranges to different source bytes. A target that carries
 * no indexed content hash (a synthetic or file-only target) has nothing to
 * compare against and is not drift; only a recorded hash that disagrees with
 * the bytes on disk is.
 */
export function staleSymbolSource(target, source) {
  if (!target || source == null) return null;
  if (typeof target.content_hash !== "string" || !target.content_hash) return null;
  const actualHash = sha256Hex(source);
  if (target.content_hash === actualHash) return null;
  return {
    code: "index_drift",
    message: "Indexed symbol does not match the current file. Refresh the WI index or use a file-based code.lens lookup; stale symbol ranges were not read.",
    details: { file: target.repo_rel_path, indexedHash: target.content_hash, actualHash },
  };
}
