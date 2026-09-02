// @ts-check
//
// Guarded diversity for task-shaped code maps.
//
// Semantic retrieval often returns several adjacent symbols from one file.
// That is useful evidence, but it is a poor seed set for a dependency slice:
// one implementation unit can consume the entire entry budget before the
// graph has a chance to expose boundaries in other files. This helper
// interleaves distinct groups only among candidates with comparable scores.
// Stronger relevance bands always stay ahead of weaker ones, and pinned
// anchors are never moved.

/**
 * @template T
 * @param {T[]} candidates Ranked best-first.
 * @param {{
 *   groupOf: (candidate: T, index: number) => string,
 *   scoreOf?: (candidate: T, index: number) => number,
 *   pinned?: (candidate: T, index: number) => boolean,
 *   cohortOf?: (candidate: T, index: number) => string,
 *   relativeScoreSlack?: number,
 *   limit?: number,
 * }} options
 * @returns {T[]}
 */
export function diversifyComparableCandidates(candidates, options) {
  const input = Array.isArray(candidates) ? candidates : [];
  const limit = boundedLimit(options?.limit, input.length);
  if (limit === 0) return [];
  if (input.length <= 1) return input.slice(0, limit);
  if (!options || typeof options.groupOf !== "function") return input.slice(0, limit);
  const slack = boundedSlack(options.relativeScoreSlack);
  const scoreOf = typeof options.scoreOf === "function"
    ? options.scoreOf
    : (_candidate, index) => 1 / (index + 1);
  const pinned = typeof options.pinned === "function" ? options.pinned : () => false;
  const cohortOf = typeof options.cohortOf === "function" ? options.cohortOf : () => "default";
  const rows = input.map((candidate, index) => ({
    candidate,
    index,
    score: finiteScore(scoreOf(candidate, index), 1 / (index + 1)),
    group: normalizedKey(options.groupOf(candidate, index), `candidate:${index}`),
    cohort: normalizedKey(cohortOf(candidate, index), "default"),
    pinned: pinned(candidate, index) === true,
  }));

  const selected = [];
  const selectedIndexes = new Set();
  const selectedGroupCounts = new Map();
  for (const row of rows) {
    if (!row.pinned) continue;
    selected.push(row.candidate);
    selectedIndexes.add(row.index);
    selectedGroupCounts.set(row.group, (selectedGroupCounts.get(row.group) || 0) + 1);
    if (selected.length >= limit) return selected;
  }

  // Cohorts preserve hard policy boundaries supplied by the caller (for
  // example production before tests). Their order is their first appearance
  // in the already-ranked input.
  const cohorts = new Map();
  for (const row of rows) {
    if (selectedIndexes.has(row.index)) continue;
    const cohort = cohorts.get(row.cohort) || [];
    cohort.push(row);
    cohorts.set(row.cohort, cohort);
  }

  for (const cohort of cohorts.values()) {
    for (const band of comparableScoreBands(cohort, slack)) {
      for (const row of interleaveGroups(band, selectedGroupCounts)) {
        selected.push(row.candidate);
        selectedGroupCounts.set(row.group, (selectedGroupCounts.get(row.group) || 0) + 1);
        if (selected.length >= limit) return selected;
      }
    }
  }
  return selected;
}

function comparableScoreBands(rows, slack) {
  const bands = [];
  let current = [];
  let leader = 0;
  for (const row of rows) {
    if (current.length === 0) {
      current = [row];
      leader = row.score;
      continue;
    }
    if (relativeGap(leader, row.score) <= slack) {
      current.push(row);
      continue;
    }
    bands.push(current);
    current = [row];
    leader = row.score;
  }
  if (current.length > 0) bands.push(current);
  return bands;
}

function interleaveGroups(rows, selectedGroupCounts) {
  const groups = new Map();
  for (const row of rows) {
    const group = groups.get(row.group) || [];
    group.push(row);
    groups.set(row.group, group);
  }
  const orderedGroups = [...groups.entries()]
    .map(([key, group], index) => ({
      key,
      group,
      index,
      priorSelections: selectedGroupCounts.get(key) || 0,
    }))
    .sort((a, b) => a.priorSelections - b.priorSelections || a.index - b.index);
  const out = [];
  for (let depth = 0; ; depth += 1) {
    let appended = false;
    for (const { group } of orderedGroups) {
      if (!group[depth]) continue;
      out.push(group[depth]);
      appended = true;
    }
    if (!appended) return out;
  }
}

function relativeGap(leader, candidate) {
  if (leader === candidate) return 0;
  return Math.max(0, leader - candidate) / Math.max(Math.abs(leader), Number.EPSILON);
}

function boundedSlack(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0.15;
  return Math.max(0, Math.min(0.5, parsed));
}

function boundedLimit(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(fallback, Math.floor(parsed)));
}

function finiteScore(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizedKey(value, fallback) {
  const key = String(value || "").trim().replace(/\\/g, "/");
  return key || fallback;
}
