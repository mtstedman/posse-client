// lib/domains/planning/functions/planner-task-provenance.js
//
// What the planner wrote versus what the compiler ran. Compilation can
// reroute, split and annotate a planned task; a replan of the compiled job
// needs to see that rewrite, or it re-emits the same shape and the compiler
// rewrites it the same way again.

const SPEC_APPENDIX_MAX_CHARS = 600;

// The planner-authored shape of a task, taken before compilation changes it.
export function plannerTaskSnapshot(task = {}) {
  return {
    job_type: String(task.job_type || "dev"),
    task_mode: String(task.task_mode || "code"),
    title: typeof task.title === "string" ? task.title : "",
    needs_image_generation: task.needs_image_generation === true,
    task_spec: String(task.task_spec || task.instructions || ""),
  };
}

// The record a compiled job's payload keeps when the compiler changed the
// planned task, or null when the job is the task the planner wrote.
export function compilerRewriteRecord(snapshot, {
  jobType,
  taskMode,
  title,
  needsImageGeneration,
  taskSpec,
} = {}) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const compiledSpec = String(taskSpec || "");
  const specChanged = compiledSpec !== snapshot.task_spec;
  const changed = specChanged
    || snapshot.job_type !== jobType
    || snapshot.task_mode !== taskMode
    || snapshot.title !== title
    || snapshot.needs_image_generation !== !!needsImageGeneration;
  if (!changed) return null;
  const record = {
    job_type: snapshot.job_type,
    task_mode: snapshot.task_mode,
    title: snapshot.title,
    needs_image_generation: snapshot.needs_image_generation,
  };
  if (specChanged) {
    const appended = snapshot.task_spec && compiledSpec.startsWith(snapshot.task_spec)
      ? compiledSpec.slice(snapshot.task_spec.length).trim()
      : "";
    if (appended) record.task_spec_appended = appended.slice(0, SPEC_APPENDIX_MAX_CHARS);
    else record.task_spec_rewritten = true;
  }
  return record;
}

// Short lines for the replan context naming each compiler rewrite of the
// failed job.
export function describeCompilerRewrites(record, compiled = {}) {
  if (!record || typeof record !== "object") return [];
  const lines = [];
  const plannedShape = `${record.job_type}/${record.task_mode}`;
  const compiledShape = `${compiled.job_type}/${compiled.task_mode}`;
  if (plannedShape !== compiledShape) {
    lines.push(`The plan asked for ${plannedShape}; the compiler ran it as ${compiledShape}.`);
  }
  if (record.needs_image_generation !== !!compiled.needs_image_generation) {
    lines.push(`The compiler turned image generation ${compiled.needs_image_generation ? "on" : "off"} (needs_image_generation).`);
  }
  if (record.title && record.title !== compiled.title) {
    lines.push(`Planned title: ${JSON.stringify(record.title)}.`);
  }
  if (record.task_spec_appended) {
    lines.push(`The compiler appended to the planned task spec: ${JSON.stringify(record.task_spec_appended)}`);
  } else if (record.task_spec_rewritten) {
    lines.push("The compiler rewrote the planned task spec.");
  }
  return lines;
}
