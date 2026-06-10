import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  HIGH_VALUE_SOURCE_EXTENSIONS,
  OBVIOUS_BINARY_EXTENSIONS,
  REPO_CODE_EXTENSIONS,
  ATLAS_INDEXABLE_SOURCE_EXTENSIONS,
  SMART_PRELOAD_INDEXABLE_EXTENSIONS,
  SUPPORTING_TEXT_EXTENSIONS,
  TOOL_BRIEF_DEFAULT_EXTENSIONS,
} from "../lib/catalog/files.js";
import {
  ATLAS_INDEXABLE_SOURCE_EXTENSIONS as GATED_ATLAS_INDEXABLE_SOURCE_EXTENSIONS,
  isIndexableSourcePath,
} from "../lib/domains/integrations/functions/deterministic-mcp/source-file-gate.js";
import { INDEXABLE_EXTENSIONS } from "../lib/domains/handoff/functions/helpers/fn-index.js";
import { REPO_CODE_EXTS } from "../lib/domains/worker/functions/helpers/plan-routing.js";

describe("File extension catalog", () => {
  it("backs ATLAS and routing helpers from the shared catalog sets", () => {
    assert.equal(GATED_ATLAS_INDEXABLE_SOURCE_EXTENSIONS, ATLAS_INDEXABLE_SOURCE_EXTENSIONS);
    assert.equal(INDEXABLE_EXTENSIONS, SMART_PRELOAD_INDEXABLE_EXTENSIONS);
    assert.equal(REPO_CODE_EXTS, REPO_CODE_EXTENSIONS);
  });

  it("keeps source, supporting text, and binary classifications distinct", () => {
    assert.equal(isIndexableSourcePath("src/app.tsx"), true);
    assert.equal(isIndexableSourcePath("src/lib.rs"), true);
    assert.equal(isIndexableSourcePath("docs/notes.md"), false);

    assert.equal(HIGH_VALUE_SOURCE_EXTENSIONS.has(".sql"), true);
    assert.equal(SUPPORTING_TEXT_EXTENSIONS.has(".md"), true);
    assert.equal(TOOL_BRIEF_DEFAULT_EXTENSIONS.has(".toml"), true);
    assert.equal(OBVIOUS_BINARY_EXTENSIONS.has(".png"), true);
    assert.equal(HIGH_VALUE_SOURCE_EXTENSIONS.has(".png"), false);
  });
});
