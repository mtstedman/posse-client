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
