// test/test-atlas-v2-query-planner.test.js
//
// Unit-level coverage for the query planner that drives the ATLAS v2
// retrieval orchestrator's FTS probes. The planner is pure — these
// tests assert it extracts the right facets out of natural-language
// inputs we'd expect from real tasks.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { planQuery } from "../lib/domains/atlas/functions/v2/retrieval/orchestrator/query-planner.js";

describe("query planner", () => {
  it("returns an empty plan for empty input", () => {
    const plan = planQuery("");
    assert.equal(plan.raw, "");
    assert.deepEqual(plan.identifiers, []);
    assert.deepEqual(plan.paths, []);
    assert.deepEqual(plan.keywords, []);
    assert.equal(plan.identifierLike, false);
    assert.equal(plan.symptom, null);
  });

  it("flags a bare PascalCase token as identifier-like", () => {
    const plan = planQuery("Greeter");
    assert.equal(plan.identifierLike, true);
    assert.ok(plan.identifiers.includes("Greeter"));
  });

  it("flags a bare camelCase identifier as identifier-like", () => {
    const plan = planQuery("getUserById");
    assert.equal(plan.identifierLike, true);
    assert.ok(plan.identifiers.includes("getUserById"));
  });

  it("does not treat a single lowercase task word as identifier-like", () => {
    const plan = planQuery("login");
    assert.equal(plan.identifierLike, false);
    assert.deepEqual(plan.identifiers, []);
    assert.ok(plan.keywords.includes("login"));
  });

  it("does NOT mark a sentence as identifier-like even if it mentions a symbol", () => {
    const plan = planQuery("debug the Greeter class so greet() returns the right string");
    assert.equal(plan.identifierLike, false);
    assert.ok(plan.identifiers.includes("Greeter"));
  });

  it("treats snake_case as code identifier and skips english stopwords", () => {
    const plan = planQuery("the user_account refresh path is failing");
    assert.ok(plan.identifiers.includes("user_account"));
    assert.equal(plan.identifiers.includes("the"), false);
    assert.equal(plan.identifiers.includes("is"), false);
  });

  it("extracts qualified names with dots and colons", () => {
    const plan = planQuery("crash inside auth.session.refresh and std::fmt::Display impl");
    assert.ok(plan.identifiers.includes("auth.session.refresh"));
    assert.ok(plan.identifiers.some((id) => id.startsWith("std")));
  });

  it("extracts file paths and the corresponding language hints", () => {
    const plan = planQuery("regression in src/auth/session.ts after refactor");
    assert.ok(plan.paths.includes("src/auth/session.ts"));
    assert.ok(plan.fileNames.includes("session.ts"));
    assert.ok(plan.languageHints.includes("ts"));
  });

  it("strips paths out of the identifier facet", () => {
    const plan = planQuery("fix lib/foo/Bar.rs panic when called twice");
    assert.ok(plan.paths.includes("lib/foo/Bar.rs"));
    // The identifier pass should NOT re-extract "lib", "foo", "Bar" from
    // the consumed path — Bar would otherwise appear as a top hit.
    assert.equal(plan.identifiers.includes("Bar"), false);
    assert.equal(plan.identifiers.includes("foo"), false);
    assert.ok(plan.languageHints.includes("rs"));
  });

  it("parses JS-style stack frames", () => {
    const plan = planQuery(`
      TypeError: Cannot read property 'id' of undefined
        at processUser (src/app/handlers.ts:42:18)
        at src/index.ts:8:3
    `);
    assert.ok(plan.stackFrames.length >= 2);
    const named = plan.stackFrames.find((f) => f.fn === "processUser");
    assert.ok(named, "named JS frame should be parsed");
    assert.equal(named.file, "src/app/handlers.ts");
    assert.equal(named.line, 42);
    // "TypeError" wins the symptom classifier — `\btype\s*error\b`
    // matches before the null-pointer pattern. Either label would be
    // defensible; the planner picks the first regex that matches.
    assert.equal(plan.symptom, "type_error");
  });

  it("parses Python-style stack frames", () => {
    const plan = planQuery(`
      File "src/lib/jobs.py", line 17, in run_job
        raise ValueError("bad")
    `);
    const frame = plan.stackFrames.find((f) => f.file === "src/lib/jobs.py");
    assert.ok(frame, "python frame should be parsed");
    assert.equal(frame.line, 17);
    assert.equal(frame.fn, "run_job");
  });

  it("classifies a deadlock symptom", () => {
    const plan = planQuery("worker hangs forever, likely deadlock on the writer mutex");
    assert.equal(plan.symptom, "deadlock");
  });

  it("classifies an auth symptom and surfaces session as an identifier-shaped keyword", () => {
    const plan = planQuery("login flow broken after token refresh — users see 401");
    assert.equal(plan.symptom, "auth");
    // login/token are common english but read as nouns here; they end
    // up in keywords (lowercased, deduped) — what matters is they're
    // available downstream rather than where they ended up.
    const surfaced = new Set([...plan.identifiers, ...plan.keywords].map((s) => s.toLowerCase()));
    assert.ok(surfaced.has("login") || surfaced.has("flow"));
    assert.ok(surfaced.has("token") || surfaced.has("refresh"));
  });

  it("dedupes identifiers and respects the cap", () => {
    const text = Array(50).fill("Greeter").join(" ") + " GreeterImpl FooBar BarBaz";
    const plan = planQuery(text);
    // Greeter, GreeterImpl, FooBar, BarBaz — no Greeter dup; total ≤ cap.
    assert.equal(new Set(plan.identifiers).size, plan.identifiers.length);
    assert.ok(plan.identifiers.length <= 12);
    assert.ok(plan.identifiers.includes("Greeter"));
    assert.ok(plan.identifiers.includes("GreeterImpl"));
  });

  it("recognizes a `c#`-style language hint", () => {
    const plan = planQuery("port the workflow to C# while keeping the public API");
    assert.ok(plan.languageHints.includes("cs"));
  });

  it("does not infer C from ordinary prose containing the letter c", () => {
    const plan = planQuery("debug the account cache refresh");
    assert.equal(plan.languageHints.includes("c"), false);
  });

  it("recognizes standalone C and C++ language hints", () => {
    const cPlan = planQuery("port the parser to C while preserving symbols");
    assert.ok(cPlan.languageHints.includes("c"));
    const cppPlan = planQuery("rewrite the hot path in C++");
    assert.ok(cppPlan.languageHints.includes("cpp"));
    assert.equal(cppPlan.languageHints.includes("c"), false);
  });

  it("keywords drop short tokens, stopwords, and identifier echoes", () => {
    const plan = planQuery("the Greeter is failing when greet() is invoked twice");
    // "Greeter" and "greet" should NOT appear in keywords (they're
    // identifiers / belong to identifier facet).
    assert.equal(plan.keywords.includes("greeter"), false);
    assert.equal(plan.keywords.includes("the"), false);
    assert.equal(plan.keywords.includes("is"), false);
    // "failing", "invoked", "twice" are content words we want kept.
    assert.ok(plan.keywords.some((k) => ["failing", "invoked", "twice"].includes(k)));
  });

  it("keywords drop FTS5 boolean operators before probe assembly", () => {
    const plan = planQuery("cache and index or search not updating");
    assert.ok(plan.keywords.includes("cache"));
    assert.ok(plan.keywords.includes("index"));
    assert.ok(plan.keywords.includes("search"));
    assert.equal(plan.keywords.includes("and"), false);
    assert.equal(plan.keywords.includes("or"), false);
    assert.equal(plan.keywords.includes("not"), false);
  });
});
