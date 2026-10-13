import { getDb } from "../../../shared/storage/functions/index.js";
import { parseJobPayload } from "../../queue/functions/payload.js";
import { workItemBranchGeneration, reviewedTransfers } from "../../queue/functions/reviewed-handoff-records.js";
import { REVIEWED_COMPLETION_KEY, REVIEWED_SOURCE_MERGE_KEY, REVIEWED_HANDOFF_REF_PREFIX, REVIEWED_SOURCE_TRAILER } from "../../../catalog/reviewed-handoffs.js";
import { runImmediateTransaction, now } from "../../queue/functions/common.js";
import { gitExecAsync } from "./utils.js";
import { parseReviewedTreeObject, sameReviewedObject } from "./reviewed-file-objects.js";

// Squash merges remove the ancestry relationship to the canonical commit.
// Capture which pinned receipts the accepted source revision contains while
// the merge owner still has that revision, before deleting its branch.
export function recordReviewedSourceMerge({ workItemId, sourceHead, mergeHash, cwd, git }) {
  if (!workItemId || !mergeHash) return;
  const db = getDb();
  const source = db.prepare("SELECT * FROM work_items WHERE id = ?").get(workItemId);
  if (!source) return;
  const generation = workItemBranchGeneration(source);
  if (!sourceHead) {
    const message = String(git(["show", "-s", "--format=%B", mergeHash], cwd));
    const prefix = `${REVIEWED_SOURCE_TRAILER}: ${workItemId} ${generation} `;
    sourceHead = message.split("\n").find((line) => line.startsWith(prefix))?.slice(prefix.length);
  }
  if (!/^[a-f0-9]{40,64}$/.test(sourceHead || "")) return;
  const receipts = new Map();
  for (const job of db.prepare("SELECT * FROM jobs").all()) {
    const receipt = parseJobPayload(job)[REVIEWED_COMPLETION_KEY];
    for (const entry of [receipt, ...reviewedTransfers(job), ...reviewedTransfers(job, { applied: true })]) {
      if (entry?.source_work_item_id === workItemId && entry.source_generation === generation) receipts.set(entry.receipt_id, entry);
    }
  }
  if (!receipts.size) return;
  const accepted = [];
  for (const receipt of receipts.values()) {
    try {
      git(["merge-base", "--is-ancestor", receipt.source_commit, sourceHead], cwd);
      accepted.push(receipt.receipt_id);
    } catch {
      // Closeout may replay the source onto the target and drop its own
      // settled imports. Exact scoped objects and bound inputs still prove
      // that this reviewed change survived that rewrite.
      try {
        git(["cat-file", "-e", `${sourceHead}^{commit}`], cwd);
        const preserved = [...receipt.files, ...receipt.read_inputs].every((file) =>
          sameReviewedObject(file.object, parseReviewedTreeObject(String(git([
            "ls-tree", "--full-name", "-z", sourceHead, "--", `:(top,literal)${file.repo_path}`,
          ], cwd, { trim: false })), file.repo_path)));
        if (preserved) accepted.push(receipt.receipt_id);
      } catch { /* Incomplete proof retains the generation-specific blocker. */ }
    }
  }
  const execute = () => {
    const current = db.prepare("SELECT * FROM work_items WHERE id = ?").get(workItemId);
    if (workItemBranchGeneration(current) !== generation) return;
    const metadata = JSON.parse(current.metadata_json || "{}");
    metadata[REVIEWED_SOURCE_MERGE_KEY] = { source_generation: generation, source_commit: sourceHead,
      merge_commit: mergeHash, accepted_receipt_ids: accepted, accepted_at: now() };
    db.prepare("UPDATE work_items SET metadata_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(metadata), now(), workItemId);
  };
  if (db.inTransaction) execute(); else runImmediateTransaction(db, execute);
}

export function reviewedSourceMergeTrailer(workItemId, sourceHead) {
  if (!workItemId || !/^[a-f0-9]{40,64}$/.test(sourceHead || "")) return null;
  const db = getDb();
  // Completion refs and transfer snapshots remain available through source
  // closeout. Keep the accepted revision in Git as well as SQLite so a crash
  // immediately after the squash commit does not strand descendants.
  const source = db.prepare("SELECT * FROM work_items WHERE id = ?").get(workItemId);
  if (!source) return null;
  return `${REVIEWED_SOURCE_TRAILER}: ${workItemId} ${workItemBranchGeneration(source)} ${sourceHead}`;
}

export async function retireSettledReviewedRefs(cwd, { signal = null } = {}) {
  const db = getDb();
  const workItems = new Map(db.prepare("SELECT * FROM work_items").all().map((wi) => [wi.id, wi]));
  const known = new Map();
  const live = new Set();
  for (const job of db.prepare("SELECT * FROM jobs").all()) {
    const wi = workItems.get(job.work_item_id);
    const own = parseJobPayload(job)[REVIEWED_COMPLETION_KEY];
    if (own) {
      known.set(own.receipt_id, own.source_commit);
      if (wi?.merge_state !== "merged" && workItemBranchGeneration(wi) === own.source_generation) live.add(own.receipt_id);
    }
    for (const transfer of [...reviewedTransfers(job), ...reviewedTransfers(job, { applied: true })]) {
      known.set(transfer.receipt_id, transfer.source_commit);
      if (wi?.merge_state !== "merged" && workItemBranchGeneration(wi) === transfer.receiver_generation) live.add(transfer.receipt_id);
    }
  }
  let retired = 0;
  for (const [id, commit] of known) {
    if (live.has(id) || !/^[a-f0-9]{64}$/.test(id)) continue;
    // Compare-and-delete cannot remove an independently replaced ref.
    await gitExecAsync(["update-ref", "-d", `${REVIEWED_HANDOFF_REF_PREFIX}${id}`, commit], cwd, { signal });
    retired++;
  }
  return retired;
}
