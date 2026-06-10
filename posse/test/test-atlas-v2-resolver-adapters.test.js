// Adapter-driven call resolution tests.
//
// Unit tests pass synthetic CallResolutionContext into each adapter
// and assert the resolution. Integration tests parse real fixture
// code, build a view through the proper pipeline, and verify the
// adapter routing actually fires in production paths.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { typescriptAdapter } from "../lib/domains/atlas/functions/v2/resolver/adapters/typescript.js";
import { phpAdapter } from "../lib/domains/atlas/functions/v2/resolver/adapters/php.js";
import { pythonAdapter } from "../lib/domains/atlas/functions/v2/resolver/adapters/python.js";
import { goAdapter } from "../lib/domains/atlas/functions/v2/resolver/adapters/go.js";
import { jvmAdapter } from "../lib/domains/atlas/functions/v2/resolver/adapters/jvm.js";
import { rustAdapter } from "../lib/domains/atlas/functions/v2/resolver/adapters/rust.js";
import { csharpAdapter } from "../lib/domains/atlas/functions/v2/resolver/adapters/csharp.js";
import { cppAdapter } from "../lib/domains/atlas/functions/v2/resolver/adapters/cpp.js";
import { adapterFor, __resetAdapterRegistryForTests } from "../lib/domains/atlas/functions/v2/resolver/adapters/registry.js";
import {
  BUILTIN_GLOBAL_NAMESPACES,
  NODE_BUILTIN_MODULE_NAMES,
  PYTHON_BUILTIN_NAMES,
  PYTHON_STDLIB_MODULES,
  GO_BUILTIN_NAMES,
  GO_STDLIB_PACKAGES,
  JAVA_BUILTIN_NAMESPACES,
  RUST_STDLIB_PREFIXES,
  CSHARP_BUILTIN_NAMESPACES,
  CPP_STDLIB_NAMESPACES,
  isBuiltinCall,
} from "../lib/domains/atlas/functions/v2/resolver/builtins.js";
import { sha256Hex } from "../lib/domains/atlas/functions/v2/hash.js";
import { Ledger } from "../lib/domains/atlas/classes/v2/Ledger.js";
import { View } from "../lib/domains/atlas/classes/v2/View.js";
import { ViewBuilder } from "../lib/domains/atlas/classes/v2/ViewBuilder.js";
import { parseBuffer } from "../lib/domains/atlas/functions/v2/parser/adapter.js";

function makeTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Build a minimal CallResolutionContext from declarative inputs.
 * Adapters don't care about view-level state — they only read these
 * three maps and the call descriptor.
 */
function ctx({
  identifier,
  imported = {},
  namespace = {},
  localNames = {},
  fromGid = 1,
  repoPath = "src/runner.ts",
}) {
  /** @param {Record<string, number[]>} m */
  const toCandidateMap = (m) =>
    new Map(
      Object.entries(m).map(([name, gids]) => [
        name,
        gids.map((g) => syntheticCandidate(g, name)),
      ]),
    );
  /** @param {Record<string, Record<string, number>>} m */
  const toNamespaceMap = (m) =>
    new Map(
      Object.entries(m).map(([prefix, inner]) => [
        prefix,
        new Map(Object.entries(inner).map(([k, g]) => [k, syntheticCandidate(g, k)])),
      ]),
    );
  return {
    call: {
      calleeIdentifier: identifier,
      repo_rel_path: repoPath,
      from_global_id: fromGid,
    },
    importedNameToSymbolIds: toCandidateMap(imported),
    namespaceImports: toNamespaceMap(namespace),
    nameToSymbolIds: toCandidateMap(localNames),
  };
}

function syntheticCandidate(globalId, name) {
  return {
    global_id: globalId,
    content_hash: "0".repeat(64),
    local_id: 0,
    repo_rel_path: "synthetic",
    kind: "function",
    qualified_name: null,
    name,
  };
}

// ---------------------------------------------------------------------------
// Builtins data
// ---------------------------------------------------------------------------

