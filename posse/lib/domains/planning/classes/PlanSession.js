import { createJobsFromPlan } from "../../worker/functions/helpers/plan-compiler.js";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function classifyTask(task = {}) {
  const taskMode = String(task.task_mode || "code").trim().toLowerCase();
  const needsImageGeneration = !!task.needs_image_generation;
  if (taskMode === "image" || needsImageGeneration) return "image";
  if (taskMode === "content" || taskMode === "report") return "artifact";
  if (task.job_type === "human_input") return "human_input";
  return "code";
}

export class PlanSession {
  constructor({
    planJob = null,
    workItem = null,
    rawTasks = [],
    worker = null,
    options = {},
  } = {}) {
    this.planJob = planJob || null;
    this.workItem = workItem || null;
    this.rawTasks = asArray(rawTasks);
    this.worker = worker || null;
    this.options = options || {};
    this._classified = null;
  }

  validate() {
    const errors = [];
    if (!Array.isArray(this.rawTasks) || this.rawTasks.length === 0) {
      errors.push("Planner emitted no tasks");
    }
    for (let i = 0; i < this.rawTasks.length; i++) {
      const task = this.rawTasks[i];
      if (!task || typeof task !== "object") {
        errors.push(`Task ${i + 1} is not an object`);
        continue;
      }
      if (!String(task.title || "").trim()) {
        errors.push(`Task ${i + 1} is missing title`);
      }
    }
    return { valid: errors.length === 0, errors };
  }

  classifyTasks() {
    const classified = this.rawTasks.map((task, index) => ({
      index,
      classification: classifyTask(task),
      task,
    }));
    this._classified = classified;
    return classified;
  }

  splitImageTasks() {
    const classified = this._classified || this.classifyTasks();
    return {
      image: classified.filter((entry) => entry.classification === "image").map((entry) => entry.task),
      nonImage: classified.filter((entry) => entry.classification !== "image").map((entry) => entry.task),
    };
  }

  emit({ spawnFromRole = null } = {}) {
    if (!this.worker) {
      throw new Error("PlanSession.emit requires a worker");
    }
    return createJobsFromPlan(this.worker, this.planJob, [...this.rawTasks], {
      ...this.options,
      ...(spawnFromRole ? { spawnFromRole } : {}),
    });
  }

  describe() {
    const classified = this._classified || this.classifyTasks();
    return {
      workItemId: this.planJob?.work_item_id ?? this.workItem?.id ?? null,
      taskCount: this.rawTasks.length,
      classifications: classified.map((entry) => entry.classification),
      hasArtificer: classified.some((entry) => String(entry.task?.job_type || "").trim() === "artificer"),
    };
  }

  taskCount() {
    return this.rawTasks.length;
  }

  hasArtificer() {
    return this.rawTasks.some((task) => String(task?.job_type || "").trim() === "artificer");
  }

  dependencies() {
    const deps = [];
    for (let i = 0; i < this.rawTasks.length; i++) {
      const task = this.rawTasks[i];
      const depList = asArray(task?.depends_on_index).filter((value) => Number.isInteger(value));
      deps.push({ index: i, dependsOn: depList });
    }
    return deps;
  }
}

