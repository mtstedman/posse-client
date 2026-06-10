import {
  it,
  assert,
  fs,
  path,
  __dirname,
  suite,
  runtimeModules,
  handoff,
  _buildSmartPreload,
} from "../support/core-harness.js";

let db;

suite("Smart Preload", () => {
  // Generate a file with 100+ lines to exceed threshold
  const bigFile = [
    'import fs from "fs";',
    'import path from "path";',
    '',
    ...Array.from({ length: 20 }, (_, i) => `// padding line ${i}`),
    '',
    'function targetFunction(x) {',
    '  const result = x * 2;',
    '  return result;',
    '}',
    '',
    'function helperOne() {',
    '  return "helper1";',
    '}',
    '',
    'function helperTwo() {',
    '  return "helper2";',
    '}',
    '',
    ...Array.from({ length: 60 }, (_, i) => `// more padding ${i}`),
  ].join("\n");

  it("returns null for small files", () => {
    const small = 'function foo() { return 1; }\n';
    assert.equal(_buildSmartPreload(small, "foo"), null);
  });

  it("matches functions mentioned in task_spec", () => {
    const result = _buildSmartPreload(bigFile, "Modify targetFunction to handle negative numbers");
    assert.ok(result);
    assert.equal(result.matched.length, 1);
    assert.equal(result.matched[0].name, "targetFunction");
    assert.equal(result.toc.length, 2); // helperOne, helperTwo
  });

  it("puts unmentioned functions in TOC", () => {
    const result = _buildSmartPreload(bigFile, "Modify targetFunction");
    assert.ok(result);
    assert.ok(result.toc.some(f => f.name === "helperOne"));
    assert.ok(result.toc.some(f => f.name === "helperTwo"));
  });

  it("includes imports section", () => {
    const result = _buildSmartPreload(bigFile, "targetFunction");
    assert.ok(result);
    assert.ok(result.imports.includes("import fs"));
  });

  it("does not over-match short function names via substring matches", () => {
    const source = [
      ...Array.from({ length: 90 }, (_, i) => `// pad ${i}`),
      "function id() { return 1; }",
      "function helper() { return 2; }",
    ].join("\n");
    const result = _buildSmartPreload(source, "Please modify identifier parsing and model provider wiring");
    assert.ok(result);
    assert.equal(result.matched.some((entry) => entry.name === "id"), false);
  });

  it("supports function-scoped smart preload for PHP files", async () => {
    const handoffMod = await import("../../../lib/domains/handoff/functions/index.js");
    const { queueMod } = runtimeModules;
    const previousPreloadMode = queueMod.getSetting("handoff_preload_editable_file_bodies");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-php-smart-preload-"));

    try {
      queueMod.setSetting("handoff_preload_editable_file_bodies", "small");
      const phpPath = path.join(projectDir, "index.php");
      const phpFile = [
        "<?php",
        "",
        ...Array.from({ length: 90 }, (_, i) => `// padding ${i}`),
        "",
        "function target_widget($value) {",
        "  return trim($value);",
        "}",
        "",
        "function helper_widget() {",
        "  return 'helper';",
        "}",
      ].join("\n");
      fs.writeFileSync(phpPath, phpFile, "utf-8");

      const packet = {
        recipient: "dev",
        job_type: "dev",
        cwd: projectDir,
        files_to_modify: ["index.php"],
        files_to_create: [],
        files_to_delete: [],
        create_roots: [],
        _raw_payload: { task_spec: "Update target_widget to handle empty values" },
      };

      await handoffMod.handoff(packet);

      assert.ok(packet.smart_preloads?.["index.php"]);
      assert.ok(packet.smart_preloads["index.php"].matched.some((fn) => fn.name === "target_widget"));
      assert.ok(packet.smart_preloads["index.php"].toc.some((fn) => fn.name === "helper_widget"));
      assert.equal(packet.editable_files["index.php"], null);
    } finally {
      queueMod.setSetting("handoff_preload_editable_file_bodies", previousPreloadMode);
      try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("suppresses editable smart preload when ATLAS prefetch is active", async () => {
    const fileAttach = await import("../../../lib/domains/handoff/functions/helpers/file-attach.js");
    const { resolvePathWithin } = await import("../../../lib/domains/worker/functions/helpers/scope.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-atlas-skips-smart-preload-"));

    try {
      const phpFile = [
        "<?php",
        "",
        ...Array.from({ length: 90 }, (_, i) => `// padding ${i}`),
        "",
        "function target_widget($value) {",
        "  return trim($value);",
        "}",
      ].join("\n");
      fs.writeFileSync(path.join(projectDir, "index.php"), phpFile, "utf-8");

      const packet = {
        recipient: "dev",
        cwd: projectDir,
        files_to_modify: ["index.php"],
        atlas: { active: true },
        _raw_payload: { task_spec: "Update target_widget to handle empty values" },
      };

      fileAttach.attachEditableFiles(packet, {
        fs,
        path,
        resolvePathWithin,
        indexableExtensions: new Set([".php"]),
        maxSmartPreloadSize: 200000,
        maxFileSize: 150000,
        buildSmartPreload: _buildSmartPreload,
        readFile: (relPath, cwd) => fileAttach.readFile(relPath, cwd, {
          fs,
          resolvePathWithin,
          maxFileSize: 150000,
        }),
        preloadMode: "small",
      });

      assert.deepEqual(packet.smart_preloads, {});
      assert.equal(packet.editable_files["index.php"], null);
      assert.equal(packet.editable_file_metadata["index.php"].contentPreloaded, false);
      assert.equal(packet.editable_file_preload_mode, "off");
    } finally {
      try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("omits editable file bodies by default while preserving exact file targets", async () => {
    const handoffMod = await import("../../../lib/domains/handoff/functions/index.js");
    const { queueMod } = runtimeModules;
    const previousPreloadMode = queueMod.getSetting("handoff_preload_editable_file_bodies");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-no-editable-preload-"));

    try {
      queueMod.setSetting("handoff_preload_editable_file_bodies", "off");
      fs.writeFileSync(path.join(projectDir, "index.js"), "const secretBody = 42;\n", "utf-8");

      const packet = {
        recipient: "dev",
        job_type: "dev",
        cwd: projectDir,
        files_to_modify: ["index.js"],
        files_to_create: [],
        files_to_delete: [],
        create_roots: [],
        success_criteria: [],
        risk: { mutating: true },
        attempt: { count: 1, max: 1, last_error: null },
        _raw_payload: { task_spec: "Update index.js" },
      };

      await handoffMod.handoff(packet);
      const context = handoffMod.packetToContextString(packet);

      assert.equal(packet.editable_files["index.js"], null);
      assert.equal(packet.editable_file_metadata["index.js"].contentPreloaded, false);
      assert.match(context, /FILES YOU MUST MODIFY/);
      assert.match(context, /index\.js/);
      assert.match(context, /Full editable file bodies are intentionally not preloaded/);
      assert.match(context, /=== index\.js === \(contents not preloaded - use read_file before editing\)/);
      assert.doesNotMatch(context, /file not found - verify path/);
      assert.doesNotMatch(context, /secretBody/);
    } finally {
      queueMod.setSetting("handoff_preload_editable_file_bodies", previousPreloadMode);
      try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