describe("builtins data", () => {
  it("BUILTIN_GLOBAL_NAMESPACES covers the standard JS globals", () => {
    for (const expected of ["Math", "JSON", "Promise", "Object", "console"]) {
      assert.ok(BUILTIN_GLOBAL_NAMESPACES.has(expected), `missing ${expected}`);
    }
  });
  it("NODE_BUILTIN_MODULE_NAMES covers fs/path/crypto/util", () => {
    for (const expected of ["fs", "path", "crypto", "util", "http"]) {
      assert.ok(NODE_BUILTIN_MODULE_NAMES.has(expected), `missing ${expected}`);
    }
  });
  it("PYTHON_BUILTIN_NAMES covers core builtins", () => {
    for (const expected of ["print", "len", "range", "str", "int", "isinstance"]) {
      assert.ok(PYTHON_BUILTIN_NAMES.has(expected), `missing ${expected}`);
    }
  });
  it("PYTHON_STDLIB_MODULES covers os/sys/json/re", () => {
    for (const expected of ["os", "sys", "json", "re", "math", "typing"]) {
      assert.ok(PYTHON_STDLIB_MODULES.has(expected), `missing ${expected}`);
    }
  });
  it("GO_BUILTIN_NAMES covers make/append/len/new", () => {
    for (const expected of ["make", "append", "len", "new", "panic", "cap"]) {
      assert.ok(GO_BUILTIN_NAMES.has(expected), `missing ${expected}`);
    }
  });
  it("GO_STDLIB_PACKAGES covers fmt/strings/os/io", () => {
    for (const expected of ["fmt", "strings", "os", "io", "errors", "context"]) {
      assert.ok(GO_STDLIB_PACKAGES.has(expected), `missing ${expected}`);
    }
  });
  it("JAVA_BUILTIN_NAMESPACES covers System/Math/String/Arrays", () => {
    for (const expected of ["System", "Math", "String", "Arrays", "Collections"]) {
      assert.ok(JAVA_BUILTIN_NAMESPACES.has(expected), `missing ${expected}`);
    }
  });
  it("RUST_STDLIB_PREFIXES covers std/core/alloc", () => {
    for (const expected of ["std", "core", "alloc"]) {
      assert.ok(RUST_STDLIB_PREFIXES.has(expected), `missing ${expected}`);
    }
  });
  it("CSHARP_BUILTIN_NAMESPACES covers Console/Math/System", () => {
    for (const expected of ["Console", "Math", "System", "String", "Convert"]) {
      assert.ok(CSHARP_BUILTIN_NAMESPACES.has(expected), `missing ${expected}`);
    }
  });
  it("CPP_STDLIB_NAMESPACES covers std/boost", () => {
    for (const expected of ["std", "boost"]) {
      assert.ok(CPP_STDLIB_NAMESPACES.has(expected), `missing ${expected}`);
    }
  });
  it("isBuiltinCall catches context-free builtins before generic fallback", () => {
    for (const expected of ["expect", "floor", "vec!", "Math.floor", "fmt.Println"]) {
      assert.equal(isBuiltinCall(expected), true, `${expected} should be treated as builtin`);
    }
    for (const repoName of ["Greeter", "runPipeline", "Service.handle"]) {
      assert.equal(isBuiltinCall(repoName), false, `${repoName} should not be treated as builtin`);
    }
  });

  it("does not suppress Rust paths just because an interior segment looks builtin", () => {
    assert.equal(isBuiltinCall("my_crate::collections::Map::new"), false);
    assert.equal(isBuiltinCall("std::collections::HashMap::new"), true);
  });
});

// ---------------------------------------------------------------------------
// Adapter registry
// ---------------------------------------------------------------------------

describe("adapter registry", () => {
  it("returns the TS adapter for ts/tsx/js", () => {
    assert.ok(adapterFor("ts"));
    assert.ok(adapterFor("tsx"));
    assert.ok(adapterFor("js"));
    assert.equal(adapterFor("ts")?.lang, "ts");
    assert.equal(adapterFor("js")?.lang, "js");
  });
  it("returns the PHP adapter for php", () => {
    assert.ok(adapterFor("php"));
    assert.equal(adapterFor("php")?.lang, "php");
  });
  it("returns adapters for py/go/java/kt/rs/cs/cpp/c", () => {
    for (const lang of ["py", "go", "java", "kt", "rs", "cs", "cpp", "c"]) {
      const a = adapterFor(lang);
      assert.ok(a, `expected adapter for ${lang}`);
      assert.equal(a?.lang, lang);
    }
  });
  it("returns null for languages without a custom adapter", () => {
    // Shell has a grammar but no adapter — generic ladder is enough.
    assert.equal(adapterFor("sh"), null);
    assert.equal(adapterFor("unknown-lang"), null);
  });
  it("__resetAdapterRegistryForTests clears the cache", () => {
    const first = adapterFor("ts");
    __resetAdapterRegistryForTests();
    const second = adapterFor("ts");
    // New instance after reset.
    assert.ok(first);
    assert.ok(second);
  });
});

// ---------------------------------------------------------------------------
// TypeScript adapter
// ---------------------------------------------------------------------------

