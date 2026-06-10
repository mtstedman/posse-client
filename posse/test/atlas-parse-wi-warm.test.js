import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ATLAS_SCIP_LANGUAGE_VALUES } from "../lib/domains/atlas/functions/v2/scip/languages.js";
import { EXT_TO_LANG, languageForPath } from "../lib/domains/atlas/functions/v2/parse/language-buckets.js";
import { workItemLanguageBuckets, workItemLanguages } from "../lib/domains/queue/functions/work-item-languages.js";

describe("Atlas parse WI language scope helpers", () => {
  it("reads scope-only languages and ignores unsupported paths", () => {
    const scope = { paths: ["src/api.ts", "lib/job.py", "README.md", "web/index.php"] };

    assert.deepEqual(workItemLanguages(scope), ["php", "py", "ts"]);
    assert.deepEqual(workItemLanguageBuckets(scope).get("ts"), ["src/api.ts"]);
  });

  it("accepts a raw path array for merge and handoff callers", () => {
    assert.deepEqual(workItemLanguages(["cmd/main.go", "docs/notes.txt", "src/lib.rs"]), ["go", "rs"]);
  });

  it("accepts a single path string", () => {
    assert.deepEqual(workItemLanguages("src/x.ts"), ["ts"]);
  });

  it("derives C++ extension buckets from the parser catalog", () => {
    assert.equal(languageForPath("native/widget.cxx"), "cpp");
    assert.equal(EXT_TO_LANG[".cxx"], "cpp");
  });

  it("keeps SCIP languages covered by path extension buckets", () => {
    const bucketToScip = {
      js: "typescript",
      ts: "typescript",
      py: "python",
      php: "php",
      go: "go",
      rs: "rust",
    };
    const covered = new Set(Object.values(EXT_TO_LANG).map((lang) => bucketToScip[lang]).filter(Boolean));

    for (const lang of ATLAS_SCIP_LANGUAGE_VALUES) {
      assert.equal(covered.has(lang), true, `${lang} has no EXT_TO_LANG coverage`);
    }
  });
});
