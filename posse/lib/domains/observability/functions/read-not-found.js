import path from "node:path";
import { READ_NOT_FOUND_OBSERVATION } from "../../../catalog/observation.js";

export function readNotFoundProbe({ type, error, file, cwd, payload }) {
  if (type !== "tool.read" || !/File not found/i.test(String(error || "")) || !file || !cwd || !payload) return false;
  const normalize = value => path.relative(cwd, path.resolve(cwd, String(value))).replaceAll("\\", "/");
  const requested = normalize(file);
  const declared = ["files_to_modify", "files_to_create", "files_to_delete", "tests_to_run", "key_files"]
    .flatMap(key => Array.isArray(payload[key]) ? payload[key] : []);
  return !declared.some(value => {
    const pattern = normalize(value);
    return requested === pattern || requested.startsWith(`${pattern.replace(/\/$/, "")}/`) || path.matchesGlob(requested, pattern);
  });
}

export function isReadNotFoundProbe(row) {
  return row?.observation_type === READ_NOT_FOUND_OBSERVATION;
}