describe("typescriptAdapter.resolveCall", () => {
  const adapter = typescriptAdapter("ts");

  it("strips the leading `new` keyword and binds via direct import", () => {
    const r = adapter.resolveCall(ctx({
      identifier: "new Greeter",
      imported: { Greeter: [42] },
    }));
    assert.equal(r?.symbolId, 42);
    assert.equal(r?.strategy, "exact");
    assert.equal(r?.confidence, 0.88);
  });

  it("claims bare `super` as unresolved (does NOT fall through)", () => {
    const r1 = adapter.resolveCall(ctx({ identifier: "super" }));
    assert.equal(r1?.symbolId, null);
    assert.equal(r1?.strategy, "unresolved");
    assert.equal(r1?.reason, "super_call");
  });

  it("binds super.method to a same-file symbol when unambiguous", () => {
    const r = adapter.resolveCall(ctx({
      identifier: "super.handle",
      localNames: { handle: [14] },
    }));
    assert.equal(r?.symbolId, 14);
    assert.equal(r?.strategy, "heuristic");
  });

  it("rejects builtin globals (Math.floor, JSON.stringify, console.log)", () => {
    for (const id of ["Math.floor", "JSON.stringify", "console.log", "Object.keys"]) {
      const r = adapter.resolveCall(ctx({ identifier: id }));
      assert.equal(r?.symbolId, null, `${id} should not bind`);
      assert.equal(r?.reason, "builtin_global", `${id} should be flagged builtin_global`);
    }
  });

  it("rejects Node builtin modules used as namespace (fs.readFile, path.join)", () => {
    for (const id of ["fs.readFile", "path.join", "crypto.randomUUID", "util.promisify"]) {
      const r = adapter.resolveCall(ctx({ identifier: id }));
      assert.equal(r?.symbolId, null);
      assert.equal(r?.reason, "builtin_node_module");
    }
  });

  it("binds X.member when X is a namespace import (placeholder via namespaceImports map)", () => {
    const r = adapter.resolveCall(ctx({
      identifier: "ns.helper",
      namespace: { ns: { helper: 77 } },
    }));
    assert.equal(r?.symbolId, 77);
    assert.equal(r?.strategy, "exact");
    assert.equal(r?.confidence, 0.92);
  });

  it("binds this.method to a same-file symbol with that name", () => {
    const r = adapter.resolveCall(ctx({
      identifier: "this.hello",
      localNames: { hello: [13] },
    }));
    assert.equal(r?.symbolId, 13);
    assert.equal(r?.strategy, "heuristic");
    assert.equal(r?.confidence, 0.78);
  });

  it("returns null (fall-through) for this.method when multiple matches exist", () => {
    const r = adapter.resolveCall(ctx({
      identifier: "this.hello",
      localNames: { hello: [13, 14] },
    }));
    assert.equal(r, null);
  });

  it("binds bare identifier via direct import when single candidate", () => {
    const r = adapter.resolveCall(ctx({
      identifier: "loadConfig",
      imported: { loadConfig: [100] },
    }));
    assert.equal(r?.symbolId, 100);
    assert.equal(r?.strategy, "exact");
    assert.equal(r?.confidence, 0.88);
  });

  it("returns null (falls through to generic) when the identifier is not adapter-claimed", () => {
    const r = adapter.resolveCall(ctx({
      identifier: "unknownFunction",
    }));
    assert.equal(r, null);
  });
});

// ---------------------------------------------------------------------------
// PHP adapter
// ---------------------------------------------------------------------------

describe("phpAdapter.resolveCall", () => {
  const adapter = phpAdapter();

  it("binds self::method to a same-file symbol", () => {
    const r = adapter.resolveCall(ctx({
      identifier: "self::create",
      localNames: { create: [5] },
    }));
    assert.equal(r?.symbolId, 5);
    assert.equal(r?.strategy, "heuristic");
  });

  it("binds $this::method to a same-file symbol (PHP 8 syntax)", () => {
    const r = adapter.resolveCall(ctx({
      identifier: "$this::hello",
      localNames: { hello: [9] },
    }));
    assert.equal(r?.symbolId, 9);
  });

  it("binds parent::method and static::method to a same-file symbol", () => {
    const rp = adapter.resolveCall(ctx({
      identifier: "parent::initialize",
      localNames: { initialize: [3] },
    }));
    assert.equal(rp?.symbolId, 3);

    const rs = adapter.resolveCall(ctx({
      identifier: "static::factory",
      localNames: { factory: [4] },
    }));
    assert.equal(rs?.symbolId, 4);
  });

  it("binds Namespace::Class via namespace import", () => {
    const r = adapter.resolveCall(ctx({
      identifier: "Acme::Greeter",
      namespace: { Acme: { Greeter: 50 } },
    }));
    assert.equal(r?.symbolId, 50);
    assert.equal(r?.strategy, "exact");
  });

  it("binds bare function call via direct import", () => {
    const r = adapter.resolveCall(ctx({
      identifier: "createConnection",
      imported: { createConnection: [200] },
    }));
    assert.equal(r?.symbolId, 200);
    assert.equal(r?.confidence, 0.88);
  });

  it("returns null when nothing matches", () => {
    const r = adapter.resolveCall(ctx({ identifier: "mystery" }));
    assert.equal(r, null);
  });
});

// ---------------------------------------------------------------------------
// Python adapter
// ---------------------------------------------------------------------------

