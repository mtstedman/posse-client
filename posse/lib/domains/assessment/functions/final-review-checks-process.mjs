import fs from "node:fs";
import { runChangedFileChecks } from "./final-review-checks.js";

const { cwd, change, checkKinds } = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
fs.writeFileSync(process.argv[3], JSON.stringify(runChangedFileChecks(cwd, change, { checkKinds })));
