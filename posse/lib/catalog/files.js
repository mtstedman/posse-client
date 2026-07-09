// Central file-extension catalogs shared by handoff, ATLAS gates, and toolkit
// helpers. Keep this module pure: catalog modules must not import runtime helpers.

export const ATLAS_INDEXABLE_SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".mts", ".cts",
  ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".pyi", ".pyw",
  ".go", ".java", ".cs",
  ".c", ".h", ".cpp", ".hpp", ".cc", ".cxx", ".hh", ".hxx",
  ".php", ".phtml", ".rs", ".kt", ".kts",
  ".sh", ".bash", ".zsh",
]);

export const HANDOFF_SOURCE_EXTENSIONS = new Set([
  ".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs",
  ".json", ".md", ".css", ".html", ".php", ".sql", ".yml", ".yaml",
  ".env.example", ".gitignore", ".sh", ".py",
]);

export const SMART_PRELOAD_INDEXABLE_EXTENSIONS = new Set([
  ".js", ".ts", ".mjs", ".cjs", ".jsx", ".tsx", ".php",
]);

export const HIGH_VALUE_SOURCE_EXTENSIONS = new Set([
  ".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs", ".php", ".py", ".sql",
]);

export const SUPPORTING_TEXT_EXTENSIONS = new Set([
  ".json", ".md", ".css", ".html", ".yml", ".yaml", ".env", ".example", ".gitignore",
]);

export const OBVIOUS_BINARY_EXTENSIONS = new Set([
  ".avif", ".bmp", ".gif", ".ico", ".jpeg", ".jpg", ".pdf", ".png", ".psd", ".webp",
  ".mp3", ".mp4", ".mov", ".wav", ".zip", ".gz", ".tgz", ".7z", ".rar",
]);

export const TOOL_BRIEF_DEFAULT_EXTENSIONS = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".php", ".py", ".rb", ".go", ".rs", ".java", ".cs", ".cpp", ".c", ".h", ".hpp",
  ".json", ".yaml", ".yml", ".toml", ".md",
]);

export const REPO_CODE_EXTENSIONS = new Set([
  ".html", ".htm", ".css", ".scss", ".sass", ".less",
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx",
  ".php", ".py", ".rb", ".go", ".rs", ".java", ".cs",
  ".vue", ".svelte", ".sql", ".sh", ".bash", ".ps1",
]);

export const INFERRED_SCOPE_BARE_EXTENSIONS = new Set([
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