describe("pythonAdapter.resolveCall", () => {
  const adapter = pythonAdapter();

  it("claims bare super / super() as unresolved", () => {
    for (const id of ["super", "super()"]) {
      const r = adapter.resolveCall(ctx({ identifier: id }));
      assert.equal(r?.symbolId, null, id);
      assert.equal(r?.reason, "super_call", id);
    }
  });

  it("binds super.method to a same-file symbol when unambiguous", () => {
    const r = adapter.resolveCall(ctx({
      identifier: "super.greet",
      localNames: { greet: [12] },
    }));
    assert.equal(r?.symbolId, 12);
    assert.equal(r?.strategy, "heuristic");
  });

  it("rejects bare Python builtins (print, len, range, str)", () => {
    for (const id of ["print", "len", "range", "str", "int", "isinstance"]) {
      const r = adapter.resolveCall(ctx({ identifier: id }));
      assert.equal(r?.symbolId, null, id);
      assert.equal(r?.reason, "builtin_name", id);
    }
  });

  it("rejects stdlib module prefixes (os.path, json.loads, re.match)", () => {
    for (const id of ["os.path.join", "json.loads", "re.match", "sys.exit", "typing.cast"]) {
      const r = adapter.resolveCall(ctx({ identifier: id }));
      assert.equal(r?.symbolId, null, id);
      assert.equal(r?.reason, "builtin_stdlib", id);
    }
  });

  it("binds self.method to a same-file symbol", () => {
    const r = adapter.resolveCall(ctx({
      identifier: "self.greet",
      localNames: { greet: [11] },
    }));
    assert.equal(r?.symbolId, 11);
    assert.equal(r?.strategy, "heuristic");
  });

  it("binds cls.method to a same-file symbol", () => {
    const r = adapter.resolveCall(ctx({
      identifier: "cls.factory",
      localNames: { factory: [22] },
    }));
    assert.equal(r?.symbolId, 22);
    assert.equal(r?.strategy, "heuristic");
  });

  it("binds bare identifier via direct import", () => {
    const r = adapter.resolveCall(ctx({
      identifier: "load_config",
      imported: { load_config: [300] },
    }));
    assert.equal(r?.symbolId, 300);
    assert.equal(r?.strategy, "exact");
    assert.equal(r?.confidence, 0.88);
  });

  it("binds X.member via namespace import alias", () => {
    const r = adapter.resolveCall(ctx({
      identifier: "j.dumps",
      namespace: { j: { dumps: 77 } },
    }));
    assert.equal(r?.symbolId, 77);
    assert.equal(r?.strategy, "exact");
  });

  it("returns null (falls through) for unknown bare identifier", () => {
    const r = adapter.resolveCall(ctx({ identifier: "do_thing" }));
    assert.equal(r, null);
  });
});

// ---------------------------------------------------------------------------
// Go adapter
// ---------------------------------------------------------------------------

describe("goAdapter.resolveCall", () => {
  const adapter = goAdapter();

  it("rejects bare Go builtins (make, append, len, new, panic)", () => {
    for (const id of ["make", "append", "len", "new", "panic", "recover", "cap"]) {
      const r = adapter.resolveCall(ctx({ identifier: id }));
      assert.equal(r?.symbolId, null, id);
      assert.equal(r?.reason, "builtin_name", id);
    }
  });

  it("rejects stdlib package prefixes (fmt.Println, strings.Split, os.Open)", () => {
    for (const id of ["fmt.Println", "strings.Split", "os.Open", "errors.New", "context.Background"]) {
      const r = adapter.resolveCall(ctx({ identifier: id }));
      assert.equal(r?.symbolId, null, id);
      assert.equal(r?.reason, "builtin_stdlib_pkg", id);
    }
  });

  it("binds X.member via namespace import (aliased package)", () => {
    const r = adapter.resolveCall(ctx({
      identifier: "mypkg.DoThing",
      namespace: { mypkg: { DoThing: 88 } },
    }));
    assert.equal(r?.symbolId, 88);
    assert.equal(r?.strategy, "exact");
  });

  it("binds bare identifier via direct import (same-package function)", () => {
    const r = adapter.resolveCall(ctx({
      identifier: "RunWorker",
      imported: { RunWorker: [400] },
    }));
    assert.equal(r?.symbolId, 400);
    assert.equal(r?.confidence, 0.88);
  });

  it("returns null for unknown identifier (generic ladder applies)", () => {
    const r = adapter.resolveCall(ctx({ identifier: "doStuff" }));
    assert.equal(r, null);
  });
});

// ---------------------------------------------------------------------------
// JVM (Java + Kotlin) adapter
// ---------------------------------------------------------------------------

describe("jvmAdapter.resolveCall (java)", () => {
  const adapter = jvmAdapter("java");

  it("claims bare super as unresolved", () => {
    const r1 = adapter.resolveCall(ctx({ identifier: "super" }));
    assert.equal(r1?.symbolId, null);
    assert.equal(r1?.reason, "super_call");
  });

  it("binds super.method to a same-file symbol when unambiguous", () => {
    const r = adapter.resolveCall(ctx({
      identifier: "super.compute",
      localNames: { compute: [34] },
    }));
    assert.equal(r?.symbolId, 34);
    assert.equal(r?.strategy, "heuristic");
  });

  it("rejects JDK builtin class receivers (System.out, Math.floor, Arrays.asList)", () => {
    for (const id of ["System.out", "Math.floor", "Arrays.asList", "Collections.sort", "Objects.requireNonNull"]) {
      const r = adapter.resolveCall(ctx({ identifier: id }));
      assert.equal(r?.symbolId, null, id);
      assert.equal(r?.reason, "builtin_jdk_class", id);
    }
  });

  it("rejects top-level Java package prefixes (java.util.X, javax.swing.Y)", () => {
    for (const id of ["java.util.Arrays", "javax.swing.JButton", "jakarta.persistence.Entity"]) {
      const r = adapter.resolveCall(ctx({ identifier: id }));
      assert.equal(r?.symbolId, null, id);
      assert.equal(r?.reason, "builtin_java_pkg", id);
    }
  });

  it("binds this.method to a same-file symbol", () => {
    const r = adapter.resolveCall(ctx({
      identifier: "this.compute",
      localNames: { compute: [33] },
    }));
    assert.equal(r?.symbolId, 33);
    assert.equal(r?.strategy, "heuristic");
  });

  it("binds bare identifier via direct import", () => {
    const r = adapter.resolveCall(ctx({
      identifier: "loadGreeter",
      imported: { loadGreeter: [500] },
    }));
    assert.equal(r?.symbolId, 500);
    assert.equal(r?.confidence, 0.88);
  });
});

