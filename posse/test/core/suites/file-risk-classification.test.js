import {
  it,
  assert,
  suite,
  handoff,
  classifyFileRisk,
  withQueueSettings,
} from "../support/core-harness.js";

let db;

suite("File Risk Classification", () => {
  it("classifies images as low risk", () => {
    assert.equal(classifyFileRisk("public/logo.png"), "low");
    assert.equal(classifyFileRisk("assets/photo.jpg"), "low");
    assert.equal(classifyFileRisk("img/icon.webp"), "low");
  });

  it("classifies fonts as low risk", () => {
    assert.equal(classifyFileRisk("fonts/body.woff2"), "low");
    assert.equal(classifyFileRisk("assets/title.ttf"), "low");
  });

  it("classifies HTML/CSS as mid risk", () => {
    assert.equal(classifyFileRisk("public/index.html"), "mid");
    assert.equal(classifyFileRisk("styles/main.css"), "mid");
  });

  it("classifies scripts as high risk", () => {
    assert.equal(classifyFileRisk("src/app.js"), "high");
    assert.equal(classifyFileRisk("lib/server.ts"), "high");
    assert.equal(classifyFileRisk("scripts/deploy.sh"), "high");
  });

  it("keeps newly requested source files in other languages high risk", () => {
    assert.equal(classifyFileRisk("src/main.go"), "high");
    assert.equal(classifyFileRisk("src/lib.rs"), "high");
    assert.equal(classifyFileRisk("app/Main.kt"), "high");
    assert.equal(classifyFileRisk("Sources/App.swift"), "high");
  });

  it("allows project-configured low-risk extension overrides without downgrading protected paths", () => {
    withQueueSettings({ file_request_low_risk_extensions: ".go,rs" }, () => {
      assert.equal(classifyFileRisk("examples/main.go"), "low");
      assert.equal(classifyFileRisk("fixtures/lib.rs"), "low");
      assert.equal(classifyFileRisk(".github/workflows/build.go"), "high");
    });
  });

  it("classifies CI, package, lockfile, and container config paths as high risk", () => {
    assert.equal(classifyFileRisk(".github/workflows/ci.yml"), "high");
    assert.equal(classifyFileRisk("package.json"), "high");
    assert.equal(classifyFileRisk("tsconfig.app.json"), "high");
    assert.equal(classifyFileRisk("pnpm-lock.yaml"), "high");
    assert.equal(classifyFileRisk("Dockerfile"), "high");
    assert.equal(classifyFileRisk("docker-compose.yml"), "high");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TEST: File Request Splitting (handoff.js)
// ═════════════════════════════════════════════════════════════════════════════
