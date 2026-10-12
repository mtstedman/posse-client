import { readonlySet } from "./readonly-collections.js";
// Central file-extension catalogs shared by handoff, ATLAS gates, and toolkit
// helpers. Keep this module pure: catalog modules must not import runtime helpers.

export const ATLAS_INDEXABLE_SOURCE_EXTENSIONS = readonlySet([
  ".ts", ".tsx", ".mts", ".cts",
  ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".pyi",
  ".go", ".java", ".cs",
  ".c", ".h", ".cpp", ".hpp", ".cc", ".cxx", ".hh", ".hxx",
  ".php", ".rs", ".kt", ".kts",
  ".sh", ".bash",
]);

export const HANDOFF_SOURCE_EXTENSIONS = readonlySet([
  ".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs",
  ".json", ".md", ".css", ".html", ".php", ".sql", ".yml", ".yaml",
  ".env.example", ".gitignore", ".sh", ".py",
]);

export const SMART_PRELOAD_INDEXABLE_EXTENSIONS = readonlySet([
  ".js", ".ts", ".mjs", ".cjs", ".jsx", ".tsx", ".php",
]);

export const HIGH_VALUE_SOURCE_EXTENSIONS = readonlySet([
  ".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs", ".php", ".py", ".sql",
]);

export const SUPPORTING_TEXT_EXTENSIONS = readonlySet([
  ".json", ".md", ".css", ".html", ".yml", ".yaml", ".env", ".example", ".gitignore",
]);

export const OBVIOUS_BINARY_EXTENSIONS = readonlySet([
  ".avif", ".bmp", ".gif", ".ico", ".jpeg", ".jpg", ".pdf", ".png", ".psd", ".webp",
  ".mp3", ".mp4", ".mov", ".wav", ".zip", ".gz", ".tgz", ".7z", ".rar",
]);

export const TOOL_BRIEF_DEFAULT_EXTENSIONS = readonlySet([
  ".js", ".jsx", ".ts", ".tsx", ".php", ".py", ".rb", ".go", ".rs", ".java", ".cs", ".cpp", ".c", ".h", ".hpp",
  ".json", ".yaml", ".yml", ".toml", ".md",
]);

export const REPO_CODE_EXTENSIONS = readonlySet([
  ".html", ".htm", ".css", ".scss", ".sass", ".less",
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx",
  ".php", ".py", ".rb", ".go", ".rs", ".java", ".cs",
  ".vue", ".svelte", ".sql", ".sh", ".bash", ".ps1",
]);

export const INFERRED_SCOPE_BARE_EXTENSIONS = readonlySet([
  ".c",
  ".cc",
  ".cfg",
  ".cjs",
  ".conf",
  ".cpp",
  ".cs",
  ".css",
  ".csv",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".lock",
  ".md",
  ".mjs",
  ".mod",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".sum",
  ".toml",
  ".ts",
  ".tsx",
  ".tsv",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

// Intent-specific membership; image evidence and promotion differ deliberately.
export const PROMOTION_IMAGE_ARTIFACT_EXTENSIONS = readonlySet([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif"]);

// Intent-specific membership; image evidence and promotion differ deliberately.
export const HANDOFF_IMAGE_EVIDENCE_EXTENSIONS = readonlySet([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".svg", ".avif",
]);

// Secret-scan exclusions preserve the existing Git hook contract.
export const GIT_HOOK_BINARY_EXTENSIONS = readonlySet([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".bmp", ".webp",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".mp4", ".mp3", ".wav", ".ogg", ".webm",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx",
  ".lock", ".min.js", ".min.css",
]);
