// @ts-check
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { View } from "../../classes/v2/View.js";
import { prepareCanonicalViewForReplacement } from "../../classes/v2/ViewBuilder.js";
import { viewCanServeBranch } from "./view-can-serve.js";
import { openViewWithMeta, removeSqliteFile } from "./view-health.js";

/** @typedef {import("../../classes/v2/Ledger.js").Ledger} Ledger */
/** @typedef {import("../../classes/v2/ViewBuilder.js").ViewBuilder} ViewBuilder */

function createCloneStagingPath(destPath) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  return path.join(
    path.dirname(destPath),
    `.${path.basename(destPath)}.${process.pid}.${randomUUID()}.cloning`,
  );
}

function publishStagedViewClone(stagedPath, destPath) {
  const sidecars = ["-wal", "-shm", "-journal"]
    .map((suffix) => stagedPath + suffix)
    .filter((candidate) => fs.existsSync(candidate));
  if (sidecars.length > 0) {
    throw new Error(`staged view clone retained SQLite sidecars: ${sidecars.join(", ")}`);
  }
  if (fs.existsSync(destPath)) prepareCanonicalViewForReplacement(destPath);
  fs.renameSync(stagedPath, destPath);
}

/**
 * Patch the meta table on an already-built view file to point at a
 * different branch / lineage. Used when a warmed view originally
 * targeted main is mounted into a worktree whose ledger branch has now
 * been forked off main. Symbol IDs and edges remain valid because they
 * are content-addressed.
 *
 * @param {string} viewPath
 * @param {{ branch: string, parent_branch?: string | null, parent_seq?: number | null, ledger_seq?: number, built_at?: string }} meta
 */
function patchViewBranchMeta(viewPath, meta) {
  const view = View.mount({ dbPath: viewPath, mode: "readwrite" });
  try {
    const db = view._unsafeDb();
    const set = db.prepare(
      "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    const del = db.prepare("DELETE FROM meta WHERE key = ?");
    db.transaction(() => {
      set.run("branch", meta.branch);
      set.run("built_at", meta.built_at || new Date().toISOString());
      if (meta.parent_branch) set.run("parent_branch", meta.parent_branch);
      else del.run("parent_branch");
      if (meta.parent_seq != null) set.run("parent_seq", String(meta.parent_seq));
      else del.run("parent_seq");
      if (Number.isInteger(meta.ledger_seq)) set.run("ledger_seq", String(meta.ledger_seq));
    }).immediate();
  } finally {
    view.close();
  }
}

/**
 * Clone and optionally rebrand a view entirely under a staging name. The
 * canonical destination appears only after SQLite is closed and no recovery
 * sidecar remains, so interruption cannot poison the consumer-visible cache.
 *
 * @param {ViewBuilder} builder
 * @param {string} sourcePath
 * @param {string} destPath
 * @param {{ branch: string, parent_branch?: string | null, parent_seq?: number | null, ledger_seq?: number, built_at?: string } | null} meta
 */
export function publishClonedView(builder, sourcePath, destPath, meta = null) {
  const stagedPath = createCloneStagingPath(destPath);
  try {
    builder.cloneView({ sourcePath, destPath: stagedPath });
    if (meta) patchViewBranchMeta(stagedPath, meta);
    publishStagedViewClone(stagedPath, destPath);
  } catch (error) {
    try { removeSqliteFile(stagedPath); } catch { /* preserve clone failure */ }
    throw error;
  }
}

/**
 * Clone the parent first, then derive the fork point from that transactionally
 * consistent snapshot. The parent ledger and published pathname may advance
 * while a session starts; neither may relabel older clone contents as newer.
 *
 * @param {ViewBuilder} builder
 * @param {Ledger} ledger
 * @param {{ branch: string, parentViewPath: string, outViewPath: string, layerMerge: boolean }} args
 */
export async function publishForkedBaselineView(builder, ledger, {
  branch,
  parentViewPath,
  outViewPath,
  layerMerge,
}) {
  const stagedPath = createCloneStagingPath(outViewPath);
  let published = false;
  try {
    builder.cloneView({ sourcePath: parentViewPath, destPath: stagedPath });
    const probe = openViewWithMeta(stagedPath, View);
    if (!probe.ok) return { seeded: false, reason: "parent_view_unreadable" };
    const parentBranch = String(probe.meta?.branch || "");
    let canServe;
    try {
      if (!parentBranch || /^posse\/pair-/u.test(parentBranch) || !ledger.getBranch(parentBranch)) {
        return { seeded: false, reason: "parent_branch_unusable" };
      }
      canServe = viewCanServeBranch({
        meta: probe.meta,
        ledger,
        branch: parentBranch,
        layerMerge,
      });
    } finally {
      try { probe.view.close(); } catch { /* ignore */ }
    }
    if (!canServe.ok) {
      return { seeded: false, reason: `parent_view_not_current: ${canServe.reason || "stale"}` };
    }
    const parentSeq = Number(probe.meta?.ledger_seq);
    if (!Number.isSafeInteger(parentSeq) || parentSeq < 0) {
      return { seeded: false, reason: "parent_view_unreadable" };
    }
    await ledger.forkBranch(branch, parentBranch, parentSeq, { label: "ParseEngine.seedForkedBaseline" });
    patchViewBranchMeta(stagedPath, {
      branch,
      parent_branch: parentBranch,
      parent_seq: parentSeq,
      ledger_seq: ledger.headSeq(branch),
    });
    publishStagedViewClone(stagedPath, outViewPath);
    published = true;
    return { seeded: true, parent_branch: parentBranch, parent_seq: parentSeq };
  } finally {
    if (!published) {
      try { removeSqliteFile(stagedPath); } catch { /* preserve the original outcome */ }
    }
  }
}