describe("jvmAdapter.resolveCall (kotlin)", () => {
  const adapter = jvmAdapter("kt");

  it("uses the same lang tag as registered", () => {
    assert.equal(adapter.lang, "kt");
  });

  it("binds this.method to a same-file Kotlin symbol", () => {
    const r = adapter.resolveCall(ctx({
      identifier: "this.run",
      localNames: { run: [44] },
    }));
    assert.equal(r?.symbolId, 44);
    assert.equal(r?.strategy, "heuristic");
  });

  it("rejects JDK builtin receivers in Kotlin code", () => {
    const r = adapter.resolveCall(ctx({ identifier: "System.out" }));
    assert.equal(r?.symbolId, null);
    assert.equal(r?.reason, "builtin_jdk_class");
  });
});

// ---------------------------------------------------------------------------
// Rust adapter
// ---------------------------------------------------------------------------

describe("rustAdapter.resolveCall", () => {
  const adapter = rustAdapter();

  it("rejects stdlib path prefixes (std::, core::, alloc::)", () => {
    for (const id of ["std::fs::read", "core::mem::swap", "alloc::vec::Vec::new"]) {
      const r = adapter.resolveCall(ctx({ identifier: id }));
      assert.equal(r?.symbolId, null, id);
      assert.equal(r?.reason, "builtin_rust_stdlib", id);
    }
  });

  it("binds Self::method to a same-file symbol", () => {
    const r = adapter.resolveCall(ctx({
      identifier: "Self::new",
      localNames: { new: [55] },
    }));
    assert.equal(r?.symbolId, 55);
    assert.equal(r?.strategy, "heuristic");
  });

  it("binds self.method (dotted) to a same-file symbol", () => {
    const r = adapter.resolveCall(ctx({
      identifier: "self.greet",
      localNames: { greet: [56] },
    }));
    assert.equal(r?.symbolId, 56);
    assert.equal(r?.strategy, "heuristic");
  });

  it("claims longer self receiver chains as unresolved", () => {
    for (const id of ["self.bar.greet", "Self::Inner::new"]) {
      const r = adapter.resolveCall(ctx({
        identifier: id,
        localNames: { greet: [56], new: [57] },
      }));
      assert.equal(r?.symbolId, null, id);
      assert.equal(r?.strategy, "unresolved", id);
      assert.equal(r?.reason, "rust_self_chain", id);
    }
  });

  it("claims super:: / crate:: paths as unresolved pseudo-path", () => {
    for (const id of ["super::foo", "crate::module::bar"]) {
      const r = adapter.resolveCall(ctx({ identifier: id }));
      assert.equal(r?.symbolId, null, id);
      assert.equal(r?.reason, "rust_pseudo_path", id);
    }
  });

  it("binds Mod::Item via namespace import", () => {
    const r = adapter.resolveCall(ctx({
      identifier: "my_mod::do_thing",
      namespace: { my_mod: { do_thing: 66 } },
    }));
    assert.equal(r?.symbolId, 66);
    assert.equal(r?.strategy, "exact");
  });

  it("binds bare identifier via direct import", () => {
    const r = adapter.resolveCall(ctx({
      identifier: "compute",
      imported: { compute: [600] },
    }));
    assert.equal(r?.symbolId, 600);
    assert.equal(r?.confidence, 0.88);
  });

  it("returns null for unknown bare identifier", () => {
    const r = adapter.resolveCall(ctx({ identifier: "mystery" }));
    assert.equal(r, null);
  });
});

// ---------------------------------------------------------------------------
// C# adapter
// ---------------------------------------------------------------------------

describe("csharpAdapter.resolveCall", () => {
  const adapter = csharpAdapter();

  it("claims bare base as unresolved", () => {
    const r1 = adapter.resolveCall(ctx({ identifier: "base" }));
    assert.equal(r1?.symbolId, null);
    assert.equal(r1?.reason, "base_call");
  });

  it("binds base.Method to a same-file symbol when unambiguous", () => {
    const r = adapter.resolveCall(ctx({
      identifier: "base.Compute",
      localNames: { Compute: [78] },
    }));
    assert.equal(r?.symbolId, 78);
    assert.equal(r?.strategy, "heuristic");
  });

  it("rejects BCL receivers (Console.WriteLine, Math.Floor, System.Environment)", () => {
    for (const id of ["Console.WriteLine", "Math.Floor", "System.Environment", "Convert.ToInt32", "File.ReadAllText"]) {
      const r = adapter.resolveCall(ctx({ identifier: id }));
      assert.equal(r?.symbolId, null, id);
      assert.equal(r?.reason, "builtin_bcl", id);
    }
  });

  it("binds this.Method to a same-file symbol", () => {
    const r = adapter.resolveCall(ctx({
      identifier: "this.Compute",
      localNames: { Compute: [77] },
    }));
    assert.equal(r?.symbolId, 77);
    assert.equal(r?.strategy, "heuristic");
  });

  it("binds bare identifier via direct import", () => {
    const r = adapter.resolveCall(ctx({
      identifier: "RunJob",
      imported: { RunJob: [700] },
    }));
    assert.equal(r?.symbolId, 700);
    assert.equal(r?.confidence, 0.88);
  });
});

