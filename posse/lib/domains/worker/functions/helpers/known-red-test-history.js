import { gitExecAsync } from "../../../git/functions/utils.js";
import { comparableTestFailureFingerprint } from "./test-failure-evidence.js";

// Invocation-local only: new receipts, branch switches and deepened shallow
// history must be visible immediately. A bounded walk proves recent ancestors;
// absence from that walk never proves a commit is off-branch.
export async function knownRedCommandsFromReceipts(receipts, {
  projectDir, head, limit = 12, git = gitExecAsync,
} = {}) {
  const ancestry = new Map([[head, true]]);
  let walked = false;
  const isAncestor = async (commit) => {
    if (ancestry.has(commit)) return ancestry.get(commit);
    if (!walked) {
      walked = true;
      try {
        const recent = await git(["rev-list", "--max-count=4096", head], projectDir);
        for (const oid of String(recent).trim().split(/\s+/u)) {
          if (/^[0-9a-f]{40,64}$/u.test(oid)) ancestry.set(oid, true);
        }
      } catch { /* Preserve the exact ancestry fallback when the walk is unavailable. */ }
    }
    if (!ancestry.has(commit)) {
      try {
        await git(["merge-base", "--is-ancestor", commit, head], projectDir);
        ancestry.set(commit, true);
      } catch {
        ancestry.set(commit, false);
      }
    }
    return ancestry.get(commit);
  };
  const latestByCommand = new Map();
  const failedIdentities = new Map();
  for (const receipt of receipts) {
    const commit = receipt.executed_commit_hash || receipt.commit_hash;
    if (!commit || !receipt.command) continue;
    const key = [receipt.command, receipt.cwd_relative || ""].join("\0");
    // Once a current-lineage pass is found, older failures cannot contribute
    // to a warning. Red commands still retain every historical failure identity.
    if (latestByCommand.get(key)?.status === "passed") continue;
    if (!await isAncestor(commit)) continue;
    if (!latestByCommand.has(key)) latestByCommand.set(key, receipt);
    if (receipt.status !== "failed") continue;
    const identity = comparableTestFailureFingerprint(receipt);
    if (!identity) continue;
    const identities = failedIdentities.get(key) || new Set();
    identities.add(identity);
    failedIdentities.set(key, identities);
  }
  return [...latestByCommand.entries()]
    .filter(([, receipt]) => receipt.status === "failed")
    .slice(0, Math.max(1, Number(limit) || 12))
    .map(([key, receipt]) => ({
      command: receipt.command,
      cwd_relative: receipt.cwd_relative || null,
      failure_identities: [...(failedIdentities.get(key) || [])].sort(),
      last_failed_commit: receipt.commit_hash || null,
      last_failed_at: receipt.created_at || null,
    }));
}
