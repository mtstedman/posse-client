// Bounded navigation candidates, not evidence or an exhaustive contract list.
export const REPOSITORY_GUIDE_FILENAMES = Object.freeze([
  "README.md", "README.rst", "README.txt", "README.adoc", "README",
  "Readme.md", "readme.md", "readme.rst", "readme.txt", "readme",
  "package.json", "composer.json", "Cargo.toml", "pyproject.toml",
  "go.mod", "deno.json", "deno.jsonc",
]);

export const REPOSITORY_GUIDE_LIMITS = Object.freeze({
  candidateFiles: 8,
  directories: 6,
  paths: 8,
  pathChars: 512,
  renderedPathChars: 768,
});
