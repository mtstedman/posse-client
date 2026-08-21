// @ts-check

import fs from "node:fs";
import path from "node:path";

export const SCIP_BATCH_COVERAGE_SCHEMA_VERSION = 2;
export const SCIP_BATCH_COVERAGE_FILENAME = "batch-coverage.json";

export function scipBatchCoveragePath(scipDir) {
  return path.join(path.resolve(String(scipDir || "")), SCIP_BATCH_COVERAGE_FILENAME);
}

/**
 * Persist the exact source documents whose path-preserving SCIP batches were
 * acknowledged by ledger intake, beside the documents this generation
 * attempted and could not durably record. Boot readiness combines this receipt
 * with the ledger's current branch snapshot and immutable blob layers; the
 * receipt alone never proves coverage.
 *
 * `unavailable_documents` is the typed failure signal. A schema-1 receipt
 * could not express it, so schema 1 is not readable here: an unreadable
 * receipt costs one re-derivation, while trusting one would let a document
 * that failed staging or intake pass as examined.
 *
 * @param {{ scipDir: string, head: string, filesetHash: string, documents: Array<{ repo_rel_path: string, content_hash: string, source_languages?: string[] }>, unavailableDocuments?: Array<{ repo_rel_path: string, content_hash?: string, reason?: string, source_languages?: string[] }> }} input
 */
export async function writeScipBatchCoverage(input) {
  const outputPath = scipBatchCoveragePath(input.scipDir);
  const acknowledgedPaths = new Set();
  const documents = (Array.isArray(input.documents) ? input.documents : []).map((document) => {
    const repoRelPath = String(document?.repo_rel_path || "");
    acknowledgedPaths.add(repoRelPath);
    return {
      repo_rel_path: repoRelPath,
      content_hash: String(document?.content_hash || "").toLowerCase(),
      source_languages: normalizedSourceLanguages(document?.source_languages),
    };
  });
  const receipt = {
    schema_version: SCIP_BATCH_COVERAGE_SCHEMA_VERSION,
    status: "complete",
    head: String(input.head || "").trim().toLowerCase(),
    fileset_hash: String(input.filesetHash || ""),
    completed_at: new Date().toISOString(),
    documents,
    // A path can never be both. An acknowledged row is the stronger claim and
    // is only recorded after this generation proved intake for that hash, so
    // it wins over a stale unavailable row for the same path.
    unavailable_documents: (Array.isArray(input.unavailableDocuments) ? input.unavailableDocuments : [])
      .map((document) => ({
        repo_rel_path: String(document?.repo_rel_path || ""),
        content_hash: String(document?.content_hash || "").toLowerCase(),
        reason: String(document?.reason || "unavailable"),
        source_languages: normalizedSourceLanguages(document?.source_languages),
      }))
      .filter((document) => document.repo_rel_path && !acknowledgedPaths.has(document.repo_rel_path))
      .sort((a, b) => Buffer.from(a.repo_rel_path).compare(Buffer.from(b.repo_rel_path))),
  };
  if (!/^[0-9a-f]{40,64}$/u.test(receipt.head)) {
    return { ok: false, path: outputPath, error: "batch coverage head is invalid" };
  }
  const tempPath = `${outputPath}.${process.pid}.${Date.now()}.staging`;
  try {
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.promises.writeFile(tempPath, `${JSON.stringify(receipt)}\n`, "utf8");
    await replaceFile(tempPath, outputPath);
    return { ok: true, path: outputPath, receipt };
  } catch (err) {
    return { ok: false, path: outputPath, error: err?.message || String(err) };
  } finally {
    try { await fs.promises.rm(tempPath, { force: true }); } catch { /* best effort */ }
  }
}

export async function readScipBatchCoverage(scipDir) {
  const inputPath = scipBatchCoveragePath(scipDir);
  try {
    const parsed = JSON.parse(await fs.promises.readFile(inputPath, "utf8"));
    if (Number(parsed?.schema_version) !== SCIP_BATCH_COVERAGE_SCHEMA_VERSION) return null;
    if (parsed?.status !== "complete" || !/^[0-9a-f]{40,64}$/u.test(String(parsed?.head || ""))) return null;
    if (!Array.isArray(parsed?.documents)) return null;
    // Fail closed on a receipt that cannot state what it failed to record.
    if (!Array.isArray(parsed?.unavailable_documents)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function normalizedSourceLanguages(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean))].sort();
}

async function replaceFile(from, to) {
  try {
    await fs.promises.rename(from, to);
    return;
  } catch (err) {
    try { await fs.promises.access(to); } catch { throw err; }
  }
  const backup = `${to}.bak-${process.pid}-${Date.now()}`;
  await fs.promises.rename(to, backup);
  try {
    await fs.promises.rename(from, to);
    try { await fs.promises.rm(backup, { force: true }); } catch { /* best effort */ }
  } catch (err) {
    try { await fs.promises.rename(backup, to); } catch { /* best effort */ }
    throw err;
  }
}
