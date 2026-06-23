// Artifact protocol defaults used by Posse runtime validation and routing.
// This is product configuration, not target-repo state.

const MANIFEST_FILES = Object.freeze([
  "manifest.json",
  "manifest.md",
  "manifest.txt",
  "manifest-*.json",
  "manifest-*.md",
  "manifest-*.txt",
]);

const WARN_EXECUTABLE_FORMATS = Object.freeze([
  ".bat",
  ".cmd",
  ".com",
  ".dll",
  ".exe",
  ".msi",
  ".ps1",
  ".scr",
  ".sh",
  ".vbs",
]);

export const ARTIFACT_PROTOCOLS = Object.freeze({
  image: Object.freeze({
    provider: "grok",
    model: "grok-imagine-image",
    allowed_formats: Object.freeze([".png", ".jpg", ".jpeg", ".webp"]),
    allowed_manifest_files: MANIFEST_FILES,
    default_format: ".png",
    max_outputs: 4,
    require_prompt: true,
    output_validation: Object.freeze({
      min_files: 1,
      min_bytes: 1024,
    }),
  }),
  report: Object.freeze({
    provider: null,
    model: null,
    allowed_formats: Object.freeze([".md", ".txt", ".json", ".csv", ".html"]),
    allowed_manifest_files: MANIFEST_FILES,
    default_format: ".md",
    max_outputs: 10,
    require_prompt: false,
    output_validation: Object.freeze({
      min_files: 1,
      min_bytes: 0,
    }),
  }),
  content: Object.freeze({
    provider: null,
    model: null,
    allowed_formats: null,
    warn_formats: WARN_EXECUTABLE_FORMATS,
    default_format: null,
    max_outputs: 20,
    require_prompt: false,
    output_validation: Object.freeze({
      min_files: 1,
      min_bytes: 0,
    }),
  }),
  intake_processing: Object.freeze({
    provider: null,
    model: null,
    allowed_formats: null,
    warn_formats: WARN_EXECUTABLE_FORMATS,
    default_format: null,
    max_outputs: 20,
    require_prompt: false,
    output_validation: Object.freeze({
      min_files: 1,
      min_bytes: 0,
    }),
  }),
});
