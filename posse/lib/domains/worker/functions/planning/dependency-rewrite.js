export function rewriteDependenciesAfterSplit(tasks, splitIndex, splitTaskCount, finalIndex) {
  const offset = splitTaskCount - 1;
  if (offset <= 0) return;
  for (let idx = splitIndex + 1; idx < tasks.length; idx++) {
    const task = tasks[idx];
    if (!Array.isArray(task?.depends_on_index)) continue;
    task.depends_on_index = task.depends_on_index.map((depIdx) => {
      if (!Number.isInteger(depIdx)) return depIdx;
      if (depIdx === splitIndex) return finalIndex;
      if (depIdx > splitIndex) return depIdx + offset;
      return depIdx;
    });
  }
}
