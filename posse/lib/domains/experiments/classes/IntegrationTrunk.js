import { withWorktreeLockAsync, withBranchLockAsync } from "../../git/functions/worktree-locks.js";

// Git work and check execution only: this path never dispatches an agent.
export class IntegrationTrunk {
  constructor(workspace, { lock } = {}) {
    this.workspace = workspace; this.config = workspace.config;
    this.lock = lock || ((fn, signal) => withWorktreeLockAsync(this.config.repo_path, this.config.repo_path,
      () => withBranchLockAsync(this.config.repo_path, this.config.trunk_branch, this.config.repo_path, fn, { signal }), { signal }));
  }
  async trunk(args, signal) { return String(await this.workspace.git(args, this.config.repo_path, { signal })).trim(); }
  async cleanTrunk(signal) {
    if (await this.trunk(["branch", "--show-current"], signal) !== this.config.trunk_branch) throw new Error("Main worktree is not on the declared trunk branch.");
    if (await this.trunk(["status", "--porcelain", "--untracked-files=all"], signal)) throw new Error("Trunk worktree is dirty; preserve its changes and retry after it is clean.");
    return this.trunk(["rev-parse", "HEAD"], signal);
  }
  async reconcile(record, signal) {
    if (!record.merge_candidate || !record.merge_verification?.ok) throw new Error("No verified merge candidate was recorded.");
    const head = await this.cleanTrunk(signal);
    await this.trunk(["merge-base", "--is-ancestor", record.merge_candidate, head], signal);
    if (await this.trunk(["rev-parse", `${record.merge_candidate}^{tree}`], signal) !== record.merge_verification.tree) throw new Error("Merge verification does not match the committed tree.");
    return { branch: this.config.trunk_branch, commit: record.merge_candidate, observed_head: head };
  }
  async merge(record, save, signal) {
    return this.lock(async () => {
      signal.throwIfAborted();
      try { return await this.reconcile(record, signal); } catch { signal.throwIfAborted(); }
      const head = await this.cleanTrunk(signal);
      await this.trunk(["merge-base", "--is-ancestor", this.config.base_commit, head], signal);
      if (record.merge_base) await this.trunk(["merge-base", "--is-ancestor", record.merge_base, head], signal);
      const w = this.workspace;
      if (await w.command(["branch", "--show-current"], signal) !== this.config.branch
        || (await w.changes(signal)).length) throw new Error("Integration worktree changed after commit; preserve it for inspection.");
      const candidate = await w.command(["rev-parse", "HEAD"], signal);
      if (candidate !== (record.merge_candidate || record.commit)) throw new Error("Integration HEAD changed outside the merge journal.");
      await w.command(["merge-base", "--is-ancestor", record.commit, candidate], signal);
      const priorVerification = record.merge_candidate === candidate && record.merge_base === head ? record.merge_verification : null;
      record.merge_base = head; save(record);
      if (head !== this.config.base_commit && head !== candidate) {
        // Merge trunk into the isolated candidate, never resolve conflicts in trunk.
        try { await w.command(["merge", "--no-ff", "--no-edit", "-m", `Merge trunk for experiment ${record.campaign_id}`, head], signal); }
        catch (error) {
          const merging = await w.command(["rev-parse", "-q", "--verify", "MERGE_HEAD"]).then(() => true, () => false);
          if (merging) await w.command(["merge", "--abort"]);
          throw new Error(`Clean merge failed; no model was dispatched and trunk was not changed. ${error.message}`);
        }
      }
      record.merge_candidate = await w.command(["rev-parse", "HEAD"], signal);
      record.merge_verification = null; save(record);
      const tree = await w.command(["rev-parse", "HEAD^{tree}"], signal);
      let results = record.verification.results;
      if (record.merge_candidate !== record.commit && !(priorVerification?.ok && priorVerification.tree === tree)) {
        results = [];
        for (const command of this.config.checks) results.push(await w.run(command, signal));
      } else if (priorVerification?.ok && priorVerification.tree === tree) results = priorVerification.results;
      if ((await w.changes(signal)).length || await w.command(["rev-parse", "HEAD"], signal) !== record.merge_candidate) throw new Error("Checks changed the merge candidate.");
      record.merge_verification = { ok: results.every(result => result.ok), tree, results }; save(record);
      if (!record.merge_verification.ok) throw new Error("Merged-tree checks failed; trunk was not changed.");
      signal.throwIfAborted(); save(record); // Reassert the owner lease immediately before publication.
      if (await this.cleanTrunk(signal) !== head) throw new Error("Trunk moved during verification; retry the merge without redoing the experiment.");
      await this.trunk(["merge", "--ff-only", record.merge_candidate], signal);
      return this.reconcile(record, signal);
    }, signal);
  }
}
