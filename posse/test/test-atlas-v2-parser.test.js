// @ts-check
//
// Workstream C parser tests.
//
// Golden invariants the contract requires:
//   - Same bytes → same content_hash, same symbols, same edges (order
//     determined by source position).
//   - Every emitted path is canonical repo-relative form.
//   - Path-rewriting collapses absolute paths regardless of where the
//     repo is mounted (this is the key load-bearing change for v2).
//   - Unsupported languages throw a clear error without partial output.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ParserAdapter,
  parseBuffer,
  sharedParserAdapter,
} from "../lib/domains/atlas/functions/v2/parser/adapter.js";
import {
  normalizeRepoPath,
  isCanonicalRepoPath,
  canonicalRepoPathOrThrow,
} from "../lib/domains/atlas/functions/v2/parser/normalize.js";
import {
  LANGUAGES,
  resolveLanguage,
  supportedLanguageTags,
} from "../lib/domains/atlas/functions/v2/parser/languages/index.js";
import { extractWithTreeSitter } from "../lib/domains/atlas/functions/v2/parser/treesitter/walker.js";
import { sha256Hex } from "../lib/domains/atlas/functions/v2/hash.js";
import { scipDocumentToParseResult } from "../lib/domains/atlas/functions/v2/scip/to-rows.js";

function makeTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `atlas-v2-parser-${prefix}-`));
}

// ---------------------------------------------------------------------------
// Path canonicalization — the load-bearing rewrite.
// ---------------------------------------------------------------------------

describe("normalizeRepoPath", () => {
  it("forces forward slashes, strips ./ and trailing /", () => {
    assert.equal(normalizeRepoPath("./src/a.ts"), "src/a.ts");
    assert.equal(normalizeRepoPath("src\\b\\c.ts"), "src/b/c.ts");
    assert.equal(normalizeRepoPath("src/d/"), "src/d");
    assert.equal(normalizeRepoPath("  src/e.ts  "), "src/e.ts");
  });

  it("rejects absolute, parent-escape, empty", () => {
    assert.equal(normalizeRepoPath("/etc/passwd"), "");
    assert.equal(normalizeRepoPath("C:/Users/x"), "");
    assert.equal(normalizeRepoPath("../escape"), "");
    assert.equal(normalizeRepoPath(""), "");
    assert.equal(normalizeRepoPath("a/../../escape"), "");
  });
});

describe("canonicalRepoPathOrThrow", () => {
  it("produces same canonical form regardless of where repo is mounted", () => {
    const repoA = path.join(os.tmpdir(), "repoA");
    const repoB = path.join(os.tmpdir(), "deeply", "nested", "repoB");
    const fileA = path.join(repoA, "src", "x.ts");
    const fileB = path.join(repoB, "src", "x.ts");
    assert.equal(canonicalRepoPathOrThrow(fileA, repoA), "src/x.ts");
    assert.equal(canonicalRepoPathOrThrow(fileB, repoB), "src/x.ts");
  });

  it("throws when path escapes repo root", () => {
    const repo = path.join(os.tmpdir(), "repoX");
    const outside = path.join(os.tmpdir(), "elsewhere", "f.ts");
    assert.throws(() => canonicalRepoPathOrThrow(outside, repo), /not inside/);
  });
});

describe("SCIP row conversion", () => {
  it("uses the tightest equal-start enclosing definition for reference edges", () => {
    const parsed = (name, kind = "method") => ({
      scheme: "scip-js",
      manager: "npm",
      package_name: "pkg",
      package_version: "1.0.0",
      descriptors: [{ name, kind }],
      local: false,
    });
    const symbolsBySymbol = new Map([
      ["outer", { display_name: "outer", documentation: [] }],
      ["inner", { display_name: "inner", documentation: [] }],
    ]);
    const document = /** @type {any} */ ({
      content_hash: sha256Hex("same-start-enclosers"),
      language: "typescript",
      symbolsBySymbol,
      definitionLocalIds: [["outer", 0], ["inner", 1]],
      definitionIntervals: [
        { start: 0, end: 100, local_id: 0 },
        { start: 0, end: 20, local_id: 1 },
      ],
      occurrences: [
        {
          raw: { symbol: "outer", symbol_roles: 1 },
          parsed: parsed("outer"),
          start: 0,
          end: 10,
          range_start_line: 1,
          range_end_line: 1,
        },
        {
          raw: { symbol: "inner", symbol_roles: 1 },
          parsed: parsed("inner"),
          start: 0,
          end: 5,
          range_start_line: 1,
          range_end_line: 1,
        },
        {
          raw: { symbol: "dep", symbol_roles: 8 },
          parsed: parsed("dep", "term"),
          start: 10,
          end: 11,
          range_start_line: 2,
          range_end_line: 2,
        },
      ],
    });

    const result = scipDocumentToParseResult({
      cache: /** @type {any} */ ({ definitionBySymbol: new Map() }),
      document,
      repo_rel_path: "src/same.ts",
      bindExternal: () => 42,
      lang: "typescript",
    });

    assert.equal(result.edges[0].from_local_id, 1);
  });
});

// ---------------------------------------------------------------------------
// Language registry.
// ---------------------------------------------------------------------------

