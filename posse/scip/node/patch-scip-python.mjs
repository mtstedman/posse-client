import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = path.join(here, "node_modules", "@sourcegraph", "scip-python", "dist", "scip-python.js");
const beforePathSeparator = 'const o=r(i(1017)),a=new RegExp(o.sep,"g");';
const afterPathSeparator = 'const o=r(i(1017)),a=new RegExp(o.sep.replace(/[.*+?^${}()|[\\]\\\\]/g,"\\\\$&"),"g");';
const beforeHiddenExcludes = '["**/node_modules","**/__pycache__","**/.*"]';
const afterHiddenExcludes = '["**/node_modules","**/__pycache__","**/.git","**/.hg","**/.svn","**/.posse","**/.posse-worktrees","**/.venv","**/.tox","**/.nox","**/.mypy_cache","**/.pytest_cache","**/.ruff_cache"]';

if (!fs.existsSync(bundle)) process.exit(0);
let text = fs.readFileSync(bundle, "utf8");
if (text.includes(beforePathSeparator)) {
  text = text.replace(beforePathSeparator, () => afterPathSeparator);
} else if (!text.includes(afterPathSeparator)) {
  throw new Error("scip-python bundle path separator pattern not found");
}
if (text.includes(beforeHiddenExcludes)) {
  text = text.replace(beforeHiddenExcludes, () => afterHiddenExcludes);
} else if (!text.includes(afterHiddenExcludes)) {
  throw new Error("scip-python bundle hidden-directory exclude pattern not found");
}
fs.writeFileSync(bundle, text);
