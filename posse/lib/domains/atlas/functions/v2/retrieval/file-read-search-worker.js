import { parentPort, workerData } from "node:worker_threads";

const lines = Array.isArray(workerData?.lines) ? workerData.lines : [];
const maxMatches = Math.max(1, Number(workerData?.maxMatches) || 100);
const timeBudgetMs = Math.max(1, Number(workerData?.timeBudgetMs) || 500);
const matchLines = [];
const startedAt = Date.now();

try {
  const re = new RegExp(String(workerData?.patternSource || ""), "i");
  let timedOut = false;
  let matchLimitReached = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (Date.now() - startedAt > timeBudgetMs) {
      timedOut = true;
      break;
    }
    if (re.test(String(lines[index] || ""))) {
      matchLines.push(index);
      if (matchLines.length >= maxMatches) {
        matchLimitReached = true;
        break;
      }
    }
  }
  parentPort?.postMessage({ matchLines, timedOut, matchLimitReached });
} catch (error) {
  parentPort?.postMessage({
    matchLines: [],
    timedOut: false,
    matchLimitReached: false,
    error: error instanceof Error ? error.message : String(error),
  });
}
