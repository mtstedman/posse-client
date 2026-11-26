// Bounded, read-only intake/readiness inspection; never executes these commands.
export const CHECK_DISCOVERY = Object.freeze({
  maxDepth: 3,
  maxDirectories: 128,
  maxEntries: 4096,
  maxCandidates: 64,
  maxManifestBytes: 256 * 1024,
  ignoredDirectories: Object.freeze(["node_modules", "vendor", "target", "dist", "build", "coverage", "venv", "__pycache__"]),
  nodeScripts: Object.freeze(["test", "typecheck", "check-types", "lint"]),
  composerScripts: Object.freeze(["test", "typecheck", "lint", "analyse"]),
  nativeManifests: Object.freeze([
    Object.freeze({ source: "go.mod", pattern: /^module\s+\S+/m, commands: Object.freeze(["go test ./...", "go vet ./..."]) }),
    Object.freeze({ source: "Cargo.toml", pattern: /^\s*\[(?:package|workspace)\]/m, commands: Object.freeze(["cargo test", "cargo check"]) }),
  ]),
});
