import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { Scope } from "../lib/shared/scope/classes/Scope.js";
import { MutationPolicy } from "../lib/shared/scope/classes/MutationPolicy.js";
import { scopedDeleteTargets as scopedDeleteTargetsFromGuards } from "../lib/domains/worker/functions/helpers/mutation-guards.js";

const __filename = fileURLToPath(import.meta.url);
const repoDir = path.resolve(path.dirname(__filename), "..");

describe("scope class contract", () => {
  it("keeps Scope and MutationPolicy in lib/shared/scope/classes", () => {
    const expected = [
      path.join(repoDir, "lib", "shared", "scope", "classes", "Scope.js"),
      path.join(repoDir, "lib", "shared", "scope", "classes", "MutationPolicy.js"),
    ];
    for (const file of expected) {
      assert.equal(fs.existsSync(file), true, `missing class file: ${file}`);
    }
  });

  it("builds immutable scope from payload and detects conflicts", () => {
    const scope = Scope.fromPayload({
      files_to_modify: ["src/app.js"],
      files_to_create: ["src/new.js"],
      files_to_delete: ["tmp/old.txt"],
      create_roots: ["assets"],
    });
    const other = new Scope({
      modifyFiles: ["src/app.js"],
      createRoots: [],
    });
    assert.equal(scope.contains("src/app.js"), true);
    assert.equal(scope.contains("assets/logo.png"), true);
    assert.equal(scope.contains("docs/readme.md"), false);
    assert.equal(scope.conflictsWith(other), true);
    assert.equal(scope.conflictsWith(new Scope({ createRoots: ["assets/icons"] })), true);
    assert.equal(Object.isFrozen(scope.modifyFiles), true);
  });

  it("validates out-of-scope commit paths through MutationPolicy", () => {
    const scope = new Scope({
      modifyFiles: ["src/app.js"],
      createRoots: ["assets"],
    });
    const policy = new MutationPolicy({ scope });
    const result = policy.validateCommit({
      filesCommitted: ["src/app.js", "assets/logo.png", "README.md"],
      filesReverted: ["assets/ghost.png"],
    });
    assert.equal(result.valid, false);
    assert.deepEqual(result.outOfScopeCommitted, ["README.md"]);
    assert.deepEqual(result.outOfScopeReverted, []);
  });

  it("does not allow create roots to match sibling paths outside cwd", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "posse-scope-policy-"));
    try {
      const sibling = path.resolve(root, "..", "sibling");
      const policy = MutationPolicy.fromScopeSpec({ createRoots: [sibling] }, { cwd: root });
      assert.equal(policy.canCreate(path.join(sibling, "leak.txt")), false);
      assert.equal(policy.canCreate(path.join(root, "inside.txt")), false);

      const wildcard = MutationPolicy.fromScopeSpec({ createRoots: ["*"] }, { cwd: root });
      assert.equal(wildcard.canCreate(path.join(root, "inside.txt")), true);
      assert.equal(wildcard.canCreate(path.join(sibling, "leak.txt")), false);

      const artifactRoot = path.resolve(root, "..", ".posse", "resources", "artifacts", "wi-1", "report");
      const artifactPolicy = MutationPolicy.fromScopeSpec({ createRoots: [artifactRoot] }, { cwd: root });
      assert.equal(artifactPolicy.canCreate(path.join(artifactRoot, "output.md")), true);
      assert.equal(artifactPolicy.canCreate(path.join(sibling, "leak.txt")), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("routes runtime mutation guards through MutationPolicy", () => {
    const source = fs.readFileSync(
      path.join(repoDir, "lib", "domains", "worker", "functions", "helpers", "mutation-guards.js"),
      "utf8",
    );
    assert.match(source, /MutationPolicy\.fromJob/);

    const targets = scopedDeleteTargetsFromGuards(
      { title: "Remove the stale asset" },
      {
        files_to_delete: ["tmp/old.txt"],
        task_spec: "Delete `assets/dead.png` from the bundle.",
      },
    );
    assert.deepEqual(targets.sort(), ["assets/dead.png", "tmp/old.txt"].sort());
  });

  it("does not infer code identifiers as deletion targets for code-removal edits", () => {
    const targets = scopedDeleteTargetsFromGuards(
      { title: "Fix autoPlay in mpegts-player effect deps causing unnecessary player teardown" },
      {
        files_to_delete: [],
        task_spec: [
          "In apps/web/src/components/player/mpegts-player.tsx, remove `autoPlay` from the effect dependency array.",
          "Change `}, [src, type, autoPlay])` to `}, [src, type])`.",
          "Use `autoPlayRef.current = autoPlay` and call `player.play()` when needed.",
        ].join("\n"),
        success_criteria: [
          "`onErrorRef.current` is still updated.",
          "`apps/web/src/components/player/mpegts-player.tsx` is the only file edited.",
        ],
      },
    );

    assert.deepEqual(targets, []);
  });

  it("rejects env-dumping bash commands so dev role cannot read process env", () => {
    const policy = new MutationPolicy({
      scope: new Scope({ modifyFiles: ["src/app.js"] }),
    });
    for (const cmd of ["env", "env --version", "printenv", "printenv POSSE_API_KEY", "echo %POSSE_API_KEY%", "echo $POSSE_API_KEY"]) {
      const result = policy.authorizeBash(cmd, { hasFileScope: true });
      assert.equal(result.ok, false, `expected ${cmd} to be rejected`);
    }
    assert.equal(policy.authorizeBash("npm test", { hasFileScope: true }).ok, true);
  });

  it("blocks allowlisted bash readers from reading sensitive env files", () => {
    const policy = new MutationPolicy({
      scope: new Scope({ modifyFiles: ["src/app.js"] }),
    });
    for (const cmd of ["sort .env", "od -c .env.local", "xxd config/.env.production", "nl ./.env", "strings .env.test", "diff .env /dev/null"]) {
      const result = policy.authorizeBash(cmd, { hasFileScope: true });
      assert.equal(result.ok, false, `expected ${cmd} to be rejected`);
      assert.match(result.error, /Access to \.env files is blocked/);
    }
  });
});
