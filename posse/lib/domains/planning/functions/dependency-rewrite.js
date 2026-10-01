/**
 * Chained splits (artificer -> promote -> code) finish with their final
 * piece, so a dependency on the split task moves to `finalIndex`. Unchained
 * splits (promotes by output directory, serialized only by their lane) have
 * no last piece that implies the others, so with `fanOut` the dependency
 * becomes one on every piece.
 */
export function rewriteDependenciesAfterSplit(tasks, splitIndex, splitTaskCount, finalIndex, { fanOut = false } = {}) {
  const offset = splitTaskCount - 1;
  if (offset <= 0) return;
  for (let idx = splitIndex + 1; idx < tasks.length; idx++) {
    const task = tasks[idx];
    if (!Array.isArray(task?.depends_on_index)) continue;
    task.depends_on_index = [...new Set(task.depends_on_index.flatMap((depIdx) => {
      if (!Number.isInteger(depIdx)) return [depIdx];
      if (depIdx === splitIndex) {
        return fanOut ? Array.from({ length: splitTaskCount }, (_, piece) => splitIndex + piece) : [finalIndex];
      }
      if (depIdx > splitIndex) return [depIdx + offset];
      return [depIdx];
    }))];
  }
}

/**
 * A database task that applies files this plan commits is held until the
 * work item merges (queue/functions/post-merge-db-tasks.js), so it must be
 * terminal: a task waiting on it would wait for the merge, which waits for
 * that task. A dependent that is not itself a database task needs the
 * committed files, not the applied database, so its dependency moves to the
 * database task's own upstream (database tasks in between are looked
 * through). Database tasks keep their edges on each other, which order their
 * writes.
 *
 * `links` are the compiler's pending planner dependency links
 * ({ jobId, taskIndex, dependsOnIndexes }, compiled task numbering) and are
 * rewritten in place. `isDbTaskIndex(index)` says whether a task index
 * compiled to a database task; `writesRepoFilesIndex(index)` whether it
 * compiled to a job that commits to the work-item branch. Returns one record
 * per rewritten link.
 */
export function rewriteDependenciesAroundPostMergeDbTasks(links, { isDbTaskIndex, writesRepoFilesIndex }) {
  const dependsOnByTask = new Map();
  for (const link of links) {
    const deps = dependsOnByTask.get(link.taskIndex) || new Set();
    for (const depIdx of link.dependsOnIndexes) deps.add(depIdx);
    dependsOnByTask.set(link.taskIndex, deps);
  }
  const isDbIndex = (index) => Number.isInteger(index) && isDbTaskIndex(index);
  const upstreamThroughDbTasks = (index, seen) => {
    const upstream = [];
    for (const depIdx of dependsOnByTask.get(index) || []) {
      if (seen.has(depIdx)) continue;
      seen.add(depIdx);
      if (isDbIndex(depIdx)) upstream.push(...upstreamThroughDbTasks(depIdx, seen));
      else upstream.push(depIdx);
    }
    return upstream;
  };
  const postMerge = new Map();
  const isPostMergeDbIndex = (index) => {
    if (!isDbIndex(index)) return false;
    if (!postMerge.has(index)) {
      postMerge.set(index, upstreamThroughDbTasks(index, new Set([index]))
        .some((depIdx) => Number.isInteger(depIdx) && writesRepoFilesIndex(depIdx)));
    }
    return postMerge.get(index);
  };

  const rewrites = [];
  for (const link of links) {
    if (isDbIndex(link.taskIndex)) continue;
    const removed = link.dependsOnIndexes.filter(isPostMergeDbIndex);
    if (removed.length === 0) continue;
    const next = [...new Set(link.dependsOnIndexes.flatMap((depIdx) => (
      removed.includes(depIdx) ? upstreamThroughDbTasks(depIdx, new Set([depIdx, link.taskIndex])) : [depIdx]
    )))];
    rewrites.push({
      jobId: link.jobId,
      taskIndex: link.taskIndex,
      removed,
      added: next.filter((depIdx) => !link.dependsOnIndexes.includes(depIdx)),
    });
    link.dependsOnIndexes = next;
  }
  return rewrites;
}
