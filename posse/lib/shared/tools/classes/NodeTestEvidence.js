import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NODE_TEST_EVIDENCE_FILE_ENV } from "../../../catalog/process.js";

// Owns one reporter channel, including through launchers that re-spawn Node.
export class NodeTestEvidence {
  constructor(root, file = null) {
    this.target = file ? path.resolve(root, file) : null;
    this.directory = fs.mkdtempSync(path.join(os.tmpdir(), "posse-test-evidence-"));
    this.file = path.join(this.directory, "results.jsonl");
  }

  args(args) {
    const result = [...args];
    result.splice(result.indexOf("--test") + 1, 0, "--test-reporter",
      fileURLToPath(new URL("../functions/toolkit/node-test-evidence-reporter.js", import.meta.url)));
    return result;
  }

  env() { return { [NODE_TEST_EVIDENCE_FILE_ENV]: this.file }; }

  counts() {
    let evidence = "";
    try { evidence = fs.readFileSync(this.file, "utf8"); } catch { return null; }
    const entries = evidence.trim().split("\n").flatMap((line) => {
      try { return [JSON.parse(line)]; }
      catch { return []; }
    });
    const summaries = entries.filter((entry) => entry.file && (!this.target || path.resolve(entry.file) === this.target));
    const counts = summaries.reduce((sum, entry) => ({ total: sum.total + entry.counts.tests,
      skipped: sum.skipped + entry.counts.skipped + entry.counts.todo }), { total: 0, skipped: 0 });
    if (this.target) return summaries.length === 1 ? counts : null;
    // Global totals include synthetic passing file wrappers. They cannot stand
    // in for per-file registered cases in a directory or multi-file invocation.
    const global = entries.filter((entry) => !entry.file);
    return global.length === 1 && global[0].counts.tests === counts.total ? counts : null;
  }

  close() { fs.rmSync(this.directory, { recursive: true, force: true }); }
}