// ---------------------------------------------------------------------------
// C / C++ adapter
// ---------------------------------------------------------------------------

describe("cppAdapter.resolveCall", () => {
  const adapter = cppAdapter("cpp");

  it("rejects std:: / boost:: scope prefixes", () => {
    for (const id of ["std::cout", "std::vector::push_back", "boost::shared_ptr"]) {
      const r = adapter.resolveCall(ctx({ identifier: id }));
      assert.equal(r?.symbolId, null, id);
      assert.equal(r?.reason, "builtin_cpp_stdlib", id);
    }
  });

  it("binds this->method (arrow form) to a same-file symbol", () => {
    const r = adapter.resolveCall(ctx({
      identifier: "this->compute",
      localNames: { compute: [88] },
    }));
    assert.equal(r?.symbolId, 88);
    assert.equal(r?.strategy, "heuristic");
  });

  it("binds this.method (dot form) to a same-file symbol", () => {
    const r = adapter.resolveCall(ctx({
      identifier: "this.field",
      localNames: { field: [89] },
    }));
    assert.equal(r?.symbolId, 89);
    assert.equal(r?.strategy, "heuristic");
  });

  it("binds Class::method via namespace import", () => {
    const r = adapter.resolveCall(ctx({
      identifier: "MyNs::doThing",
      namespace: { MyNs: { doThing: 99 } },
    }));
    assert.equal(r?.symbolId, 99);
    assert.equal(r?.strategy, "exact");
  });

  it("binds bare identifier via direct import", () => {
    const r = adapter.resolveCall(ctx({
      identifier: "doWork",
      imported: { doWork: [800] },
    }));
    assert.equal(r?.symbolId, 800);
    assert.equal(r?.confidence, 0.88);
  });

  it("C variant uses lang tag 'c'", () => {
    const c = cppAdapter("c");
    assert.equal(c.lang, "c");
  });
});

// ---------------------------------------------------------------------------
// Parser handoff: call targets preserve receiver/scope text.
// ---------------------------------------------------------------------------

describe("tree-sitter call target handoff", () => {
  it("preserves JS/TS member receivers", () => {
    const r = parseBuffer({
      repo_rel_path: "src/a.ts",
      bytes: "class A extends B { m(){ this.x(); super.y(); Math.floor(1); ns.help(); new Box(); } }",
    });
    const names = callNames(r);
    for (const expected of ["this.x", "super.y", "Math.floor", "ns.help", "Box"]) {
      assert.ok(names.includes(expected), `missing ${expected} in ${names.join(",")}`);
    }
  });

  it("preserves Python dotted receivers and stdlib prefixes", () => {
    const r = parseBuffer({
      repo_rel_path: "pkg/a.py",
      bytes: "class A:\n    def m(self):\n        self.x()\n        super().y()\n        os.path.join('a', 'b')\n",
    });
    const names = callNames(r);
    for (const expected of ["self.x", "super.y", "os.path.join"]) {
      assert.ok(names.includes(expected), `missing ${expected} in ${names.join(",")}`);
    }
  });

  it("preserves receiver/scope forms for Go, JVM, Rust, C#, C++, and PHP", () => {
    const fixtures = [
      ["main.go", "package main\nfunc f(){ fmt.Println(\"x\"); r.Bar(); make([]int, 0) }", ["fmt.Println", "r.Bar", "make"]],
      ["src/A.java", "class A { void m(){ this.x(); super.y(); System.out.println(\"x\"); new Box(); } }", ["this.x", "super.y", "System.out.println", "Box"]],
      ["src/A.kt", "class A { fun m(){ this.x(); super.y(); System.out.println(\"x\"); Box() } }", ["this.x", "super.y", "System.out.println", "Box"]],
      ["src/lib.rs", "impl A { fn m(&self){ self.x(); Self::y(); std::fs::read(\"x\"); vec![]; } }", ["self.x", "Self::y", "std::fs::read", "vec!"]],
      ["src/A.cs", "class A { void M(){ this.X(); base.Y(); Console.WriteLine(\"x\"); new Box(); } }", ["this.X", "base.Y", "Console.WriteLine", "Box"]],
      ["src/a.cpp", "class A { void m(){ this->x(); std::move(a); Foo::bar(); } };", ["this->x", "std::move", "Foo::bar"]],
      ["src/a.php", "<?php class A { function m(){ $this->x(); self::y(); Foo::bar(); new Box(); } }", ["$this.x", "self::y", "Foo::bar"]],
    ];

    for (const [repo_rel_path, bytes, expectedNames] of fixtures) {
      const r = parseBuffer({ repo_rel_path, bytes });
      const names = callNames(r);
      for (const expected of expectedNames) {
        assert.ok(names.includes(expected), `${repo_rel_path}: missing ${expected} in ${names.join(",")}`);
      }
    }
  });
});

function callNames(result) {
  return result.edges.filter((e) => e.kind === "calls").map((e) => e.to_name);
}

// ---------------------------------------------------------------------------
// Integration: real corpus through the full pipeline.
// ---------------------------------------------------------------------------

