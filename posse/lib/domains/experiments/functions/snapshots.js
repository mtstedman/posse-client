import { createHash } from "node:crypto";
import { validExperimentWorkPath } from "./plan.js";
import { EXPERIMENT_SANDBOX_LIMITS } from "../../../catalog/experiments.js";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  return value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
}
export function experimentDigest(value) { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
export function fileDigest(value) { return createHash("sha256").update(value).digest("hex"); }

export function snapshotFiles(plan, supplied, parent = null) {
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) throw new Error("Files must be a path-to-text object.");
  const files = Object.assign(Object.create(null), parent || {});
  for (const [name, content] of Object.entries(supplied)) {
    const declared = plan.files.find(file => file.path === name);
    if (!validExperimentWorkPath(name) || !declared || typeof content !== "string" || content.includes("\0")) throw new Error("File is outside the declared payload or is not text.");
    if (parent && declared.mode === "read" && parent[name] !== content) throw new Error("Read-only file cannot change.");
    if (!parent && declared.mode !== "create" && fileDigest(content) !== declared.source.digest) throw new Error("Source digest does not match the initial file.");
    files[name] = content;
  }
  if (plan.files.some(file => !Object.hasOwn(files, file.path))) throw new Error("Every declared file needs initial content.");
  if (Buffer.byteLength(JSON.stringify(files)) > EXPERIMENT_SANDBOX_LIMITS.payloadBytes) throw new Error("Payload exceeds 256 KiB.");
  return { digest: experimentDigest(files), files };
}
