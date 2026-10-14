// Ranking is advisory; dependency, ownership and merge admission remain mandatory.
export const SCHEDULER_SELECTION_POLICY = Object.freeze({
  priorityWeight: 32,
  maxUnlockWeight: 24,
  ageQuantumMs: 5 * 60 * 1000,
  priorities: Object.freeze({ urgent: 3, high: 2, normal: 1 }),
  edgeKinds: Object.freeze({ dependency: "dependency", file: "file", contract: "contract" }),
});
