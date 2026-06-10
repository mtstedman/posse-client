import {
  it,
  assert,
  suite,
  _parseFunctions,
} from "../support/core-harness.js";

let db;

suite("Function Parser", () => {
  it("extracts named function declarations", () => {
    const code = `import foo from "bar";\n\nfunction hello(name) {\n  return name;\n}\n\nfunction world() {\n  return 42;\n}\n`;
    const fns = _parseFunctions(code);
    assert.equal(fns.length, 2);
    assert.equal(fns[0].name, "hello");
    assert.equal(fns[1].name, "world");
    assert.equal(fns[0].startLine, 3);
    assert.equal(fns[0].endLine, 5);
  });

  it("extracts exported functions", () => {
    const code = `export function doStuff() {\n  console.log("hi");\n}\n\nexport default function main() {\n  doStuff();\n}\n`;
    const fns = _parseFunctions(code);
    assert.equal(fns.length, 2);
    assert.equal(fns[0].name, "doStuff");
    assert.equal(fns[1].name, "main");
  });

  it("extracts arrow functions assigned to const", () => {
    const code = `const handler = (req, res) => {\n  res.send("ok");\n};\n`;
    const fns = _parseFunctions(code);
    assert.equal(fns.length, 1);
    assert.equal(fns[0].name, "handler");
  });

  it("extracts class declarations", () => {
    const code = `class MyClass {\n  constructor() {\n    this.x = 1;\n  }\n  method() {\n    return this.x;\n  }\n}\n`;
    const fns = _parseFunctions(code);
    assert.ok(fns.some(f => f.name === "MyClass"));
    assert.ok(fns.some(f => f.name === "MyClass.constructor"));
    assert.ok(fns.some(f => f.name === "MyClass.method"));
  });

  it("extracts async functions", () => {
    const code = `export async function fetchData(url) {\n  const r = await fetch(url);\n  return r.json();\n}\n`;
    const fns = _parseFunctions(code);
    assert.equal(fns.length, 1);
    assert.equal(fns[0].name, "fetchData");
  });

  it("handles braces inside strings, templates, comments, and regex", () => {
    const code = [
      "function parseThing() {",
      "  const a = '{not a brace}';",
      "  const b = `template ${value} with { brace }`;",
      "  const c = /^{foo}$/;",
      "  // } comment brace",
      "  /* { block brace */",
      "  return { ok: true };",
      "}",
      "",
      "function nextThing() {",
      "  return 1;",
      "}",
    ].join("\n");
    const fns = _parseFunctions(code);
    assert.equal(fns.length, 2);
    assert.equal(fns[0].name, "parseThing");
    assert.equal(fns[0].endLine, 8);
    assert.equal(fns[1].name, "nextThing");
  });

  it("extracts generic TypeScript functions", () => {
    const code = `export function identity<T>(value: T): T {\n  return value;\n}\n`;
    const fns = _parseFunctions(code);
    assert.equal(fns.length, 1);
    assert.equal(fns[0].name, "identity");
    assert.equal(fns[0].endLine, 3);
  });

  it("extracts typed async arrow functions", () => {
    const code = `const loadUser: Loader = async (id: string): Promise<User> => {\n  return fetchUser(id);\n}\n`;
    const fns = _parseFunctions(code);
    assert.equal(fns.length, 1);
    assert.equal(fns[0].name, "loadUser");
    assert.equal(fns[0].endLine, 3);
  });

  it("handles multiline function signatures", () => {
    const code = [
      "export async function createWidget(",
      "  input: WidgetInput,",
      "  opts: CreateOpts,",
      "): Promise<Widget> {",
      "  return buildWidget(input, opts);",
      "}",
    ].join("\n");
    const fns = _parseFunctions(code);
    assert.equal(fns.length, 1);
    assert.equal(fns[0].name, "createWidget");
    assert.equal(fns[0].endLine, 6);
  });

  it("extracts private/static/getter members inside classes", () => {
    const code = [
      "class Service {",
      "  static async build(id: string) {",
      "    return new Service(id);",
      "  }",
      "",
      "  get ready() {",
      "    return true;",
      "  }",
      "",
      "  #normalize(input: string) {",
      "    return input.trim();",
      "  }",
      "}",
    ].join("\n");
    const fns = _parseFunctions(code);
    assert.ok(fns.some(f => f.name === "Service.build"));
    assert.ok(fns.some(f => f.name === "Service.ready"));
    assert.ok(fns.some(f => f.name === "Service.#normalize"));
  });

  it("extracts class field arrow functions", () => {
    const code = [
      "class Page {",
      "  load = async () => {",
      "    return true;",
      "  }",
      "}",
    ].join("\n");
    const fns = _parseFunctions(code);
    assert.ok(fns.some(f => f.name === "Page.load"));
  });

  it("handles multiline class member signatures", () => {
    const code = [
      "class QueryBuilder {",
      "  async execute(",
      "    input: QueryInput,",
      "    opts: QueryOptions,",
      "  ): Promise<Result> {",
      "    return runQuery(input, opts);",
      "  }",
      "}",
    ].join("\n");
    const fns = _parseFunctions(code);
    const member = fns.find(f => f.name === "QueryBuilder.execute");
    assert.ok(member);
    assert.equal(member.endLine, 7);
  });

  it("skips control flow keywords", () => {
    const code = `function real() {\n  if (true) {\n    for (const x of []) {\n      while (false) {}\n    }\n  }\n}\n`;
    const fns = _parseFunctions(code);
    assert.equal(fns.length, 1);
    assert.equal(fns[0].name, "real");
  });

  it("returns empty for non-function files", () => {
    const code = `{ "name": "test", "version": "1.0" }`;
    const fns = _parseFunctions(code);
    assert.equal(fns.length, 0);
  });

  it("extracts PHP functions and class methods", () => {
    const code = [
      "<?php",
      "",
      "function render_card($title) {",
      "  return strtoupper($title);",
      "}",
      "",
      "class FlowController {",
      "  public function show($id) {",
      "    return $id;",
      "  }",
      "}",
    ].join("\n");
    const fns = _parseFunctions(code);
    assert.ok(fns.some(f => f.name === "render_card"));
    assert.ok(fns.some(f => f.name === "FlowController"));
    assert.ok(fns.some(f => f.name === "FlowController.show"));
  });
});
