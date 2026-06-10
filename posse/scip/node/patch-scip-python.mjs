import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = path.join(here, "node_modules", "@sourcegraph", "scip-python", "dist", "scip-python.js");
const before = 'const o=r(i(1017)),a=new RegExp(o.sep,"g");';
const after = 'const o=r(i(1017)),a=new RegExp(o.sep.replace(/[.*+?^${}()|[\\]\\\\]/g,"\\\\$&"),"g");';

if (!fs.existsSync(bundle)) process.exit(0);
let text = fs.readFileSync(bundle, "utf8");
if (text.includes(after)) process.exit(0);
if (!text.includes(before)) {
  throw new Error("scip-python bundle path separator pattern not found");
}
text = text.replace(before, () => after);
fs.writeFileSync(bundle, text);
