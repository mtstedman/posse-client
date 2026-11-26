import { FIRST_TASK_READINESS as S, FIRST_TASK_ROLES, FIRST_TASK_WORKFLOW } from "../../../catalog/first-task-readiness.js";

// Safe before npm repair: no SQLite, provider, or native-runtime imports.
export function uninitializedFirstTaskReport() {
  return {
    state: S.NEEDS_ATTENTION,
    repository: { state: S.NEEDS_ATTENTION, detail: "This folder has not been initialized by Posse." },
    runtime: { state: S.NEEDS_ATTENTION, detail: "Project runtime checks were skipped." },
    providers: FIRST_TASK_ROLES.map(role => ({ role, providers: [], state: S.NEEDS_ATTENTION, detail: `${role}: not inspected before project initialization.` })),
    verification: { state: S.NEEDS_ATTENTION, commands: [], detail: "Project verification commands have not been inspected." },
    next_steps: ["Run posse add in the target project, then posse admin and posse doctor --first-task."],
    workflow: FIRST_TASK_WORKFLOW,
  };
}

export function firstTaskReadinessLines(report) {
  return [
    `First-task readiness: ${report.state.replaceAll("_", " ")}`,
    ...[report.repository, report.runtime, ...report.providers, report.verification].map(check => `  [${check.state}] ${check.detail}`),
    ...report.verification.commands.map(check => `    Declared: ${check.command} (${check.source})`),
    "  Provider readiness is local configuration/runtime evidence; no model request was sent.",
    ...report.next_steps.map(step => `  Next: ${step}`),
    "  First task: choose a small change with a specific, observable result.",
    "  Queue it with posse add --guided (skip this if it is already queued).",
    "  Start with posse go --approve-plan --no-auto-merge to pause for plan approval and keep the result for review.",
    "  Inspect a waiting plan with posse plan review <wi-id>; approve it in the monitor when ready.",
    "  After execution, inspect changes and evidence with posse review.",
  ];
}
