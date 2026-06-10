import {
  it,
  before,
  assert,
  fs,
  os,
  path,
  __dirname,
  suite,
  isUnderRoot,
  normPath,
  normalizeRoots,
} from "../support/core-harness.js";

let db;

suite("File scope logic", () => {
  let hasFileConflict;
  before(async () => {
    ({ hasFileConflict } = await import("../../../lib/domains/scheduler/functions/file-scope.js"));
  });

  it("detects exact file overlap", () => {
    const scope = { files: ["src/foo.js"], createRoots: [] };
    const locked = new Set(["src/foo.js"]);
    assert.ok(hasFileConflict(scope, locked, new Set()));
  });

  it("allows non-overlapping files", () => {
    const scope = { files: ["src/bar.js"], createRoots: [] };
    const locked = new Set(["src/foo.js"]);
    assert.ok(!hasFileConflict(scope, locked, new Set()));
  });

  it("detects file under locked root", () => {
    const scope = { files: ["src/components/Button.jsx"], createRoots: [] };
    assert.ok(hasFileConflict(scope, new Set(), new Set(["src/components"])));
  });

  it("allows file outside locked root", () => {
    const scope = { files: ["lib/utils.js"], createRoots: [] };
    assert.ok(!hasFileConflict(scope, new Set(), new Set(["src/components"])));
  });

  it("detects locked file under job root", () => {
    const scope = { files: [], createRoots: ["src/styles"] };
    const locked = new Set(["src/styles/main.css"]);
    assert.ok(hasFileConflict(scope, locked, new Set()));
  });

  it("detects exact root-root match", () => {
    const scope = { files: [], createRoots: ["assets/icons"] };
    assert.ok(hasFileConflict(scope, new Set(), new Set(["assets/icons"])));
  });

  it("detects nested root conflicts", () => {
    const scope = { files: [], createRoots: ["assets/icons/svg"] };
    assert.ok(hasFileConflict(scope, new Set(), new Set(["assets/icons"])));
  });

  it("treats awaiting assessment and review states as still holding scope locks", () => {
    const heldFiles = new Set(["data/state_office_contacts.json"]);
    const heldRoots = new Set(["public/images"]);
    assert.ok(hasFileConflict({ files: ["data/state_office_contacts.json"], createRoots: [] }, heldFiles, new Set()));
    assert.ok(hasFileConflict({ files: ["public/images/hero.png"], createRoots: [] }, new Set(), heldRoots));
  });

  it("does not treat dot-dot paths as being under an allowed root", () => {
    const normalizedRoots = normalizeRoots(["src"], path.resolve(__dirname, ".."));
    assert.equal(normPath("src/../../etc/passwd"), "../etc/passwd");
    assert.equal(isUnderRoot(normPath("src/../../etc/passwd"), normalizedRoots), false);
  });

  it("maps relative dot create_roots to wildcard scope", () => {
    const normalizedRoots = normalizeRoots([".", "./src", "", null], path.resolve(__dirname, ".."));
    assert.ok(normalizedRoots.includes("*"));
    assert.ok(normalizedRoots.includes("src"));
  });

  it("normalizes mixed-separator absolute roots to repo-relative scope", () => {
    const normalizedRoots = normalizeRoots(
      ["C:\\dev\\project\\src\\features\\"],
      "C:\\dev\\project"
    );
    assert.deepEqual(normalizedRoots, ["src/features"]);
  });

  it("drops absolute create_roots that resolve outside the cwd", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "posse-scope-root-"));
    try {
      const outside = path.resolve(root, "..", "outside");
      assert.deepEqual(normalizeRoots([outside], root), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps wildcard roots scoped to cwd descendants", () => {
    assert.equal(isUnderRoot("src/file.js", ["*"]), true);
    assert.equal(isUnderRoot("../outside/file.js", ["*"]), false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
