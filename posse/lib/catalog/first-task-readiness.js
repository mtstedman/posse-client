export const FIRST_TASK_READINESS = Object.freeze({ READY: "ready", BLOCKED: "blocked", NEEDS_ATTENTION: "needs_attention" });
export const FIRST_TASK_ROLES = Object.freeze(["planner", "dev", "assessor"]);
export const FIRST_TASK_FLAG = "--first-task";
export const FIRST_TASK_WORKFLOW = Object.freeze(["posse add --guided", "posse go --approve-plan --no-auto-merge", "posse review"]);