describe("language registry", () => {
  it("resolves by extension and by tag", () => {
    assert.equal(resolveLanguage(".ts")?.tag, "ts");
    assert.equal(resolveLanguage("ts")?.tag, "ts");
    assert.equal(resolveLanguage(".PY")?.tag, "py");
  });

  it("returns null for unknown extensions", () => {
    assert.equal(resolveLanguage(".xyz"), null);
    assert.equal(resolveLanguage(""), null);
  });

  it("reports every language as supported", () => {
    const supported = supportedLanguageTags().sort();
    assert.deepEqual(
      supported,
      ["c", "cpp", "cs", "go", "java", "js", "kt", "php", "py", "rs", "sh", "ts"].sort(),
    );
  });

  it("contains the full set of language slots the plan calls for", () => {
    const all = LANGUAGES.map((d) => d.tag).sort();
    assert.deepEqual(
      all,
      ["c", "cpp", "cs", "go", "java", "js", "kt", "php", "py", "rs", "sh", "ts"].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// JS/TS extraction.
// ---------------------------------------------------------------------------

const TS_SAMPLE = `import { Foo } from "./foo.js";
import Bar from "./bar.js";

export interface Greeting extends Foo {
  hello(): string;
}

export class Greeter extends Bar implements Greeting {
  public hello(): string { return "hi"; }
  private name: string = "";
}

export type Loud = string;

export const CONFIG = { a: 1 };
export async function loud(name: string): Promise<Loud> {
  return name.toUpperCase();
}
`;

describe("JS/TS extractor", () => {
  it("captures class, interface, type, const, function, method", () => {
    const r = parseBuffer({
      bytes: TS_SAMPLE,
      repo_rel_path: "src/greeting.ts",
    });
    const kinds = new Set(r.symbols.map((s) => String(s.kind)));
    for (const expected of ["class", "interface", "type", "const", "function", "method"]) {
      assert.ok(kinds.has(expected), `expected kind ${expected} in ${[...kinds].join(",")}`);
    }
    const names = r.symbols.map((s) => s.name).sort();
    for (const expected of ["Greeting", "Greeter", "Loud", "CONFIG", "loud", "hello"]) {
      assert.ok(names.includes(expected), `missing ${expected} in ${names.join(",")}`);
    }
  });

  it("captures extends/implements edges with high confidence", () => {
    const r = parseBuffer({ bytes: TS_SAMPLE, repo_rel_path: "src/greeting.ts" });
    const extendsEdges = r.edges.filter((e) => e.kind === "extends").map((e) => e.to_name);
    const implementsEdges = r.edges.filter((e) => e.kind === "implements").map((e) => e.to_name);
    assert.ok(extendsEdges.includes("Bar"), "Greeter should extend Bar");
    assert.ok(extendsEdges.includes("Foo"), "Greeting should extend Foo");
    assert.ok(implementsEdges.includes("Greeting"), "Greeter should implement Greeting");
  });

  it("captures import edges", () => {
    const r = parseBuffer({ bytes: TS_SAMPLE, repo_rel_path: "src/greeting.ts" });
    const importEdges = r.edges.filter((e) => e.kind === "imports").map((e) => e.to_name);
    assert.ok(importEdges.includes("Foo"));
    assert.ok(importEdges.includes("Bar"));
  });

  it("routes TSX through the TSX grammar while preserving the ts tag", () => {
    const src = `import React from "react";

type ButtonProps = { label: string };

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ label }, ref) => <button ref={ref}>{label}</button>,
);

export function App() {
  return <Button label="Launch" />;
}
`;
    const r = parseBuffer({ bytes: src, repo_rel_path: "src/App.tsx" });
    assert.equal(r.hasError, false);
    assert.equal(r.lang, "ts");
    assert.ok(r.symbols.every((symbol) => symbol.lang === "ts"));
    const names = r.symbols.map((s) => s.name).sort();
    assert.ok(names.includes("Button"));
    assert.ok(names.includes("ButtonProps"));
    assert.ok(names.includes("App"));
  });

  it("routes JSX through the TSX grammar while preserving the js tag", () => {
    const src = `import React from "react";

export function Widget() {
  return <section data-kind="widget" />;
}
`;
    const r = parseBuffer({ bytes: src, repo_rel_path: "src/Widget.jsx" });
    assert.equal(r.hasError, false);
    assert.equal(r.lang, "js");
    assert.ok(r.symbols.every((symbol) => symbol.lang === "js"));
    assert.ok(r.symbols.some((symbol) => symbol.name === "Widget"));
  });

  it("preserves local and exported names for aliased named imports", () => {
    const r = parseBuffer({
      bytes: 'import { Foo as RenamedFoo } from "./foo.js";\nexport function run() { return RenamedFoo(); }\n',
      repo_rel_path: "src/alias.ts",
    });
    const edge = r.edges.find((e) => e.kind === "imports" && e.to_name === "RenamedFoo");
    assert.ok(edge, "aliased import should be keyed by the local binding");
    assert.equal(edge.to_module, "./foo.js#Foo");
    const callTargets = r.edges.filter((e) => e.kind === "calls").map((e) => e.to_name);
    assert.ok(callTargets.includes("RenamedFoo"));
  });

  it("produces a deterministic content_hash", () => {
    const r1 = parseBuffer({ bytes: TS_SAMPLE, repo_rel_path: "src/g.ts" });
    const r2 = parseBuffer({ bytes: TS_SAMPLE, repo_rel_path: "src/g.ts" });
    assert.equal(r1.content_hash, r2.content_hash);
    assert.equal(r1.content_hash, sha256Hex(Buffer.from(TS_SAMPLE)));
  });

  it("emits canonical repo paths on every symbol and edge", () => {
    const r = parseBuffer({ bytes: TS_SAMPLE, repo_rel_path: "src/greeting.ts" });
    for (const s of r.symbols) assert.ok(isCanonicalRepoPath(s.repo_rel_path));
    // Edges don't carry a path field of their own (per EdgeRow), but they
    // do reference local_ids back to symbols on the same path.
    const localIds = new Set(r.symbols.map((s) => s.local_id));
    for (const e of r.edges) assert.ok(localIds.has(e.from_local_id));
  });

  it("marks recovered tree-sitter parse errors without warning by default", () => {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.join(" ")); };
    try {
      const r = parseBuffer({
        bytes: "export function kept() { return 1; }\nexport function broken(",
        repo_rel_path: "src/broken.ts",
      });
      assert.equal(r.hasError, true);
      assert.ok(r.symbols.some((symbol) => symbol.name === "kept"));
    } finally {
      console.warn = originalWarn;
    }
    assert.deepEqual(warnings, []);
  });

  it("continues walking when a spec callback fails for one node", () => {
    // Uses the Go grammar: the JS-side walker only hosts the languages that
    // have not yet cut over to the native parser (js/ts grammars moved into
    // the binary), and what's under test is the walker's per-node try/catch,
    // not any particular grammar.
    const src = "package main\n\nfunc kept() int { return 1 }\n";
    const r = extractWithTreeSitter({
      content_hash: sha256Hex(src),
      repo_rel_path: "src/kept.go",
      source: src,
      spec: {
        lang: "go",
        symbolOf(node) {
          if (node.type === "source_file") throw new Error("boom");
          if (node.type !== "function_declaration") return null;
          const name = node.childForFieldName("name")?.text || "";
          return { kind: "function", name };
        },
        edgesOf(node) {
          if (node.type === "identifier") throw new Error("edge boom");
          return null;
        },
      },
    });
    assert.ok(r.symbols.some((symbol) => symbol.name === "kept"));
  });
});

// ---------------------------------------------------------------------------
// Python extraction.
// ---------------------------------------------------------------------------

const PY_SAMPLE = `from typing import List
import os

CONSTANT = 42

class Greeter(Base):
    def __init__(self, name):
        self.name = name

    def hello(self):
        return "hi"

def standalone(x):
    return x + 1
`;

describe("JS/TS calls edges", () => {
  it("emits calls edges from function bodies", () => {
    const SRC = `function helper(x) { return x + 1; }
function caller(x) {
  const y = helper(x);
  return helper(y);
}`;
    const r = parseBuffer({ bytes: SRC, repo_rel_path: "src/calls.ts" });
    const caller = r.symbols.find((s) => s.name === "caller");
    assert.ok(caller, "caller fn should be extracted");
    const callEdges = r.edges.filter((e) => e.kind === "calls");
    assert.ok(callEdges.length >= 2, `expected >=2 calls edges; got ${callEdges.length}`);
    assert.ok(callEdges.every((e) => e.from_local_id === caller.local_id),
      "every call edge should attribute to caller");
    assert.ok(callEdges.every((e) => e.to_name === "helper"),
      "every call edge should target helper");
  });

  it("emits calls edges from arrow-function block bodies", () => {
    const SRC = `function helper() { return 1; }
const caller = () => {
  return helper();
};`;
    const r = parseBuffer({ bytes: SRC, repo_rel_path: "src/arrow.ts" });
    const caller = r.symbols.find((s) => s.name === "caller");
    assert.ok(caller);
    const callEdges = r.edges.filter((e) => e.kind === "calls" && e.from_local_id === caller.local_id);
    assert.ok(callEdges.some((e) => e.to_name === "helper"),
      "arrow caller should have a calls edge to helper");
  });

  it("does NOT emit calls edges for keywords (if/for/while/return/etc.)", () => {
    const SRC = `function f(x) {
  if (x) return x;
  for (let i = 0; i < 3; i++) {}
  while (x) break;
}`;
    const r = parseBuffer({ bytes: SRC, repo_rel_path: "src/kw.ts" });
    const callEdges = r.edges.filter((e) => e.kind === "calls");
    const targets = callEdges.map((e) => e.to_name);
    for (const kw of ["if", "for", "while", "return"]) {
      assert.ok(!targets.includes(kw), `should not emit calls edge for keyword ${kw}`);
    }
  });
});

describe("scope-shadowed imported calls", () => {
  function assertNoCallTo(bytes, repo_rel_path, target) {
    const r = parseBuffer({ bytes, repo_rel_path });
    const calls = r.edges.filter((e) => e.kind === "calls").map((e) => e.to_name);
    assert.ok(!calls.includes(target), `expected no call edge to ${target}; got [${calls.join(", ")}]`);
    const imports = r.edges.filter((e) => e.kind === "imports");
    assert.ok(imports.length > 0, "fixture should still emit import edges");
  }

  it("drops JS/TS imported call edges shadowed by a local binding", () => {
    assertNoCallTo([
      'import { helper } from "./helpers";',
      "function caller() {",
      "  const helper = () => 1;",
      "  return helper();",
      "}",
    ].join("\n"), "src/shadow.ts", "helper");
  });

  it("drops Python imported call edges shadowed by a local binding", () => {
    assertNoCallTo([
      "from helpers import helper",
      "def caller():",
      "    def helper():",
      "        return 1",
      "    return helper()",
    ].join("\n"), "pkg/shadow.py", "helper");
  });

  it("drops Rust imported call edges shadowed by a local binding", () => {
    assertNoCallTo([
      "use crate::helpers::helper;",
      "fn caller() {",
      "  fn helper() -> u32 { 1 }",
      "  helper();",
      "}",
    ].join("\n"), "src/shadow.rs", "helper");
  });

  it("drops Go imported selector call edges shadowed by a local binding", () => {
    assertNoCallTo([
      "package main",
      'import "fmt"',
      "type local struct{}",
      "func (local) Println() {}",
      "func caller() {",
      "  fmt := local{}",
      "  fmt.Println()",
      "}",
    ].join("\n"), "shadow.go", "fmt.Println");
  });

  it("drops Java imported call edges shadowed by a local binding", () => {
    assertNoCallTo([
      "import static pkg.Helpers.helper;",
      "class C {",
      "  void helper() {}",
      "  void run() { helper(); }",
      "}",
    ].join("\n"), "src/Shadow.java", "helper");
  });

  it("drops Kotlin imported call edges shadowed by a local binding", () => {
    assertNoCallTo([
      "import pkg.helper",
      "fun caller() {",
      "  fun helper() {}",
      "  helper()",
      "}",
    ].join("\n"), "src/Shadow.kt", "helper");
  });

  it("drops C# imported call edges shadowed by a local binding", () => {
    assertNoCallTo([
      "using Helper = System.Func<int>;",
      "class C {",
      "  void Run() {",
      "    Helper Helper = () => 1;",
      "    Helper();",
      "  }",
      "}",
    ].join("\n"), "src/Shadow.cs", "Helper");
  });

  it("drops PHP imported call edges shadowed by a local binding", () => {
    assertNoCallTo([
      "<?php",
      "use function Acme\\helper;",
      "function caller() {",
      "  function helper() { return 1; }",
      "  return helper();",
      "}",
    ].join("\n"), "src/shadow.php", "helper");
  });
});

describe("Python extractor", () => {
  it("captures class, function, method, const, and inheritance edge", () => {
    const r = parseBuffer({ bytes: PY_SAMPLE, repo_rel_path: "pkg/greet.py" });
    assert.equal(r.lang, "py");
    const names = r.symbols.map((s) => s.name).sort();
    assert.ok(names.includes("Greeter"));
    assert.ok(names.includes("standalone"));
    assert.ok(names.includes("hello"));
    assert.ok(names.includes("CONSTANT"));

    const hello = r.symbols.find((s) => s.name === "hello");
    assert.ok(hello);
    assert.equal(hello.kind, "method");
    assert.equal(hello.qualified_name, "Greeter.hello");

    const extendsEdges = r.edges.filter((e) => e.kind === "extends").map((e) => e.to_name);
    assert.ok(extendsEdges.includes("Base"));
  });

  it("tags function-local closures inside methods as functions, not methods", () => {
    const r = parseBuffer({
      bytes: `class Greeter:
    def outer(self):
        def inner():
            return "hi"
        return inner()
`,
      repo_rel_path: "pkg/nested.py",
    });
    const outer = r.symbols.find((s) => s.name === "outer");
    const inner = r.symbols.find((s) => s.name === "inner");
    assert.equal(outer?.kind, "method");
    assert.equal(inner?.kind, "function");
  });

  it("emits imports as edges", () => {
    const r = parseBuffer({ bytes: PY_SAMPLE, repo_rel_path: "pkg/greet.py" });
    const imports = r.edges.filter((e) => e.kind === "imports").map((e) => e.to_name);
    assert.ok(imports.includes("List"));
    assert.ok(imports.includes("os"));
  });

  it("emits calls edges from def bodies (drives callers/callees + blast-radius)", () => {
    const SRC = `def helper(x):
    return x + 1

def caller(x):
    y = helper(x)
    return helper(y)
`;
    const r = parseBuffer({ bytes: SRC, repo_rel_path: "pkg/calls.py" });
    const caller = r.symbols.find((s) => s.name === "caller");
    assert.ok(caller, "caller def should be extracted");
    const callEdges = r.edges.filter((e) => e.kind === "calls");
    assert.ok(callEdges.length >= 2, `expected >=2 calls edges; got ${callEdges.length}`);
    assert.ok(callEdges.every((e) => e.from_local_id === caller.local_id),
      "every call edge should attribute to caller");
    assert.ok(callEdges.every((e) => e.to_name === "helper"),
      "every call edge should target helper");
  });
});

// ---------------------------------------------------------------------------
// ParserAdapter end-to-end (filesystem path).
// ---------------------------------------------------------------------------

describe("ParserAdapter.parseFile", () => {
  it("reads a file and returns a ParseResult", async (t) => {
    const tmp = makeTmp("e2e");
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const filePath = path.join(tmp, "src", "a.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "export const hi = 1;\n");

    const adapter = new ParserAdapter();
    const result = await adapter.parseFile({ absPath: filePath, repoRoot: tmp });
    assert.equal(result.repo_rel_path, "src/a.ts");
    assert.equal(result.lang, "ts");
    assert.ok(result.symbols.find((s) => s.name === "hi"));
  });

  it("uses canonical paths regardless of where the worktree is mounted", async (t) => {
    const repoA = makeTmp("loc-a");
    const repoB = makeTmp("loc-b");
    t.after(() => {
      fs.rmSync(repoA, { recursive: true, force: true });
      fs.rmSync(repoB, { recursive: true, force: true });
    });
    const src = "export class Foo {}\n";
    for (const repo of [repoA, repoB]) {
      const p = path.join(repo, "src", "foo.ts");
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, src);
    }
    const rA = await sharedParserAdapter.parseFile({
      absPath: path.join(repoA, "src", "foo.ts"),
      repoRoot: repoA,
    });
    const rB = await sharedParserAdapter.parseFile({
      absPath: path.join(repoB, "src", "foo.ts"),
      repoRoot: repoB,
    });
    // Same bytes parsed in two different worktrees must produce identical
    // identities — this is what makes results shareable.
    assert.equal(rA.content_hash, rB.content_hash);
    assert.equal(rA.repo_rel_path, rB.repo_rel_path);
    assert.deepEqual(
      rA.symbols.map((s) => `${s.local_id}:${s.name}`),
      rB.symbols.map((s) => `${s.local_id}:${s.name}`),
    );
  });

  it("supports() returns true for registered supported extensions", () => {
    const a = sharedParserAdapter;
    assert.ok(a.supports(".ts"));
    assert.ok(a.supports(".py"));
    assert.ok(a.supports(".go"));
    assert.ok(!a.supports(".xyz"));
  });

  it("languages() returns only the supported tags", () => {
    const tags = sharedParserAdapter.languages().sort();
    assert.deepEqual(tags, ["c", "cpp", "cs", "go", "java", "js", "kt", "php", "py", "rs", "sh", "ts"]);
  });

  it("throws a clear error for unsupported languages", async (t) => {
    const tmp = makeTmp("unsupp");
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const filePath = path.join(tmp, "main.rb");
    fs.writeFileSync(filePath, "puts 'hi'\n");
    await assert.rejects(
      () => sharedParserAdapter.parseFile({ absPath: filePath, repoRoot: tmp }),
      /no language|unsupported language/,
    );
  });
});

// ---------------------------------------------------------------------------
// Per-language extractor fixtures — one block per remaining language.
// ---------------------------------------------------------------------------

describe("Go extractor", () => {
  const SRC = `package main

import (
  "fmt"
  "os"
)

type Greeter struct {
  Name string
}

func (g *Greeter) Hello() string {
  return "hi"
}

func standalone() int { return 1 }

const Answer = 42
var counter = 0
`;
  it("captures functions, methods, struct, const, var", () => {
    const r = parseBuffer({ bytes: SRC, repo_rel_path: "main.go" });
    assert.equal(r.lang, "go");
    const names = r.symbols.map((s) => s.name);
    assert.ok(names.includes("Greeter"));
    assert.ok(names.includes("Hello"));
    assert.ok(names.includes("standalone"));
    assert.ok(names.includes("Answer"));
    const hello = r.symbols.find((s) => s.name === "Hello");
    assert.equal(hello?.kind, "method");
    assert.equal(hello?.qualified_name, "Greeter.Hello");
    assert.equal(hello?.visibility, "public");
  });

  it("captures imports as edges", () => {
    const r = parseBuffer({ bytes: SRC, repo_rel_path: "main.go" });
    const imps = r.edges.filter((e) => e.kind === "imports").map((e) => e.to_name);
    assert.ok(imps.includes("fmt"));
    assert.ok(imps.includes("os"));
  });

  it("uses the local package name for import edges while preserving the module path", () => {
    const src = [
      "package main",
      'import "github.com/acme/bar"',
      "func caller() {",
      "  bar.Run()",
      "}",
    ].join("\n");
    const r = parseBuffer({ bytes: src, repo_rel_path: "cmd/main.go" });
    const edge = r.edges.find((e) => e.kind === "imports" && e.to_name === "bar");
    assert.ok(edge, `expected import edge to local name bar; got ${r.edges.map((e) => e.to_name).join(", ")}`);
    assert.equal(edge.to_module, "github.com/acme/bar");
    assert.ok(!r.edges.some((e) => e.kind === "imports" && e.to_name === "github.com/acme/bar"));
  });

  it("uses the package basename before Go semantic import version suffixes", () => {
    const src = [
      "package main",
      'import "github.com/acme/bar/v2"',
      "func caller() {",
      "  bar.Run()",
      "}",
    ].join("\n");
    const r = parseBuffer({ bytes: src, repo_rel_path: "cmd/main.go" });
    const edge = r.edges.find((e) => e.kind === "imports" && e.to_name === "bar");
    assert.ok(edge, `expected import edge to local name bar; got ${r.edges.map((e) => e.to_name).join(", ")}`);
    assert.equal(edge.to_module, "github.com/acme/bar/v2");
    assert.ok(!r.edges.some((e) => e.kind === "imports" && e.to_name === "v2"));
  });
});

describe("Rust extractor", () => {
  const SRC = `use std::fmt::Display;

pub struct Greeter {
  pub name: String,
}

pub trait Hello {
  fn hello(&self) -> String;
}

impl Hello for Greeter {
  fn hello(&self) -> String { String::from("hi") }
}

pub fn standalone() -> u32 { 1 }

const ANSWER: u32 = 42;
`;
  it("captures fn, struct, trait, const, impl-for edge, use imports", () => {
    const r = parseBuffer({ bytes: SRC, repo_rel_path: "src/lib.rs" });
    assert.equal(r.lang, "rs");
    const names = r.symbols.map((s) => s.name);
    assert.ok(names.includes("Greeter"));
    assert.ok(names.includes("Hello"));
    assert.ok(names.includes("standalone"));
    assert.ok(names.includes("ANSWER"));
    const impls = r.edges.filter((e) => e.kind === "implements").map((e) => e.to_name);
    assert.ok(impls.includes("Hello"));
    const imps = r.edges.filter((e) => e.kind === "imports").map((e) => e.to_name);
    assert.deepEqual([...imps].sort(), ["Display"]);
  });

  it("attributes impl-block fns to their target struct via parent_local_id", () => {
    const r = parseBuffer({ bytes: SRC, repo_rel_path: "src/lib.rs" });
    const greeter = r.symbols.find((s) => s.name === "Greeter" && s.kind === "struct");
    const helloTrait = r.symbols.find((s) => s.name === "Hello" && s.kind === "trait");
    const traitMethod = r.symbols.find((s) => s.name === "hello" && s.kind === "method"
      && s.parent_local_id === helloTrait?.local_id);
    // The `hello` inside `impl Hello for Greeter` should be a method
    // whose parent is the Greeter struct.
    const helloMethod = r.symbols.find((s) => s.name === "hello" && s.kind === "method"
      && s.parent_local_id === greeter?.local_id);
    assert.ok(greeter, "Greeter struct symbol should exist");
    assert.ok(helloTrait, "Hello trait symbol should exist");
    assert.ok(traitMethod, "trait hello() should be parented to Hello");
    assert.equal(traitMethod.qualified_name, "Hello::hello");
    assert.ok(helloMethod, "impl-block hello() should be parented to Greeter");
    assert.equal(helloMethod.qualified_name, "Greeter::hello");
    const standalone = r.symbols.find((s) => s.name === "standalone");
    assert.equal(standalone?.kind, "function");
    assert.equal(standalone?.parent_local_id, null);
  });

  it("emits only leaf names for scoped use imports", () => {
    const src = [
      "use std::collections::HashMap;",
      "use crate::foo::bar::Baz;",
      "use std::{fmt::Display, io::Read};",
      "pub fn run() {}",
    ].join("\n");
    const r = parseBuffer({ bytes: src, repo_rel_path: "src/lib.rs" });
    const imps = r.edges.filter((e) => e.kind === "imports").map((e) => e.to_name).sort();
    assert.deepEqual(imps, ["Baz", "Display", "HashMap", "Read"]);
  });

  it("attributes impl-for edges to the target type instead of the first top-level symbol", () => {
    const src = [
      "pub const VERSION: u8 = 1;",
      "pub struct Greeter;",
      "pub trait Hello {}",
      "impl Hello for Greeter {}",
    ].join("\n");
    const r = parseBuffer({ bytes: src, repo_rel_path: "src/lib.rs" });
    const greeter = r.symbols.find((s) => s.name === "Greeter" && s.kind === "struct");
    const version = r.symbols.find((s) => s.name === "VERSION" && s.kind === "const");
    const edge = r.edges.find((e) => e.kind === "implements" && e.to_name === "Hello");
    assert.ok(greeter, "Greeter struct symbol should exist");
    assert.ok(version, "VERSION const symbol should exist");
    assert.ok(edge, "implements edge should exist");
    assert.equal(edge.from_local_id, greeter.local_id);
    assert.notEqual(edge.from_local_id, version.local_id);
  });

  it("parents impl methods even when the impl appears before the target type", () => {
    const src = [
      "impl Greeter {",
      "  fn hello(&self) {}",
      "}",
      "pub struct Greeter;",
    ].join("\n");
    const r = parseBuffer({ bytes: src, repo_rel_path: "src/lib.rs" });
    const greeter = r.symbols.find((s) => s.name === "Greeter" && s.kind === "struct");
    const hello = r.symbols.find((s) => s.name === "hello" && s.kind === "method");
    assert.ok(greeter, "Greeter struct symbol should exist");
    assert.ok(hello, "impl method should exist");
    assert.equal(hello.parent_local_id, greeter.local_id);
    assert.equal(hello.qualified_name, "Greeter::hello");
  });

  it("captures scoped macro invocation names", () => {
    const r = parseBuffer({
      bytes: "pub fn run() { vec![]; foo::bar!(); }\n",
      repo_rel_path: "src/lib.rs",
    });
    const calls = r.edges.filter((e) => e.kind === "calls").map((e) => e.to_name);
    assert.ok(calls.includes("vec!"));
    assert.ok(calls.includes("foo::bar!"));
  });
});

describe("Java extractor", () => {
  const SRC = `package com.example;

import java.util.List;

public interface Greeting {
  String hello();
}

public class Greeter extends Base implements Greeting {
  public String hello() { return "hi"; }
  private int counter = 0;
}
`;
  it("captures interface, class with extends/implements, imports", () => {
    const r = parseBuffer({ bytes: SRC, repo_rel_path: "src/Greeter.java" });
    assert.equal(r.lang, "java");
    const names = r.symbols.map((s) => s.name);
    assert.ok(names.includes("Greeting"));
    assert.ok(names.includes("Greeter"));
    assert.ok(names.includes("hello"));
    const ext = r.edges.filter((e) => e.kind === "extends").map((e) => e.to_name);
    assert.ok(ext.includes("Base"));
    const impl = r.edges.filter((e) => e.kind === "implements").map((e) => e.to_name);
    assert.ok(impl.includes("Greeting"));
    const imps = r.edges.filter((e) => e.kind === "imports").map((e) => e.to_name);
    assert.ok(imps.includes("List"));
  });

  it("attributes class methods to their enclosing class via parent_local_id", () => {
    const r = parseBuffer({ bytes: SRC, repo_rel_path: "src/Greeter.java" });
    const greeter = r.symbols.find((s) => s.name === "Greeter" && s.kind === "class");
    const helloMethod = r.symbols.find((s) => s.name === "hello" && s.kind === "method"
      && s.parent_local_id === greeter?.local_id);
    assert.ok(greeter, "Greeter class symbol should exist");
    assert.ok(helloMethod, "hello() method should be parented to Greeter");
    assert.equal(helloMethod.qualified_name, "Greeter.hello");
  });
});

describe("C# extractor", () => {
  const SRC = `using System;
using System.Collections.Generic;

namespace Acme.Greetings {
  public interface IGreeting {
    string Hello();
  }

  public class Greeter : Base, IGreeting {
    public string Hello() { return "hi"; }
  }
}
`;
  it("captures namespace, interface, class with inheritance, imports", () => {
    const r = parseBuffer({ bytes: SRC, repo_rel_path: "src/Greeter.cs" });
    assert.equal(r.lang, "cs");
    const names = r.symbols.map((s) => s.name);
    assert.ok(names.includes("Greetings"));
    assert.ok(names.includes("IGreeting"));
    assert.ok(names.includes("Greeter"));
    assert.ok(names.includes("Hello"));
    const ext = r.edges.filter((e) => e.kind === "extends").map((e) => e.to_name);
    assert.ok(ext.includes("Base"));
    assert.ok(ext.includes("IGreeting"));
    const imps = r.edges.filter((e) => e.kind === "imports").map((e) => e.to_name);
    assert.ok(imps.includes("System") || imps.includes("Generic"));
  });

  it("attributes class methods to their enclosing class via parent_local_id", () => {
    const r = parseBuffer({ bytes: SRC, repo_rel_path: "src/Greeter.cs" });
    const greeter = r.symbols.find((s) => s.name === "Greeter" && s.kind === "class");
    const helloMethod = r.symbols.find((s) => s.name === "Hello" && s.kind === "method"
      && s.parent_local_id === greeter?.local_id);
    assert.ok(greeter, "Greeter class symbol should exist");
    assert.ok(helloMethod, "Hello() method should be parented to Greeter");
    assert.equal(helloMethod.qualified_name, "Greeter.Hello");
  });
});

describe("PHP extractor", () => {
  const SRC = `<?php
namespace Acme\\Greetings;

use Acme\\Base;
use Acme\\Iface\\{IGreeting, Logger};

interface IGreeter extends IGreeting {
  public function hello(): string;
}

class Greeter extends Base implements IGreeter {
  public function hello(): string { return "hi"; }
}

function standalone(): int { return 1; }
`;
  it("captures namespace, class, interface, use imports", () => {
    const r = parseBuffer({ bytes: SRC, repo_rel_path: "src/Greeter.php" });
    assert.equal(r.lang, "php");
    const names = r.symbols.map((s) => s.name);
    assert.ok(names.includes("Greetings"));
    assert.ok(names.includes("IGreeter"));
    assert.ok(names.includes("Greeter"));
    assert.ok(names.includes("standalone"));
    const ext = r.edges.filter((e) => e.kind === "extends").map((e) => e.to_name);
    assert.ok(ext.includes("Base"));
    const impl = r.edges.filter((e) => e.kind === "implements").map((e) => e.to_name);
    assert.ok(impl.includes("IGreeter"));
    const imps = r.edges.filter((e) => e.kind === "imports").map((e) => e.to_name);
    assert.ok(imps.includes("Base"));
    assert.ok(imps.includes("IGreeting"));
  });

  it("attributes class methods via parent_local_id and avoids duplicate function emission", () => {
    const r = parseBuffer({ bytes: SRC, repo_rel_path: "src/Greeter.php" });
    const greeter = r.symbols.find((s) => s.name === "Greeter" && s.kind === "class");
    const helloMethod = r.symbols.find((s) => s.name === "hello" && s.kind === "method"
      && s.parent_local_id === greeter?.local_id);
    assert.ok(greeter, "Greeter class symbol should exist");
    assert.ok(helloMethod, "hello() should be a method parented to Greeter");
    assert.equal(helloMethod.qualified_name, "Greeter::hello");
    // The funcRe pass should NOT have emitted a duplicate `function`
    // symbol for the same method (those used to land as siblings).
    const helloAsFunction = r.symbols.filter(
      (s) => s.name === "hello" && s.kind === "function",
    );
    assert.equal(helloAsFunction.length, 0,
      "hello should not also appear as a top-level function");
  });
});

describe("Kotlin extractor", () => {
  const SRC = `package com.example

import kotlin.collections.List

interface Greeting {
  fun hello(): String
}

class Greeter(val name: String) : Base(), Greeting {
  override fun hello(): String = "hi"
}

val ANSWER: Int = 42
fun standalone(): Int = 1
`;
  it("captures class, interface, fun, val/var, imports", () => {
    const r = parseBuffer({ bytes: SRC, repo_rel_path: "src/Greeter.kt" });
    assert.equal(r.lang, "kt");
    const names = r.symbols.map((s) => s.name);
    assert.ok(names.includes("Greeting"));
    assert.ok(names.includes("Greeter"));
    assert.ok(names.includes("hello"));
    assert.ok(names.includes("standalone"));
    assert.ok(names.includes("ANSWER"));
    const imps = r.edges.filter((e) => e.kind === "imports").map((e) => e.to_name);
    assert.ok(imps.includes("List"));
  });

  it("attributes class methods via parent_local_id; top-level funs stay parentless", () => {
    const r = parseBuffer({ bytes: SRC, repo_rel_path: "src/Greeter.kt" });
    const greeter = r.symbols.find((s) => s.name === "Greeter" && s.kind === "class");
    const helloMethod = r.symbols.find((s) => s.name === "hello" && s.kind === "method"
      && s.parent_local_id === greeter?.local_id);
    assert.ok(greeter, "Greeter class symbol should exist");
    assert.ok(helloMethod, "hello() should be a method parented to Greeter");
    assert.equal(helloMethod.qualified_name, "Greeter.hello");
    const standalone = r.symbols.find((s) => s.name === "standalone");
    assert.equal(standalone?.kind, "function");
    assert.equal(standalone?.parent_local_id, null);
  });

  it("captures object declarations as searchable symbols", () => {
    const src = [
      "package com.example",
      "object Registry {",
      "  fun load(): Int = 1",
      "}",
    ].join("\n");
    const r = parseBuffer({ bytes: src, repo_rel_path: "src/Registry.kt" });
    const registry = r.symbols.find((s) => s.name === "Registry");
    assert.ok(registry, "Kotlin object declaration should be emitted");
    assert.equal(registry.kind, "namespace");
    const load = r.symbols.find((s) => s.name === "load");
    assert.equal(load?.parent_local_id, registry.local_id);
  });
});

describe("Shell extractor", () => {
  const SRC = `#!/bin/bash
source ./helpers.sh
. ./more.sh

function greet {
  echo "hi"
}

farewell() {
  echo "bye"
}
`;
  it("captures both function forms and source-includes", () => {
    const r = parseBuffer({ bytes: SRC, repo_rel_path: "script.sh" });
    assert.equal(r.lang, "sh");
    const names = r.symbols.map((s) => s.name);
    assert.ok(names.includes("greet"));
    assert.ok(names.includes("farewell"));
    const imps = r.edges.filter((e) => e.kind === "imports").map((e) => e.to_name);
    assert.ok(imps.some((p) => p.includes("helpers.sh")));
    assert.ok(imps.some((p) => p.includes("more.sh")));
    const calls = r.edges.filter((e) => e.kind === "calls").map((e) => e.to_name);
    assert.ok(calls.includes("source"));
    assert.ok(calls.includes("."));
    assert.ok(calls.includes("echo"));
  });
});

describe("C extractor", () => {
  const SRC = `#include <stdio.h>
#include "local.h"

typedef struct Point { int x; int y; } Point;

enum Color { Red, Green };

int add(int a, int b) {
  helper();
  return a + b;
}

static void helper(void);
`;
  it("captures typedef, struct, enum, function, includes", () => {
    const r = parseBuffer({ bytes: SRC, repo_rel_path: "src/math.c" });
    assert.equal(r.lang, "c");
    const names = r.symbols.map((s) => s.name);
    assert.ok(names.includes("Point"));
    assert.ok(names.includes("Color"));
    assert.ok(names.includes("add"));
    const imps = r.edges.filter((e) => e.kind === "imports").map((e) => e.to_name);
    assert.ok(imps.includes("stdio.h"));
    assert.ok(imps.includes("local.h"));
    const calls = r.edges.filter((e) => e.kind === "calls").map((e) => e.to_name);
    assert.ok(calls.includes("helper"), `expected C call edge to helper; got [${calls.join(", ")}]`);
  });
});

describe("C++ extractor", () => {
  const SRC = `#include <string>

class Base {
public:
  virtual int answer() { return 42; }
};

class Greeter : public Base {
public:
  int answer() { return 7; }
};

int main() {
  Greeter g;
  return g.answer();
}
`;
  it("captures classes with inheritance, methods, includes", () => {
    const r = parseBuffer({ bytes: SRC, repo_rel_path: "src/main.cpp" });
    assert.equal(r.lang, "cpp");
    const names = r.symbols.map((s) => s.name);
    assert.ok(names.includes("Base"));
    assert.ok(names.includes("Greeter"));
    assert.ok(names.includes("main"));
    const ext = r.edges.filter((e) => e.kind === "extends").map((e) => e.to_name);
    assert.ok(ext.includes("Base"));
    const imps = r.edges.filter((e) => e.kind === "imports").map((e) => e.to_name);
    assert.ok(imps.includes("string"));
    const calls = r.edges.filter((e) => e.kind === "calls").map((e) => e.to_name);
    assert.ok(calls.includes("g.answer"), `expected C++ call edge to g.answer; got [${calls.join(", ")}]`);
  });

  it("attributes in-body member functions to their enclosing class via parent_local_id", () => {
    const r = parseBuffer({ bytes: SRC, repo_rel_path: "src/main.cpp" });
    const base = r.symbols.find((s) => s.name === "Base" && s.kind === "class");
    const greeter = r.symbols.find((s) => s.name === "Greeter" && s.kind === "class");
    assert.ok(base && greeter, "both class symbols should exist");
    const baseMethods = r.symbols.filter((s) => s.parent_local_id === base.local_id);
    const greeterMethods = r.symbols.filter((s) => s.parent_local_id === greeter.local_id);
    assert.ok(baseMethods.some((s) => s.name === "answer" && s.kind === "method"),
      "Base::answer should be parented to Base");
    assert.ok(greeterMethods.some((s) => s.name === "answer" && s.kind === "method"),
      "Greeter::answer should be parented to Greeter (separate from Base::answer)");
    // main() stays a top-level function.
    const mainFn = r.symbols.find((s) => s.name === "main");
    assert.equal(mainFn?.kind, "function");
    assert.equal(mainFn?.parent_local_id, null);
  });
});

// ---------------------------------------------------------------------------
// Regression coverage for the language-parser bug pass.
// ---------------------------------------------------------------------------

describe("language parser regressions", () => {
  it("L3: JS class field initializers don't emit phantom methods", () => {
    const src = [
      "class Component {",
      "  static defaults = makeDefaults(arg, other);",
      "  static handler = obj.run(thing);",
      "  realMethod() { return 1; }",
      "}",
    ].join("\n");
    const r = parseBuffer({ bytes: src, repo_rel_path: "src/field-init.ts" });
    const methodNames = r.symbols.filter((s) => s.kind === "method").map((s) => s.name);
    assert.ok(methodNames.includes("realMethod"), `expected realMethod; got [${methodNames.join(", ")}]`);
    assert.ok(!methodNames.includes("makeDefaults"), "makeDefaults is a call expression, not a method");
    assert.ok(!methodNames.includes("run"), "obj.run is a call expression, not a method");
  });

  it("L4: Go function-local const/var/type don't leak to top level", () => {
    const src = [
      "package main",
      "const TOP = 1",
      "var Counter = 0",
      "type Outer struct { name string }",
      "func work() {",
      "  const localK = 99",
      "  var localV = 5",
      "  type localT int",
      "}",
    ].join("\n");
    const r = parseBuffer({ bytes: src, repo_rel_path: "src/scope.go" });
    const names = new Set(r.symbols.map((s) => s.name));
    assert.ok(names.has("TOP"));
    assert.ok(names.has("Counter"));
    assert.ok(names.has("Outer"));
    assert.ok(!names.has("localK"), "function-local const leaked");
    assert.ok(!names.has("localV"), "function-local var leaked");
    assert.ok(!names.has("localT"), "function-local type leaked");
  });

  it("L5/L11: Kotlin val/var — locals are dropped, class members get parent attribution", () => {
    const src = [
      "class Box {",
      "  val name: String = \"x\"",
      "  var counter: Int = 0",
      "",
      "  fun process() {",
      "    val local = 5",
      "    var localCount = 0",
      "  }",
      "}",
      "val TOP_LEVEL = 7",
    ].join("\n");
    const r = parseBuffer({ bytes: src, repo_rel_path: "src/scope.kt" });
    const namesToSyms = new Map(r.symbols.map((s) => [s.name, s]));
    assert.ok(namesToSyms.has("name"), "class member val should be captured");
    assert.ok(namesToSyms.has("counter"), "class member var should be captured");
    assert.ok(namesToSyms.has("TOP_LEVEL"), "top-level val should be captured");
    assert.ok(!namesToSyms.has("local"), "function-local val leaked");
    assert.ok(!namesToSyms.has("localCount"), "function-local var leaked");

    const boxSym = namesToSyms.get("Box");
    assert.ok(boxSym);
    assert.equal(namesToSyms.get("name")?.parent_local_id, boxSym.local_id);
    assert.equal(namesToSyms.get("counter")?.parent_local_id, boxSym.local_id);
    assert.equal(namesToSyms.get("TOP_LEVEL")?.parent_local_id, null);
  });

  it("L6+L7: Java/C# `new ClassName()` calls don't emit phantom methods", () => {
    const javaSrc = [
      "class Caller {",
      "  void run() {",
      "    Helper h = new Helper();",
      "    HelperTwo h2 = new HelperTwo(arg);",
      "  }",
      "}",
    ].join("\n");
    const javaResult = parseBuffer({ bytes: javaSrc, repo_rel_path: "src/Caller.java" });
    const javaMethods = javaResult.symbols.filter((s) => s.kind === "method").map((s) => s.name);
    assert.ok(javaMethods.includes("run"));
    assert.ok(!javaMethods.includes("Helper"), "Helper is a constructor call, not a method");
    assert.ok(!javaMethods.includes("HelperTwo"), "HelperTwo is a constructor call, not a method");

    const csSrc = [
      "class Caller {",
      "  void Run() {",
      "    var x = new Widget();",
      "    var y = new Other(arg);",
      "  }",
      "}",
    ].join("\n");
    const csResult = parseBuffer({ bytes: csSrc, repo_rel_path: "src/Caller.cs" });
    const csMethods = csResult.symbols.filter((s) => s.kind === "method").map((s) => s.name);
    assert.ok(csMethods.includes("Run"));
    assert.ok(!csMethods.includes("Widget"), "Widget is a constructor call");
    assert.ok(!csMethods.includes("Other"), "Other is a constructor call");
  });

  it("L8: Java constructors are captured (matched against declared class names)", () => {
    const src = [
      "public class Greeter {",
      "  private String name;",
      "  public Greeter(String name) {",
      "    this.name = name;",
      "  }",
      "  public String greet() { return name; }",
      "}",
    ].join("\n");
    const r = parseBuffer({ bytes: src, repo_rel_path: "src/Greeter.java" });
    const greeterSym = r.symbols.find((s) => s.name === "Greeter" && s.kind === "class");
    assert.ok(greeterSym);
    const ctor = r.symbols.find((s) => s.kind === "method" && s.name === "Greeter" && s.parent_local_id === greeterSym.local_id);
    assert.ok(ctor, "Greeter constructor should be captured as a method");
    assert.equal(ctor.qualified_name, "Greeter.Greeter");
  });

  it("L9: Python multi-line parenthesized imports capture every name", () => {
    const src = [
      "from collections import (",
      "    OrderedDict,",
      "    defaultdict,",
      "    deque as Q,",
      ")",
      "from os import path",
      // A top-level def gives finalize() something to anchor module-
      // level edges to so they survive into the result.
      "def use_them():",
      "    pass",
    ].join("\n");
    const r = parseBuffer({ bytes: src, repo_rel_path: "src/imports.py" });
    const importEdges = r.edges.filter((e) => e.kind === "imports").map((e) => e.to_name);
    assert.ok(importEdges.includes("OrderedDict"), `expected OrderedDict; got [${importEdges.join(", ")}]`);
    assert.ok(importEdges.includes("defaultdict"));
    assert.ok(importEdges.includes("deque"));
    assert.ok(importEdges.includes("path"));
    assert.ok(!importEdges.some((n) => n === "(" || n === ")"), "open/close paren shouldn't be an import");
  });

  it("L10: PHP methods without visibility modifier are captured as methods", () => {
    const src = [
      "<?php",
      "class Box {",
      "  function noVisibility() { return 1; }",
      "  public function withVisibility() { return 2; }",
      "}",
    ].join("\n");
    const r = parseBuffer({ bytes: src, repo_rel_path: "src/box.php" });
    const boxSym = r.symbols.find((s) => s.kind === "class" && s.name === "Box");
    assert.ok(boxSym);
    const methods = r.symbols.filter((s) => s.kind === "method" && s.parent_local_id === boxSym.local_id);
    const names = methods.map((m) => m.name);
    assert.ok(names.includes("noVisibility"), "no-visibility method must be captured");
    assert.ok(names.includes("withVisibility"));
    // Exactly one of each — methodRe + funcRe must not double-emit.
    assert.equal(names.filter((n) => n === "noVisibility").length, 1, "noVisibility emitted twice");
    assert.equal(names.filter((n) => n === "withVisibility").length, 1, "withVisibility emitted twice");
  });

  it("L12: Rust visibility uses word-boundary 'pub' (not substring)", () => {
    const src = [
      "pub struct PublicConfig;",
      "struct InternalConfig;",
      "pub fn open() {}",
      "fn process(input: PublicConfig) {}",
    ].join("\n");
    const r = parseBuffer({ bytes: src, repo_rel_path: "src/cfg.rs" });
    const byName = new Map(r.symbols.map((s) => [s.name, s]));
    assert.equal(byName.get("PublicConfig")?.visibility, "public");
    assert.equal(byName.get("InternalConfig")?.visibility, "private", "Internal has no `pub` keyword");
    assert.equal(byName.get("open")?.visibility, "public");
    assert.equal(byName.get("process")?.visibility, "private", "process's PublicConfig param shouldn't make process public");
  });

  it("L2: matchBraceEnd ignores `}` inside string literals (class body)", () => {
    const src = [
      "class Container {",
      "  template = \"hello } world\";",
      "  closing = '}';",
      "  realMethod() { return 1; }",
      "}",
    ].join("\n");
    const r = parseBuffer({ bytes: src, repo_rel_path: "src/strings.ts" });
    const containerSym = r.symbols.find((s) => s.kind === "class" && s.name === "Container");
    assert.ok(containerSym);
    const realMethod = r.symbols.find(
      (s) => s.kind === "method" && s.name === "realMethod" && s.parent_local_id === containerSym.local_id,
    );
    assert.ok(realMethod, "realMethod should be attributed to Container even with stringified `}` above it");
  });
});
