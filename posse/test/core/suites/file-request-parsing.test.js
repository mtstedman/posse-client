import {
  it,
  after,
  assert,
  path,
  suite,
  parseFileRequest,
} from "../support/core-harness.js";

let db;

suite("File Request Parsing", () => {
  it("parses a valid FILE_REQUEST block", () => {
    const output = `Some output
FILE_REQUEST:
- src/utils/helper.js — Need shared utility
- public/images/logo.png — Logo asset
FILE_REQUEST_END
More output`;
    const result = parseFileRequest(output);
    assert.ok(result);
    assert.equal(result.length, 2);
    assert.equal(result[0].path, "src/utils/helper.js");
    assert.equal(result[1].path, "public/images/logo.png");
  });

  it("returns null when no FILE_REQUEST block", () => {
    assert.equal(parseFileRequest("No file requests here"), null);
  });

  it("ignores FILE_REQUEST examples inside fenced code blocks", () => {
    const output = [
      "Example:",
      "```",
      "FILE_REQUEST:",
      "- secrets.txt -- example only",
      "FILE_REQUEST_END",
      "```",
    ].join("\n");

    assert.equal(parseFileRequest(output), null);
  });

  it("parses real FILE_REQUEST blocks after fenced examples", () => {
    const output = [
      "```text",
      "FILE_REQUEST:",
      "- docs/example-only.md",
      "FILE_REQUEST_END",
      "```",
      "FILE_REQUEST:",
      "- docs/real-request.md -- Need context",
      "FILE_REQUEST_END",
    ].join("\n");

    const result = parseFileRequest(output);
    assert.deepEqual(result.map((entry) => entry.path), ["docs/real-request.md"]);
  });

  it("returns null for empty block", () => {
    const output = "FILE_REQUEST:\nFILE_REQUEST_END";
    const result = parseFileRequest(output);
    assert.ok(!result || result.length === 0);
  });

  it("ignores glob-like ignore patterns and bare pseudo-dotfiles", () => {
    const output = `FILE_REQUEST:
- *.db-wal -- ignore pattern, not a concrete file
- *.db-shm -- ignore pattern, not a concrete file
- .db -- not a real requested file
- .env -- valid dotfile
FILE_REQUEST_END`;
    const result = parseFileRequest(output);
    assert.ok(result);
    assert.deepEqual(result.map((entry) => entry.path), [".env"]);
  });

  it("does not misparse dev-log file_requests: none summaries as real file requests", () => {
    const output = `--- DEV LOG START ---
task_id: TASK-206
status: COMPLETE
file_requests: none
criteria_check:
  - "songs-page.css contains .upload-dropzone:hover": PASS — hover intensifies box-shadow/background
  - "songs-page.css contains delete button hover accent": PASS — neon-pink/orange
--- DEV LOG END ---`;

    assert.equal(parseFileRequest(output), null);
  });

  it("parses extensionless FILE_REQUEST basenames when they are concrete project files", () => {
    const output = [
      "FILE_REQUEST:",
      "- Makefile -- project build entrypoint",
      "- Dockerfile -- container image",
      "FILE_REQUEST_END",
    ].join("\n");

    assert.deepEqual(parseFileRequest(output).map((entry) => entry.path), ["Makefile", "Dockerfile"]);
  });

  it("splits FILE_REQUEST reasons with a single spaced hyphen separator", () => {
    const output = [
      "FILE_REQUEST:",
      "- src/foo.js - Need the implementation file",
      "FILE_REQUEST_END",
    ].join("\n");

    const result = parseFileRequest(output);
    assert.deepEqual(result.map((entry) => entry.path), ["src/foo.js"]);
    assert.equal(result[0].reason, "Need the implementation file");
  });

  it("preserves bare requested paths that contain spaces", () => {
    const output = [
      "FILE_REQUEST:",
      "- docs/My Design Notes.md -- Include design rationale",
      "- public/images/hero image.png",
      "FILE_REQUEST_END",
    ].join("\n");

    const result = parseFileRequest(output);
    assert.deepEqual(result.map((entry) => entry.path), ["docs/My Design Notes.md", "public/images/hero image.png"]);
    assert.equal(result[0].reason, "Include design rationale");
  });

  it("stops parsing file requests when artificer logs begin", () => {
    const output = [
      "FILE_REQUEST:",
      "- public/images/hero.png -- Need generated asset",
      "--- ARTIFICER LOG START ---",
      "- public/images/log-only.png -- Not a request",
      "FILE_REQUEST_END",
    ].join("\n");

    assert.deepEqual(parseFileRequest(output).map((entry) => entry.path), ["public/images/hero.png"]);
  });
});