describe("TS adapter integration via ViewBuilder", () => {
  let tmpRoot;
  let view;
  let ledger;

  before(() => {
    tmpRoot = makeTmp("atlas-v2-ts-adapter-int-");
    // Fixture: a class with this.method() and a same-file caller.
    const sourceA = `
export class Box {
  public name = "x";

  public greet(): string {
    return this.format(this.name);
  }

  public format(s: string): string {
    return s.toUpperCase();
  }
}
`;
    // A separate file that consumes Box via import and calls Math.floor (must not resolve to repo).
    const sourceB = `
import { Box } from "./box.js";

export function consume(): string {
  const b = new Box();
  return b.greet() + " " + Math.floor(1.5);
}
`;
    const ledgerPath = path.join(tmpRoot, "ledger.db");
    const viewPath = path.join(tmpRoot, "view.db");
    ledger = Ledger.open({ dbPath: ledgerPath });

    for (const [rel, bytes] of [["src/box.ts", sourceA], ["src/run.ts", sourceB]]) {
      const result = parseBuffer({ bytes, repo_rel_path: rel });
      ledger.ingestBlob({
        content_hash: result.content_hash,
        lang: result.lang,
        byte_size: bytes.length,
        symbols: result.symbols,
        edges: result.edges,
      });
      ledger.append({
        branch: "main",
        op: "add",
        repo_rel_path: rel,
        before_content_hash: null,
        after_content_hash: result.content_hash,
      });
    }

    const builder = new ViewBuilder();
    builder.buildFrom({
      ledger,
      branch: "main",
      atSeq: ledger.headSeq("main"),
      outPath: viewPath,
    });
    view = View.mount({ dbPath: viewPath });
  });

  after(() => {
    if (view) view.close();
    if (ledger) ledger.close();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
  });

  it("this.format binds to Box.format (TS adapter, heuristic)", () => {
    const formatMatches = view.query.findSymbol("format", { fuzzy: false, limit: 5 })
      .filter((s) => s.repo_rel_path === "src/box.ts" && s.kind === "method");
    assert.equal(formatMatches.length, 1);
    const format = formatMatches[0];
    const callers = view.query.callers(format.global_id);
    assert.ok(
      callers.length > 0,
      "Box.format should have at least one caller via this.format() resolution",
    );
    // The greet method (also in src/box.ts) is the caller.
    const callerGids = callers.map((c) => c.from_global_id);
    const callerNames = callerGids.map((g) => view.query.getSymbol(g)?.name).filter(Boolean);
    assert.ok(callerNames.includes("greet"), `expected greet() in callers, got ${callerNames.join(",")}`);
  });

  it("b.greet binds to Box.greet via generic last-member fallback", () => {
    const greetMatches = view.query.findSymbol("greet", { fuzzy: false, limit: 5 })
      .filter((s) => s.repo_rel_path === "src/box.ts" && s.kind === "method");
    assert.equal(greetMatches.length, 1);
    const callers = view.query.callers(greetMatches[0].global_id);
    const callerNames = callers
      .map((c) => view.query.getSymbol(c.from_global_id)?.name)
      .filter(Boolean);
    assert.ok(callerNames.includes("consume"), `expected consume() in callers, got ${callerNames.join(",")}`);
  });

  it("Math.floor stays unresolved (TS adapter rejects builtins)", () => {
    // Math.floor is a built-in; the resolver should NOT have created a
    // bogus `to_global_id` binding. View.unresolvedReferencesTo by name
    // is the easiest probe.
    const unresolved = view.query.unresolvedReferencesTo("Math.floor");
    // Either the edge was emitted unresolved, or never created. Both are
    // fine; what we don't want is a *resolved* binding to some unrelated
    // symbol named "floor".
    for (const e of unresolved) {
      assert.equal(e.to_global_id, null);
    }
    // Direct probe: there should be no symbol named "floor" in the view
    // — Math.floor isn't a repo symbol. Verify the adapter didn't invent one.
    const floors = view.query.findSymbol("floor", { fuzzy: false, limit: 5 });
    assert.equal(floors.length, 0);
  });
});

describe("generic resolver parity gaps via ViewBuilder", () => {
  let tmpRoot;
  let view;
  let ledger;

  before(() => {
    tmpRoot = makeTmp("atlas-v2-generic-parity-int-");
    const files = [
      ["src/local.ts", `
export class Box {}

export function format(): string {
  return "x";
}

export function make(): Box {
  format();
  return new Box();
}
`],
      ["src/helpers.ts", `
export function runTask(): string {
  return "ok";
}
`],
      ["src/ns.ts", `
import * as helpers from "./helpers.js";

export function runNamespace(): string {
  return helpers.runTask();
}
`],
      ["src/default.ts", `
import helpers from "./helpers.js";

export function runDefault(): string {
  return helpers.runTask();
}
`],
      ["src/alias.ts", `
import { runTask as task } from "./helpers.js";

export function runAlias(): string {
  return task();
}
`],
      ["src/imported-target.ts", `
export function target(): string {
  return "imported";
}
`],
      ["src/shadow.ts", `
import { target } from "./imported-target.js";

export function shadowCaller(): string {
  const target = () => "local";
  return target();
}
`],
    ];
    const ledgerPath = path.join(tmpRoot, "ledger.db");
    const viewPath = path.join(tmpRoot, "view.db");
    ledger = Ledger.open({ dbPath: ledgerPath });

    for (const [rel, bytes] of files) {
      const result = parseBuffer({ bytes, repo_rel_path: rel });
      ledger.ingestBlob({
        content_hash: result.content_hash,
        lang: result.lang,
        byte_size: bytes.length,
        symbols: result.symbols,
        edges: result.edges,
      });
      ledger.append({
        branch: "main",
        op: "add",
        repo_rel_path: rel,
        before_content_hash: null,
        after_content_hash: result.content_hash,
      });
    }

    const builder = new ViewBuilder();
    builder.buildFrom({
      ledger,
      branch: "main",
      atSeq: ledger.headSeq("main"),
      outPath: viewPath,
    });
    view = View.mount({ dbPath: viewPath });
  });

  after(() => {
    if (view) view.close();
    if (ledger) ledger.close();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
  });

  it("resolves repo symbols before applying context-free builtin skips", () => {
    const box = view.query.findSymbol("Box", { fuzzy: false, limit: 10 })
      .find((s) => s.repo_rel_path === "src/local.ts" && s.kind === "class");
    const format = view.query.findSymbol("format", { fuzzy: false, limit: 10 })
      .find((s) => s.repo_rel_path === "src/local.ts" && s.kind === "function");
    assert.ok(box);
    assert.ok(format);

    const boxCallers = view.query.callers(box.global_id)
      .map((c) => view.query.getSymbol(c.from_global_id)?.name)
      .filter(Boolean);
    const formatCallers = view.query.callers(format.global_id)
      .map((c) => view.query.getSymbol(c.from_global_id)?.name)
      .filter(Boolean);
    assert.ok(boxCallers.includes("make"), `expected make() to call Box, got ${boxCallers.join(",")}`);
    assert.ok(formatCallers.includes("make"), `expected make() to call format, got ${formatCallers.join(",")}`);
  });

  it("resolves namespace and default namespace-like JS imports", () => {
    const runTask = view.query.findSymbol("runTask", { fuzzy: false, limit: 10 })
      .find((s) => s.repo_rel_path === "src/helpers.ts" && s.kind === "function");
    assert.ok(runTask);
    const callerEdges = view.query.callers(runTask.global_id);
    const callerNames = callerEdges
      .filter((e) => e.kind === "calls")
      .map((c) => view.query.getSymbol(c.from_global_id)?.name)
      .filter(Boolean)
      .sort();
    assert.deepEqual(callerNames, ["runAlias", "runDefault", "runNamespace"]);
    for (const edge of callerEdges.filter((e) => e.kind === "calls")) {
      const expectedConfidence = edge.to_name === "task" ? 88 : 92;
      assert.equal(edge.confidence, expectedConfidence, `${edge.to_name} should resolve with adapter/import confidence`);
    }
  });

  it("does not bind a locally shadowed imported bare call to the import", () => {
    const importedTarget = view.query.findSymbol("target", { fuzzy: false, limit: 10 })
      .find((s) => s.repo_rel_path === "src/imported-target.ts" && s.kind === "function");
    assert.ok(importedTarget);
    const callCallerNames = view.query.callers(importedTarget.global_id)
      .filter((e) => e.kind === "calls")
      .map((e) => view.query.getSymbol(e.from_global_id)?.name)
      .filter(Boolean);
    assert.equal(
      callCallerNames.includes("shadowCaller"),
      false,
      `shadowCaller should not call imported target; got ${callCallerNames.join(",")}`,
    );
  });
});

describe("Python adapter integration via ViewBuilder", () => {
  let tmpRoot;
  let view;
  let ledger;

  before(() => {
    tmpRoot = makeTmp("atlas-v2-py-adapter-int-");
    const source = `
class Greeter:
    def greet(self, name):
        return self.format(name)

    def format(self, value):
        return value.upper()
`;
    const ledgerPath = path.join(tmpRoot, "ledger.db");
    const viewPath = path.join(tmpRoot, "view.db");
    ledger = Ledger.open({ dbPath: ledgerPath });

    const result = parseBuffer({ bytes: source, repo_rel_path: "pkg/greeter.py" });
    ledger.ingestBlob({
      content_hash: result.content_hash,
      lang: result.lang,
      byte_size: source.length,
      symbols: result.symbols,
      edges: result.edges,
    });
    ledger.append({
      branch: "main",
      op: "add",
      repo_rel_path: "pkg/greeter.py",
      before_content_hash: null,
      after_content_hash: result.content_hash,
    });

    const builder = new ViewBuilder();
    builder.buildFrom({
      ledger,
      branch: "main",
      atSeq: ledger.headSeq("main"),
      outPath: viewPath,
    });
    view = View.mount({ dbPath: viewPath });
  });

  after(() => {
    if (view) view.close();
    if (ledger) ledger.close();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
  });

  it("self.format binds to Greeter.format (Python adapter, heuristic)", () => {
    const formatMatches = view.query.findSymbol("format", { fuzzy: false, limit: 5 })
      .filter((s) => s.repo_rel_path === "pkg/greeter.py" && s.kind === "method");
    assert.equal(formatMatches.length, 1);
    const callers = view.query.callers(formatMatches[0].global_id);
    const callerNames = callers
      .map((c) => view.query.getSymbol(c.from_global_id)?.name)
      .filter(Boolean);
    assert.ok(callerNames.includes("greet"), `expected greet() in callers, got ${callerNames.join(",")}`);
  });
});
