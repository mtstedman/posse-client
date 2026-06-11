import { TOOL_INSPECT_FILE } from "../../../worker/functions/helpers/file-inspector.js";
import { TOOL_GIT_HISTORY } from "../../../git/functions/history.js";
import { resolveAtlasToolGateEnabled } from "./gate-settings.js";
import { ATLAS_INDEXABLE_SOURCE_EXTENSIONS } from "./source-file-gate.js";
import { formatAtlasBackendText, atlasBackendLabel } from "../atlas-label.js";
import { atlasDescriptorSchemaForAction } from "../../../atlas/functions/v2/contracts/tool-schemas.js";
import { POSSE_MCP_GATEWAY_TRANSPORT } from "../mcp-gateway.js";

// Static data table mirroring each provider's capabilities.toolAttachment.
// Defined here rather than imported via getProvider() so this module stays
// out of the provider-registry import cycle (tool-descriptors is loaded
// during provider module initialization). A contract test asserts this
// table stays in sync with the per-provider capability declarations.
const TOOL_ATTACHMENT_BY_PROVIDER = Object.freeze({
  claude: "mcp",
  openai: "function",
  grok: "function",
  codex: "deterministic-bridge",
  copilot: "mcp",
});

function _toolAttachmentModeFor(providerName) {
  return TOOL_ATTACHMENT_BY_PROVIDER[providerName] || null;
}

function _providerLabelFor(providerName) {
  if (providerName === "openai") return "OpenAI";
  if (providerName === "grok") return "Grok";
  if (providerName === "codex") return "Codex";
  if (providerName === "claude") return "Claude";
  return providerName ? providerName.charAt(0).toUpperCase() + providerName.slice(1) : "This provider";
}

export { TOOL_ATTACHMENT_BY_PROVIDER };

export { TOOL_INSPECT_FILE } from "../../../worker/functions/helpers/file-inspector.js";
export { TOOL_GIT_HISTORY } from "../../../git/functions/history.js";

const ATLAS_SYMBOL_ID_PATTERN = "^[0-9a-f]{64}:[0-9]+$";

export const TOOL_READ_FILE = {
  type: "function",
  name: "read_file",
  description:
    "Read the contents of a file. Returns numbered lines (like `cat -n`). " +
    "Use offset/limit for large files. Optional search/jsonPath/maxBytes returns a structured JSON result.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (absolute or relative to working directory)" },
      offset: { type: "integer", description: "Starting line number, 1-based. Default: 1" },
      limit: { type: "integer", description: "Maximum number of lines to read. Default: 2000" },
      maxBytes: { type: "integer", description: "Maximum bytes to return in structured mode." },
      search: { type: "string", description: "Case-insensitive regex pattern to search within the selected line range." },
      searchContext: { type: "integer", description: "Context lines around each search match in structured mode." },
      jsonPath: { type: "string", description: "Dot-separated JSON path to extract from a JSON file." },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

export const TOOL_WRITE_FILE = {
  type: "function",
  name: "write_file",
  description: "Create a new file or overwrite an existing file with the given content.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to write" },
      content: { type: "string", description: "Full content to write to the file" },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
};

export const TOOL_EDIT_FILE = {
  type: "function",
  name: "edit_file",
  description:
    "Edit an existing file within the allowed scope. Provide exactly one mode: exact old_string/new_string, " +
    "replaceLines, replacePattern, insertAt, append, or jsonPath/jsonValue.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to edit" },
      old_string: { type: "string", description: "Exact text to find (must be unique in file)" },
      new_string: { type: "string", description: "Replacement text" },
      replaceLines: {
        type: "object",
        description: "Replace a 0-based line range [start, end) with content.",
        properties: {
          start: { type: "integer", description: "0-based start line, inclusive" },
          end: { type: "integer", description: "0-based end line, exclusive" },
          content: { type: "string", description: "Replacement content" },
        },
        required: ["start", "end", "content"],
        additionalProperties: false,
      },
      replacePattern: {
        type: "object",
        description: "Replace a regex match. Patterns are case-sensitive; global=false requires a unique match. Replacement uses JavaScript replacement syntax ($1, $$).",
        properties: {
          pattern: { type: "string", description: "Regex pattern to replace" },
          replacement: { type: "string", description: "Replacement text. Supports JavaScript replacement tokens such as $1 for capture groups and $$ for a literal dollar sign." },
          global: { type: "boolean", description: "Replace all matches. Default: false" },
        },
        required: ["pattern", "replacement"],
        additionalProperties: false,
      },
      insertAt: {
        type: "object",
        description: "Insert content before a 0-based line number.",
        properties: {
          line: { type: "integer", description: "0-based insertion line" },
          content: { type: "string", description: "Content to insert" },
        },
        required: ["line", "content"],
        additionalProperties: false,
      },
      append: { type: "string", description: "Content to append to the file." },
      jsonPath: { type: "string", description: "Dot-separated JSON path to update." },
      jsonValue: { description: "Value to write when jsonPath is used." },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

export const TOOL_LIST_FILES = {
  type: "function",
  name: "list_files",
  description:
    "List files in a directory, optionally filtering by name pattern. Returns file paths.",
  parameters: {
    type: "object",
    properties: {
      directory: { type: "string", description: "Directory to list. Default: working directory" },
      pattern: { type: "string", description: "File name pattern filter, e.g. '*.js', '*.ts'. Default: all files" },
      recursive: { type: "boolean", description: "Search subdirectories recursively. Default: true" },
    },
    required: [],
    additionalProperties: false,
  },
};

export const TOOL_SEARCH_FILES = {
  type: "function",
  name: "search_files",
  description:
    "Search file contents deterministically with ripgrep (rg), using regex or literal modes. " +
    "Supports context lines, result paging, and file/count output modes.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex pattern to search for" },
      path: { type: "string", description: "File or directory to search in. Default: working directory" },
      include: { type: "string", description: "Glob pattern to filter files, e.g. '*.js', '*.{ts,tsx}'" },
      case_insensitive: { type: "boolean", description: "Match case-insensitively. Default: false." },
      literal: { type: "boolean", description: "Treat pattern as literal text instead of regex. Default: false." },
      multiline: { type: "boolean", description: "Allow regex to match across newlines. Default: false." },
      output_mode: {
        type: "string",
        enum: ["content", "files_with_matches", "count"],
        description: "Result format. Default: content.",
      },
      before_context: { type: "integer", description: "Lines of context before each content match." },
      after_context: { type: "integer", description: "Lines of context after each content match." },
      context: { type: "integer", description: "Lines of context before and after each match." },
      head_limit: { type: "integer", description: "Maximum returned rows after offset. Default: 100, max: 500." },
      offset: { type: "integer", description: "Skip this many result rows before returning output." },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
};

export const TOOL_HASH_FILE = {
  type: "function",
  name: "hash_file",
  description:
    "Calculate a deterministic file hash for verification. Returns structured metadata with SHA-256 by default.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (absolute or relative to working directory)" },
      algorithm: {
        type: "string",
        enum: ["sha256", "sha1", "md5"],
        description: "Hash algorithm. Default: sha256.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

export const TOOL_RESIZE_IMAGE = {
  type: "function",
  name: "resize_image",
  description:
    "Resize a PNG image deterministically, writing PNG or JPEG output based on output_path/output_format. " +
    "Use this when an existing generated image needs different dimensions or final format for the layout.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Source PNG path (absolute or relative to working directory)" },
      output_path: { type: "string", description: "Optional destination PNG/JPEG path. Defaults to overwriting the source file." },
      output_format: { type: "string", enum: ["png", "jpeg", "jpg"], description: "Output format. Defaults from output_path extension, then png." },
      quality: { type: "integer", description: "JPEG quality from 1-100 when outputting JPEG. Default: 90." },
      width: { type: "integer", description: "Target width in pixels" },
      height: { type: "integer", description: "Target height in pixels" },
      mode: {
        type: "string",
        enum: ["fit", "fill", "stretch"],
        description: "Resize mode. fit preserves aspect ratio with transparent padding, fill preserves aspect ratio and crops, stretch ignores aspect ratio. Default: fit.",
      },
    },
    required: ["path", "width", "height"],
    additionalProperties: false,
  },
};

export const TOOL_READ_IMAGE_METADATA = {
  type: "function",
  name: "read_image_metadata",
  description: "Read basic image metadata (format, dimensions, byte size).",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Image file path." },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

export const TOOL_VALIDATE_ARTIFACT_OUTPUT = {
  type: "function",
  name: "validate_artifact_output",
  description:
    "Validate an artifact output directory against the configured artifact contract and optional expected image dimensions. " +
    "Use this instead of writing ad-hoc checker scripts.",
  parameters: {
    type: "object",
    properties: {
      output_root: { type: "string", description: "Artifact output directory to validate. Defaults to the working directory." },
      task_mode: {
        type: "string",
        enum: ["image", "report", "content", "intake_processing"],
        description: "Artifact task mode. Default: image.",
      },
      expected_files: {
        type: "array",
        items: { type: "string" },
        description: "Optional exact filenames/relative paths that must exist under output_root.",
      },
      expected_images: {
        type: "array",
        description: "Optional image-specific expectations for dimensions and transparency.",
        items: {
          type: "object",
          properties: {
            path: { type: "string", description: "Image path relative to output_root." },
            width: { type: "integer", description: "Exact expected width in pixels." },
            height: { type: "integer", description: "Exact expected height in pixels." },
            min_width: { type: "integer", description: "Minimum acceptable width in pixels." },
            min_height: { type: "integer", description: "Minimum acceptable height in pixels." },
            max_width: { type: "integer", description: "Maximum acceptable width in pixels." },
            max_height: { type: "integer", description: "Maximum acceptable height in pixels." },
            transparent: { type: "boolean", description: "When true, PNG must contain at least one transparent pixel; when false, it must be fully opaque." },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
      allowed_extensions: {
        type: "array",
        items: { type: "string" },
        description: "Optional extension allowlist overriding the artifact protocol, e.g. ['.png','.jpg'].",
      },
      min_bytes: { type: "integer", description: "Optional minimum byte size for non-manifest output files." },
    },
    additionalProperties: false,
  },
};

export const TOOL_PRUNE_ARTIFACT_OUTPUT = {
  type: "function",
  name: "prune_artifact_output",
  description:
    "Remove non-deliverable sidecar files from a scoped artifact output directory, preserving allowed image files and manifest files. " +
    "Use this instead of writing cleanup scripts inside output_root.",
  parameters: {
    type: "object",
    properties: {
      output_root: { type: "string", description: "Artifact output directory to prune. Defaults to the working directory." },
      task_mode: {
        type: "string",
        enum: ["image", "report", "content", "intake_processing"],
        description: "Artifact task mode used to derive allowed formats. Default: image.",
      },
      allowed_extensions: {
        type: "array",
        items: { type: "string" },
        description: "Optional extension allowlist overriding the artifact protocol, e.g. ['.png','.jpg'].",
      },
      keep_paths: {
        type: "array",
        items: { type: "string" },
        description: "Optional relative paths under output_root to preserve even if their extension is not allowed.",
      },
      dry_run: {
        type: "boolean",
        description: "When true, report what would be deleted without deleting. Default: false.",
      },
      remove_empty_dirs: {
        type: "boolean",
        description: "Remove empty directories left behind after pruning. Default: true.",
      },
      max_delete_count: {
        type: "integer",
        description: "Safety cap for files that may be deleted in one call. Default: 50.",
      },
    },
    additionalProperties: false,
  },
};

export const TOOL_OPTIMIZE_IMAGE = {
  type: "function",
  name: "optimize_image",
  description: "Optimize a PNG by stripping non-essential metadata chunks.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Source image path." },
      output_path: { type: "string", description: "Optional destination path. Defaults to source path." },
      overwrite: { type: "boolean", description: "When false, refuses to overwrite existing output_path." },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

export const TOOL_REENCODE_IMAGE = {
  type: "function",
  name: "reencode_image",
  description:
    "Re-encode an image to a clean PNG or JPEG within the allowed scope. " +
    "Use this to repair files whose extension does not match their bytes or transcode generated PNGs to true JPEG deliverables.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Source image path." },
      output_path: { type: "string", description: "Destination image path. Defaults to overwriting the source." },
      output_format: { type: "string", enum: ["png", "jpeg", "jpg"], description: "Output format. Defaults from output_path extension, then png." },
      quality: { type: "integer", description: "JPEG quality from 1-100 when outputting JPEG. Default: 90." },
      overwrite: { type: "boolean", description: "When false, refuses to overwrite existing output_path." },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

export const TOOL_CLEAN_IMAGE = {
  type: "function",
  name: "clean_image",
  description:
    "Inspect, re-encode, resize, or optimize an image through one scoped image cleanup tool. " +
    "Use this instead of separate resize/optimize/reencode calls.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Source image path." },
      output_path: { type: "string", description: "Optional destination path. Defaults to overwriting the source." },
      mode: {
        type: "string",
        enum: ["metadata", "optimize", "reencode", "resize", "clean", "alpha_key"],
        description:
          "Operation to run. metadata reads dimensions/format; optimize rewrites PNG without metadata; " +
          "reencode writes a clean PNG/JPEG; resize resizes a PNG to PNG/JPEG; clean reencodes/optimizes and optionally resizes; " +
          "alpha_key turns a solid edge-connected background color transparent.",
      },
      output_format: { type: "string", enum: ["png", "jpeg", "jpg"], description: "Output format for reencode/resize/clean. Defaults from output_path extension, then png." },
      quality: { type: "integer", description: "JPEG quality from 1-100 when outputting JPEG. Default: 90." },
      width: { type: "integer", description: "Target width in pixels for resize/clean." },
      height: { type: "integer", description: "Target height in pixels for resize/clean." },
      resize_mode: {
        type: "string",
        enum: ["fit", "fill", "stretch"],
        description: "Resize behavior when width/height are supplied. Default: fit.",
      },
      target_color: {
        type: "string",
        description: "For mode=alpha_key, background color to key out, e.g. '#ffffff' or '245,234,208'. Omit or use 'auto' to sample image corners.",
      },
      tolerance: {
        type: "integer",
        description: "For mode=alpha_key, per-channel tolerance from 0-255. Default: 24.",
      },
      sample: {
        type: "string",
        enum: ["corners", "top_left", "top_right", "bottom_left", "bottom_right"],
        description: "For mode=alpha_key auto target color sampling. Default: corners.",
      },
      sample_size: {
        type: "integer",
        description: "For mode=alpha_key, square corner sample size in pixels. Default: 3.",
      },
      edge_only: {
        type: "boolean",
        description: "For mode=alpha_key, only key pixels connected to the image edge. Default: true.",
      },
      overwrite: { type: "boolean", description: "When false, refuses to overwrite existing output_path." },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

export const TOOL_EXTRACT_IMAGE_TEXT = {
  type: "function",
  name: "extract_image_text",
  description:
    "Extract text from an image (OCR) using the local tesseract CLI. " +
    "Use this when you need the text content of a flyer, screenshot, scanned document, or other image. " +
    "Returns the recognized text. Requires tesseract to be installed on the host.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Image path (absolute or relative to working directory). Common formats: png, jpg, jpeg, tiff, bmp, gif, webp." },
      language: {
        type: "string",
        description: "Tesseract language code (e.g. 'eng', 'eng+fra'). Default: 'eng'.",
      },
      psm: {
        type: "integer",
        description: "Optional Tesseract page segmentation mode (0-13). Defaults to tesseract's own default.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

export const TOOL_BASH = {
  type: "function",
  name: "bash",
  description:
    "Execute a read-only inspection command or test/build runner and return stdout+stderr. " +
    "Do not use this to modify files; use write_file/edit_file or scoped file tools for workspace changes.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute" },
      timeout: { type: "integer", description: "Timeout in milliseconds. Default: 60000" },
    },
    required: ["command"],
    additionalProperties: false,
  },
};

export const TOOL_RUN_SCOPED_CHECKS = {
  type: "function",
  name: "run_scoped_checks",
  description:
    "Run deterministic lint/typecheck checks for the declared job scope in one batch. " +
    "Returns only all-checks-passed or compact failure feedback with file/line/rule details.",
  parameters: {
    type: "object",
    properties: {
      checks: {
        type: "array",
        items: { type: "string", enum: ["lint", "typecheck"] },
        description: "Checks to run. Default: ['lint'].",
      },
      scope: {
        type: "object",
        description: "Optional explicit scope override. Omit to use the declared job scope.",
        properties: {
          files: { type: "array", items: { type: "string" } },
          modifyFiles: { type: "array", items: { type: "string" } },
          createFiles: { type: "array", items: { type: "string" } },
          deleteFiles: { type: "array", items: { type: "string" } },
          roots: { type: "array", items: { type: "string" } },
          createRoots: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    },
    required: [],
    additionalProperties: false,
  },
};

export const TOOL_CREATE_TEST_SUITE = {
  type: "function",
  name: "create_test_suite",
  description:
    "Create or update one registered Posse test suite. Suites are stored in the runtime DB and mirrored under private .posse-test-suites metadata. " +
    "This does not list the full catalog; use a suite id/name returned by this tool for later calls.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Human-readable suite name, e.g. 'queue lease safety'." },
      slug: { type: "string", description: "Optional stable suite slug. Defaults from name." },
      explanation: { type: "string", description: "What this suite covers and when it should be run." },
    },
    required: ["name", "explanation"],
    additionalProperties: false,
  },
};

export const TOOL_CREATE_TEST = {
  type: "function",
  name: "create_test",
  description:
    "Register or update a test inside one existing suite. The test source must resolve to a function that returns/resolves true; " +
    "registration is rejected if the test fails. Declare the production files/functions the test covers so Posse can scope future runs. " +
    "The harness runs from a temp directory and deletes it after the run; put all scratch files in the provided tmp path.",
  parameters: {
    type: "object",
    properties: {
      suite_id: { type: "integer", description: "Target suite id. Prefer this when available." },
      suite: { type: "string", description: "Target suite name or slug when suite_id is not available." },
      name: { type: "string", description: "Human-readable test name." },
      slug: { type: "string", description: "Optional stable test slug. Defaults from name." },
      explanation: { type: "string", description: "What this test checks and why it belongs in the suite." },
      language: {
        type: "string",
        enum: ["javascript", "python"],
        description: "Runtime language for the test function.",
      },
      function_name: {
        type: "string",
        description: "Optional test function/export name. This is the test entrypoint, not the production function being covered.",
      },
      target_files: {
        type: "array",
        items: { type: "string" },
        description: "Workspace-relative production file paths covered by this test. Required so future runs can be scoped to edited files.",
      },
      target_symbols: {
        type: "array",
        items: { type: "string" },
        description: "Optional production functions/classes/symbols covered by this test, e.g. ['parseLeaseToken', 'Scheduler.acquire'].",
      },
      target_imports: {
        type: "array",
        description:
          "Optional import hints for covered files. The runner also passes targetFiles/targetSymbols/targetImports and helpers importTarget/requireTarget (JS) or import_target (Python).",
        items: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative file to import." },
            symbols: { type: "array", items: { type: "string" }, description: "Named exports/symbols to import or inspect." },
            default: { type: "string", description: "Default export/local binding hint." },
            namespace: { type: "string", description: "Namespace import/local binding hint." },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
      test: {
        type: "string",
        description:
          "Test source. JavaScript can be an async function/lambda, default export, or named export. Python should define function_name, test, run, or main. Return true to pass.",
      },
      timeout_ms: { type: "integer", description: "Per-test timeout in milliseconds. Default: 30000, max: 120000." },
    },
    required: ["name", "explanation", "language", "target_files", "test"],
    additionalProperties: false,
  },
};

export const TOOL_RUN_TEST = {
  type: "function",
  name: "run_test",
  description:
    "Run one registered Posse test by id, or by suite plus test name/slug. Returns pass/fail plus compact failure feedback.",
  parameters: {
    type: "object",
    properties: {
      test_id: { type: "integer", description: "Registered test id." },
      suite_id: { type: "integer", description: "Suite id when selecting by test name." },
      suite: { type: "string", description: "Suite name or slug when selecting by test name." },
      test: { type: "string", description: "Test name or slug when test_id is omitted." },
      timeout_ms: { type: "integer", description: "Per-test timeout in milliseconds. Default: 30000, max: 120000." },
    },
    required: [],
    additionalProperties: false,
  },
};

export const TOOL_RUN_TEST_SUITE = {
  type: "function",
  name: "run_test_suite",
  description:
    "Run all active tests in one registered suite. Requires a suite id/name and intentionally does not expose the full suite catalog.",
  parameters: {
    type: "object",
    properties: {
      suite_id: { type: "integer", description: "Registered suite id." },
      suite: { type: "string", description: "Suite name or slug." },
      timeout_ms: { type: "integer", description: "Per-test timeout in milliseconds. Default: 30000, max: 120000." },
    },
    required: [],
    additionalProperties: false,
  },
};

export const TOOL_MOVE_FILE = {
  type: "function",
  name: "move_file",
  description: "Move or rename a file within allowed workspace scope.",
  parameters: {
    type: "object",
    properties: {
      source: { type: "string", description: "Existing file path to move." },
      destination: { type: "string", description: "Destination file path." },
      overwrite: { type: "boolean", description: "When true, replace destination if it exists." },
    },
    required: ["source", "destination"],
    additionalProperties: false,
  },
};

export const TOOL_COPY_FILE = {
  type: "function",
  name: "copy_file",
  description: "Copy a file within allowed workspace scope.",
  parameters: {
    type: "object",
    properties: {
      source: { type: "string", description: "Existing file path to copy." },
      destination: { type: "string", description: "Destination file path." },
      overwrite: { type: "boolean", description: "When true, replace destination if it exists." },
    },
    required: ["source", "destination"],
    additionalProperties: false,
  },
};

export const TOOL_MAKE_DIR = {
  type: "function",
  name: "make_dir",
  description: "Create a directory (and parent directories) inside allowed scope.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path to create." },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

export const TOOL_CHAIN_READ = {
  type: "function",
  name: "chain_read",
  description:
    "Read a file. This is your ONLY way to read file contents. You must maintain " +
    "an audit log of every file read. Reading a file locks the chain until you " +
    "call chain_verdict to issue your verdict. Large files may be paged with " +
    "offset/limit by issuing a verdict for each page, then calling chain_read " +
    "again with a higher offset; continuation pages for the same file are allowed. " +
    "Optional search/jsonPath/maxBytes uses the same structured extraction as read_file.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file to read (relative to project root).",
      },
      offset: { type: "integer", description: "Starting line number, 1-based. Default: 1" },
      limit: { type: "integer", description: "Maximum number of lines to read. Default: 2000" },
      maxBytes: { type: "integer", description: "Maximum bytes to return in structured mode." },
      search: { type: "string", description: "Case-insensitive regex pattern to search within the selected line range." },
      searchContext: { type: "integer", description: "Context lines around each search match in structured mode." },
      jsonPath: { type: "string", description: "Dot-separated JSON path to extract from a JSON file." },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

export const TOOL_CHAIN_VERDICT = {
  type: "function",
  name: "chain_verdict",
  description:
    "Issue your verdict on the file you just read. You MUST call this after every " +
    "chain_read before you can read another file. Mark the file relevant or " +
    "irrelevant. Relevant files are kept in your research buffer for downstream " +
    "agents. Irrelevant files are logged so they are never re-read.",
  parameters: {
    type: "object",
    properties: {
      verdict: {
        type: "string",
        enum: ["relevant", "irrelevant"],
        description: "Whether this file is relevant to the research task.",
      },
      summary: {
        type: "string",
        description: "What you found. Required when relevant, optional when irrelevant.",
      },
    },
    required: ["verdict"],
    additionalProperties: false,
  },
};

export const TOOL_PULL_BRIEF = {
  type: "function",
  name: "pull_brief",
  description:
    "Deterministically gather a compact evidence brief from the repository in one guarded call. " +
    "Supports targeted gap-fill or bounded tree pull without shell commands.",
  parameters: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["gap_fill", "tree_pull"],
        description: "gap_fill targets missing evidence; tree_pull performs a bounded repo sweep.",
      },
      query: {
        type: "string",
        description: "Natural-language question or objective used to derive search terms.",
      },
      missing: {
        type: "array",
        items: { type: "string" },
        description: "Optional missing file hints or identifiers to prioritize in gap_fill mode.",
      },
      seed_paths: {
        type: "array",
        items: { type: "string" },
        description: "Optional relative paths to prioritize before scanning.",
      },
      max_files: {
        type: "integer",
        description: "Maximum number of files in the brief (1-30). Default: 12.",
      },
      max_lines_per_file: {
        type: "integer",
        description: "Maximum snippet lines per file (1-80). Default: 8.",
      },
      include_ext: {
        type: "array",
        items: { type: "string" },
        description: "Optional extension allowlist, e.g. ['.js','.php'].",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

export const TOOL_GENERATE_IMAGE = {
  type: "function",
  name: "generate_image",
  description:
    "Generate an image using the configured image provider/model and save it to path.",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "Detailed description of the image to generate.",
      },
      path: {
        type: "string",
        description: "Output image path relative to working directory.",
      },
      size: {
        type: "string",
        description: "Optional size hint (provider/model dependent).",
      },
      quality: {
        type: "string",
        description: "Optional quality hint (provider/model dependent).",
      },
      provider: {
        type: "string",
        enum: ["openai", "grok"],
        description: "Optional provider override. Defaults to configured image provider.",
      },
    },
    required: ["prompt", "path"],
    additionalProperties: false,
  },
};

const ATLAS_TOOL_DEFS_RAW = Object.freeze({
  "query": {
    type: "function",
    name: "atlas_query",
    description: "Gateway. Compact native ATLAS v2 retrieval wrapper for symbol, slice, context, diff/risk, and memory query actions.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["symbol.search", "symbol.getCard", "symbol.getCards", "symbol.usages", "slice.build", "slice.refresh", "slice.spillover.get", "edit.plan", "context", "context.summary", "delta.get", "pr.risk.analyze", "pr.risk", "repo.status", "repo.quality", "memory.query"], description: "ATLAS action to route through this gateway." },
      },
      required: ["action"],
      additionalProperties: true,
    },
  },
  "code": {
    type: "function",
    name: "atlas_code",
    description: "Gateway. Compact native ATLAS v2 code-inspection wrapper for skeleton, hot-path, edit planning, and gated raw-window actions.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["code.getSkeleton", "code.getHotPath", "code.needWindow", "edit.plan"], description: "ATLAS code action to route through this gateway." },
      },
      required: ["action"],
      additionalProperties: true,
    },
  },
  "repo": {
    type: "function",
    name: "atlas_repo",
    description: "Gateway. Compact native ATLAS v2 repository/operations wrapper for lifecycle, diagnostics, policy, usage, and SCIP actions.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["info", "action.search", "manual", "repo.register", "repo.status", "repo.quality", "index.refresh", "policy.get", "policy.set", "usage.stats", "runtime.execute", "runtime.queryOutput", "scip.ingest"], description: "ATLAS repository action to route through this gateway." },
      },
      required: ["action"],
      additionalProperties: true,
    },
  },
  "agent": {
    type: "function",
    name: "atlas_agent",
    description: "Gateway. Compact native ATLAS v2 agent wrapper for context, feedback, live buffers, and memory actions.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["context", "context.summary", "agent.feedback", "agent.feedback.query", "buffer.push", "buffer.checkpoint", "buffer.status", "memory.store", "memory.query", "memory.remove"], description: "ATLAS agent action to route through this gateway." },
      },
      required: ["action"],
      additionalProperties: true,
    },
  },
  "action.search": {
    type: "function",
    name: "atlas_action_search",
    description: "Discovery. Search the native ATLAS v2 action catalog for the right tool/action to call.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms such as symbol, memory, policy, risk, or raw window." },
        namespace: { type: "string", description: "Optional namespace filter such as repo, symbol, code, memory, policy, or agent." },
        limit: { type: "integer", description: "Maximum actions to return." },
      },
      required: [],
      additionalProperties: false,
    },
  },
  "manual": {
    type: "function",
    name: "atlas_manual",
    description: "Discovery. Return a compact native ATLAS v2 API manual filtered by query or explicit actions.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Filter manual entries by search terms." },
        actions: { type: "array", items: { type: "string" }, description: "Explicit action names to include." },
        limit: { type: "integer", description: "Maximum manual entries to return." },
        includeSchemas: { type: "boolean", description: "Include full JSON schemas. Defaults to compact parameter summaries." },
      },
      required: [],
      additionalProperties: false,
    },
  },
  "workflow": {
    type: "function",
    name: "atlas_workflow",
    description: "Workflow. Execute multiple native ATLAS v2 actions and data transforms in one call with $0/$stepId references, budget handling, and optional trace output.",
    parameters: {
      type: "object",
      properties: {
        repoId: { type: "string", description: "Optional repository identifier shared across workflow steps." },
        steps: {
          type: "array",
          description: "Ordered workflow steps. Use action for ATLAS actions or fn for camelCase action aliases/data transforms.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Optional step id for later references like $search.items[0].symbolId." },
              fn: { type: "string", description: "CamelCase ATLAS function alias or transform name such as dataPick." },
              action: { type: "string", description: "Canonical ATLAS action name such as symbol.search or code.getSkeleton." },
              args: { type: "object", description: "Step arguments. Exact string refs like $0.items[0].symbolId are resolved before execution." },
              maxResponseTokens: { type: "integer", description: "Optional per-step response token cap." },
            },
            additionalProperties: false,
          },
        },
        budget: {
          type: "object",
          properties: {
            maxTotalTokens: { type: "integer" },
            maxSteps: { type: "integer" },
            maxDurationMs: { type: "integer" },
          },
          additionalProperties: false,
        },
        onError: { type: "string", enum: ["continue", "stop"], description: "Whether to continue after a failed step. Defaults to continue." },
        defaultMaxResponseTokens: { type: "integer", description: "Default response cap for steps without maxResponseTokens." },
        onlyFinalResult: { type: "boolean", description: "Strip intermediate results from the returned payload." },
        trace: {
          type: "object",
          properties: {
            level: { type: "string", enum: ["summary", "verbose"] },
            includeResolvedArgs: { type: "boolean" },
            maxPreviewTokens: { type: "integer" },
          },
          additionalProperties: false,
        },
        dryRun: { type: "boolean", description: "Validate steps and references without executing." },
      },
      required: ["steps"],
      additionalProperties: false,
    },
  },
  "info": {
    type: "function",
    name: "atlas_info",
    description: "Diagnostics. Return native ATLAS v2 runtime, repository, storage, view freshness, ledger, and optional policy details.",
    parameters: {
      type: "object",
      properties: {
        repoId: { type: "string", description: "Optional stable repository identifier." },
        includePolicy: { type: "boolean", description: "Include the effective native ATLAS v2 policy." },
        includeCounts: { type: "boolean", description: "Include small ledger row-count diagnostics when a ledger is open." },
      },
      required: [],
      additionalProperties: false,
    },
  },
  "repo.register": {
    type: "function",
    name: "atlas_repo_register",
    description: "Lifecycle. Register the current repository with ATLAS v2, creating the ledger and an empty main view when needed.",
    parameters: {
      type: "object",
      properties: {
        repoId: { type: "string", description: "Optional stable repository identifier." },
        repoRoot: { type: "string", description: "Absolute repository root override." },
        branch: { type: "string", description: "Baseline ledger branch. Defaults to the configured merge target." },
        buildEmptyView: { type: "boolean", description: "Create an empty main view on cold repositories. Defaults to true." },
      },
      required: [],
      additionalProperties: false,
    },
  },
  "repo.status": {
    type: "function",
    name: "atlas_repo_status",
    description: "Bookkeeping/version anchor. Fetch ATLAS repository status and latest ledger version identifiers; this does not count as meaningful ATLAS retrieval by itself.",
    parameters: {
      type: "object",
      properties: {
        detail: { type: "string", description: "Detail level: minimal, standard, or full." },
        surfaceMemories: { type: "boolean", description: "Surface relevant memories when enabled in ATLAS." },
      },
      required: [],
      additionalProperties: false,
    },
  },
  "index.refresh": {
    type: "function",
    name: "atlas_index_refresh",
    description: "Lifecycle. Refresh the ATLAS v2 ledger and materialized view for the repository, either fully or for a bounded list of paths.",
    parameters: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["smart", "full", "incremental"], description: "Refresh mode. smart chooses incremental when paths are supplied, otherwise full." },
        paths: { type: "array", items: { type: "string" }, description: "Canonical repo-relative paths for incremental refresh." },
        branch: { type: "string", description: "Ledger branch to refresh. Defaults to the configured merge target." },
        wait: { type: "boolean", description: "Reserved for async schedulers; embedded v2 currently returns the warm result." },
        async: { type: "boolean", description: "Request async operation semantics. Embedded v2 records the request but currently completes synchronously." },
        includeDiagnostics: { type: "boolean", description: "Include phase timings and bounded progress events in the response." },
        operationId: { type: "string", description: "Optional caller-provided operation id for progress correlation." },
      },
      required: [],
      additionalProperties: false,
    },
  },
  "repo.overview": {
    type: "function",
    name: "atlas_repo_overview",
    description: "Discovery overview. Fetch token-efficient ATLAS repository summaries, indexed coverage, directory summaries, and hotspots.",
    parameters: {
      type: "object",
      properties: {
        level: { type: "string", enum: ["stats", "directories", "hotspots", "graph", "full"], description: "Detail level: stats, directories, hotspots, graph, or full." },
        includeHotspots: { type: "boolean", description: "Include hotspot analysis when supported." },
        directories: { type: "array", items: { type: "string" }, description: "Relative directories to focus on." },
        maxDirectories: { type: "integer", description: "Maximum directories to include." },
        maxExportsPerDirectory: { type: "integer", description: "Maximum exports to include per directory." },
        ifNoneMatch: { type: "string", description: "Optional ETag for conditional fetch." },
      },
      required: [],
      additionalProperties: false,
    },
  },
  "repo.quality": {
    type: "function",
    name: "atlas_repo_quality",
    description: "Diagnostics. Inspect ATLAS v2 index quality: view freshness, edge resolution, parser health, embeddings, and feedback gaps.",
    parameters: {
      type: "object",
      properties: {
        probeTreeSitter: { type: "boolean", description: "Attempt to load observed tree-sitter grammars and report failures." },
        feedbackLimit: { type: "integer", description: "Maximum feedback aggregates to inspect for quality hints." },
        halfLifeDays: { type: "number", description: "Optional recency decay half-life in days for feedback weights." },
      },
      required: [],
      additionalProperties: false,
    },
  },
  "buffer.push": {
    type: "function",
    name: "atlas_buffer_push",
    description: "Live editor overlay. Push an unsaved buffer into ATLAS v2 retrieval without writing it to disk.",
    parameters: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Canonical repository-relative path for the buffer." },
        content: { type: "string", description: "Full buffer contents." },
        sessionId: { type: "string", description: "Optional editor/session namespace." },
        version: { type: "integer", description: "Optional editor buffer version." },
        eventType: { type: "string", enum: ["open", "change", "save", "close", "checkpoint"], description: "Editor event that produced this buffer update." },
        language: { type: "string", description: "Editor language id, when available." },
        dirty: { type: "boolean", description: "Whether the editor buffer has unsaved changes." },
        timestamp: { type: "string", description: "Editor event timestamp. Defaults to receipt time." },
        cursor: {
          type: "object",
          properties: {
            line: { type: "integer" },
            column: { type: "integer" },
          },
          additionalProperties: false,
        },
        selections: {
          type: "array",
          items: {
            type: "object",
            properties: {
              startLine: { type: "integer" },
              startColumn: { type: "integer" },
              endLine: { type: "integer" },
              endColumn: { type: "integer" },
            },
            additionalProperties: false,
          },
        },
      },
      required: ["filePath", "content"],
      additionalProperties: false,
    },
  },
  "buffer.checkpoint": {
    type: "function",
    name: "atlas_buffer_checkpoint",
    description: "Live editor overlay. Clear an ATLAS v2 buffer overlay after it has been saved, or optionally write it to disk.",
    parameters: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Canonical repository-relative path for the buffer." },
        sessionId: { type: "string", description: "Optional editor/session namespace." },
        writeToDisk: { type: "boolean", description: "Write overlay contents to disk before clearing." },
        clear: { type: "boolean", description: "Clear the overlay even when disk contents differ." },
      },
      required: ["filePath"],
      additionalProperties: false,
    },
  },
  "buffer.status": {
    type: "function",
    name: "atlas_buffer_status",
    description: "Live editor overlay. Inspect active ATLAS v2 unsaved buffers for the repository.",
    parameters: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Optional canonical repository-relative path filter." },
        sessionId: { type: "string", description: "Optional editor/session namespace." },
      },
      required: [],
      additionalProperties: false,
    },
  },
  "symbol.search": {
    type: "function",
    name: "atlas_symbol_search",
    description: "Discovery. Search ATLAS's indexed symbol graph for relevant symbols by name, concept, or semantic hint when you do not yet know the symbol ID.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Symbol search query." },
        limit: { type: "integer", description: "Maximum number of results to return." },
        semantic: { type: "boolean", description: "Enable semantic reranking when supported." },
        scope: { type: "string", enum: ["name", "body", "either"], description: "Search symbol names, symbol-body identifier tokens, or both. Default either." },
        entities: {
          type: "array",
          items: { type: "string", enum: ["symbols", "memories", "feedback"] },
          description: "Entity families to include. Default symbols; memories and feedback are returned in a separate entities list.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  "symbol.getCard": {
    type: "function",
    name: "atlas_symbol_get_card",
    description: "Iris Rung 1 (~100 tokens). Fetch symbol card(s): pass symbolId (or symbolRef) for one card, or symbolIds for a batch answered as { cards, errors } with partial success. Signature, summary, callers/callees, and location.",
    parameters: {
      type: "object",
      properties: {
        symbolId: { type: "string", pattern: ATLAS_SYMBOL_ID_PATTERN, description: "Opaque ATLAS symbol ID returned by symbol.search, symbol.getCard, slice.build, skeleton, or hot path results. Do not construct this from file paths or names." },
        symbolIds: { type: "array", items: { type: "string", pattern: ATLAS_SYMBOL_ID_PATTERN }, description: "Batch mode: fetch up to 100 cards in one call; the result is { cards, errors } with per-symbol partial success." },
        symbolRef: {
          type: "object",
          description: "Fallback lookup when you do not have a symbolId. Prefer symbol.search first; use this for a concrete name plus optional file.",
          properties: {
            name: { type: "string", description: "Symbol name to resolve." },
            file: { type: "string", description: "Optional repository-relative file path containing the symbol." },
            kind: { type: "string", description: "Optional symbol kind hint." },
            exportedOnly: { type: "boolean", description: "Prefer exported symbols only when possible." },
          },
          required: ["name"],
          additionalProperties: false,
        },
        ifNoneMatch: { type: "string", description: "Optional ETag for conditional fetch." },
        minCallConfidence: { type: "number", description: "Minimum call-confidence threshold." },
        includeResolutionMetadata: { type: "boolean", description: "Include ATLAS resolution metadata." },
      },
      required: [],
      additionalProperties: false,
    },
  },
  "symbol.getCards": {
    type: "function",
    name: "atlas_symbol_get_cards",
    description: "Iris Rung 1 batch. Fetch multiple ATLAS symbol cards by symbolIds or symbolRefs with partial-success errors.",
    parameters: {
      type: "object",
      properties: {
        symbolIds: { type: "array", items: { type: "string", pattern: ATLAS_SYMBOL_ID_PATTERN }, description: "Opaque ATLAS symbol IDs to hydrate." },
        symbolRefs: {
          type: "array",
          description: "Natural symbol references to hydrate when IDs are not available.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              file: { type: "string" },
              kind: { type: "string" },
              exportedOnly: { type: "boolean" },
            },
            required: ["name"],
            additionalProperties: false,
          },
        },
        cards: { type: "array", items: { type: "object" }, description: "Mixed entries with symbolId or symbolRef." },
        minCallConfidence: { type: "number", description: "Minimum call-edge confidence from 0 to 1." },
        includeResolutionMetadata: { type: "boolean", description: "Include resolution metadata when supported." },
        sessionId: { type: "string", description: "Optional live-buffer overlay namespace." },
      },
      required: [],
      additionalProperties: false,
    },
  },
  "slice.build": {
    type: "function",
    name: "atlas_slice_build",
    description: "Task scoping. Build a bounded ATLAS slice for a task or known entry symbols before escalating into code evidence. TaskText-only requests use semantic entry discovery when embeddings are active and lexical entry discovery otherwise; provide entrySymbols or editedFiles for tighter precision.",
    parameters: {
      type: "object",
      properties: {
        taskText: { type: "string", description: "Natural-language task description." },
        semantic: { type: "boolean", description: "Enable semantic/vector entry discovery when configured. Defaults on for taskText when semantic dispatch is enabled." },
        taskType: { type: "string", enum: ["debug", "review", "implement", "explain"], description: "Optional task type for feedback-aware ranking." },
        entrySymbols: { type: "array", items: { type: "string", pattern: ATLAS_SYMBOL_ID_PATTERN }, description: "Opaque ATLAS symbol IDs returned by ATLAS results. Do not construct these from file paths or names." },
        editedFiles: { type: "array", items: { type: "string" }, description: "Relative edited file paths." },
        stackTrace: { type: "string", description: "Optional stack trace for debugging context." },
        failingTestPath: { type: "string", description: "Optional failing test path." },
        cardDetail: { type: "string", description: "ATLAS card detail level." },
        adaptiveDetail: { type: "boolean", description: "Enable adaptive detail selection." },
        knownCardEtags: { type: "object", additionalProperties: { type: "string" }, description: "Optional map of symbolId to card ETag already held by the agent; matching cards return lightweight refs." },
        ifNoneMatch: { type: "string", description: "Optional slice ETag for conditional fetch; matching slices return notModified metadata only." },
        wireFormat: { type: "string", enum: ["standard", "compact", "agent", "packed"], description: "Response wire format. Use packed for columnar token-efficient cards." },
        wireFormatVersion: { type: "integer", minimum: 1, maximum: 3, description: "Wire format version." },
        maxCards: { type: "integer", description: "Budget: maximum cards." },
        maxTokens: { type: "integer", description: "Budget: maximum estimated tokens." },
      },
      required: [],
      additionalProperties: false,
    },
  },
  "slice.refresh": {
    type: "function",
    name: "atlas_slice_refresh",
    description: "Task scoping. Refresh an existing ATLAS slice incrementally when you already have a sliceHandle and knownVersion.",
    parameters: {
      type: "object",
      properties: {
        sliceHandle: { type: "string", description: "ATLAS slice handle." },
        knownVersion: { type: "string", description: "Known slice version." },
      },
      required: ["sliceHandle", "knownVersion"],
      additionalProperties: false,
    },
  },
  "slice.spillover.get": {
    type: "function",
    name: "atlas_slice_spillover_get",
    description: "Task scoping overflow. Fetch overflow symbols only when a truncated slice or delta returned a spilloverHandle.",
    parameters: {
      type: "object",
      properties: {
        spilloverHandle: { type: "string", description: "Spillover handle returned by a truncated slice." },
        cursor: { type: "string", description: "Optional pagination cursor." },
        pageSize: { type: "integer", description: "Page size from 1 to 100." },
      },
      required: ["spilloverHandle"],
      additionalProperties: false,
    },
  },
  "symbol.usages": {
    type: "function",
    name: "atlas_symbol_usages",
    description: "Usage tracing. Return compact call/reference sites for an ATLAS symbolId without hydrating full caller cards.",
    parameters: {
      type: "object",
      properties: {
        symbolId: { type: "string", pattern: ATLAS_SYMBOL_ID_PATTERN, description: "Opaque ATLAS symbol ID whose usages should be listed." },
        kind: { type: "array", items: { type: "string", enum: ["calls", "references", "reads", "writes", "uses_type", "imports", "extends", "implements"] }, description: "Optional edge kinds to include." },
        limit: { type: "integer", description: "Maximum usage sites to return." },
        minConfidence: { type: "number", description: "Minimum edge confidence, either 0..1 or 0..100." },
        includeUnresolved: { type: "boolean", description: "Also include unresolved references with the same target name." },
      },
      required: ["symbolId"],
      additionalProperties: false,
    },
  },
  "tree.overview": {
    type: "function",
    name: "atlas_tree_overview",
    description: "Top-level code tree orientation. Returns the root page of the ATLAS containment tree plus the compressed-tree labeled area map. Use tree.walk to drill into a specific branch.",
    parameters: {
      type: "object",
      properties: {
        nodeId: { type: "string", description: "Exact ATLAS tree node id, such as root, dir:src, file:src/run.ts, or a symbol node id." },
        path: { type: "string", description: "Canonical repo-relative file or directory path to focus." },
        symbolId: { type: "string", pattern: ATLAS_SYMBOL_ID_PATTERN, description: "Stable ATLAS symbol ID/ref. Duplicated blobs may return multiple tree locations; pass path to disambiguate." },
        refType: { type: "string", enum: ["cluster", "process"], description: "Direct leaf ref lookup type." },
        refId: { type: "string", description: "Cluster/process id for ref lookup." },
        maxDepth: { type: "integer", description: "Descendant depth from focused node(s). Default 1, max 8." },
        limit: { type: "integer", description: "Maximum nodes to return. Default 100, max 500." },
        offset: { type: "integer", description: "Page offset into the focused subtree." },
        includeAggregates: { type: "boolean", description: "Include aggregate counts/raw metrics on each node. Default true." },
        includeTerms: { type: "boolean", description: "Include generated search terms on each node. Default false." },
        includeRefs: { type: "boolean", description: "Include direct cluster/process refs on returned nodes. Default false." },
        includeLatestRun: { type: "boolean", description: "Include latest tree-derived build run metadata. Default true." },
      },
      required: [],
      additionalProperties: false,
    },
  },
  "tree.walk": {
    type: "function",
    name: "atlas_tree_walk",
    description: "Walk a code-tree branch. Focus a path, nodeId, symbolId, or cluster/process ref and page through its descendants with aggregate counts and compressed-tree area labels.",
    parameters: {
      type: "object",
      properties: {
        nodeId: { type: "string", description: "Exact ATLAS tree node id, such as root, dir:src, file:src/run.ts, or a symbol node id." },
        path: { type: "string", description: "Canonical repo-relative file or directory path to focus." },
        symbolId: { type: "string", pattern: ATLAS_SYMBOL_ID_PATTERN, description: "Stable ATLAS symbol ID/ref. Duplicated blobs may return multiple tree locations; pass path to disambiguate." },
        refType: { type: "string", enum: ["cluster", "process"], description: "Direct leaf ref lookup type." },
        refId: { type: "string", description: "Cluster/process id for ref lookup." },
        maxDepth: { type: "integer", description: "Descendant depth from focused node(s). Default 1, max 8." },
        limit: { type: "integer", description: "Maximum nodes to return. Default 100, max 500." },
        offset: { type: "integer", description: "Page offset into the focused subtree." },
        includeAggregates: { type: "boolean", description: "Include aggregate counts/raw metrics on each node. Default true." },
        includeTerms: { type: "boolean", description: "Include generated search terms on each node. Default false." },
        includeRefs: { type: "boolean", description: "Include direct cluster/process refs on returned nodes. Default false." },
        includeLatestRun: { type: "boolean", description: "Include latest tree-derived build run metadata. Default true." },
      },
      required: [],
      additionalProperties: false,
    },
  },
  "tree.scope": {
    type: "function",
    name: "atlas_tree_scope",
    description: "Prefetch-only task scoping. The handoff runs this with the full task text; agents should use tree.grow (seed expansion), tree.walk, and symbol tools instead.",
    parameters: {
      type: "object",
      properties: {
        taskText: { type: "string", description: "Natural-language task, bug, or planning text to score against projected tree terms." },
        taskType: { type: "string", enum: ["debug", "review", "implement", "explain"], description: "Optional task type for test/scope hints." },
        paths: { type: "array", items: { type: "string" }, description: "Repo-relative file or directory seeds." },
        editedFiles: { type: "array", items: { type: "string" }, description: "Known or proposed repo-relative file scope seeds." },
        path: { type: "string", description: "Single repo-relative file or directory seed." },
        symbolIds: { type: "array", items: { type: "string", pattern: ATLAS_SYMBOL_ID_PATTERN }, description: "Opaque ATLAS symbol IDs to use as exact seeds." },
        symbolId: { type: "string", pattern: ATLAS_SYMBOL_ID_PATTERN, description: "Single opaque ATLAS symbol ID seed." },
        nodeIds: { type: "array", items: { type: "string" }, description: "Exact tree node ids from tree.overview." },
        refs: {
          type: "array",
          items: {
            type: "object",
            properties: {
              refType: { type: "string", enum: ["cluster", "process"] },
              refId: { type: "string" },
            },
            required: ["refType", "refId"],
            additionalProperties: false,
          },
          description: "Cluster/process refs as weak seeds; broad refs are rejected and reported.",
        },
        refType: { type: "string", enum: ["cluster", "process"], description: "Single ref type." },
        refId: { type: "string", description: "Single cluster/process ref id." },
        maxFiles: { type: "integer", description: "Maximum candidate files returned. Default 40, max 500." },
        maxBranches: { type: "integer", description: "Maximum accepted containment branches. Default 12." },
        branchFileCap: { type: "integer", description: "Maximum files under one accepted branch before it is treated as broad. Default 40." },
        refMatchLimit: { type: "integer", description: "Maximum ref matches to score before treating the ref as broad. Default 50." },
      },
      required: [],
      additionalProperties: false,
    },
  },
  "tree.grow": {
    type: "function",
    name: "atlas_tree_grow",
    description: "Grow scope from validated seeds. Expand files/areas you already know matter into surrounding branches, sibling files, tests, and entrypoints, with deterministic scope/risk metrics. Use symbol.getCard/symbol.usages for symbol identity; use this for file/area breadth.",
    parameters: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" }, description: "Repo-relative file or directory seeds." },
        editedFiles: { type: "array", items: { type: "string" }, description: "Known or proposed repo-relative file scope seeds." },
        path: { type: "string", description: "Single repo-relative file or directory seed." },
        symbolIds: { type: "array", items: { type: "string", pattern: ATLAS_SYMBOL_ID_PATTERN }, description: "Opaque ATLAS symbol IDs to use as exact seeds." },
        symbolId: { type: "string", pattern: ATLAS_SYMBOL_ID_PATTERN, description: "Single opaque ATLAS symbol ID seed." },
        nodeIds: { type: "array", items: { type: "string" }, description: "Exact tree node ids from tree.overview." },
        refs: {
          type: "array",
          items: {
            type: "object",
            properties: {
              refType: { type: "string", enum: ["cluster", "process"] },
              refId: { type: "string" },
            },
            required: ["refType", "refId"],
            additionalProperties: false,
          },
          description: "Cluster/process refs as weak seeds; broad refs are rejected and reported.",
        },
        refType: { type: "string", enum: ["cluster", "process"], description: "Single ref type." },
        refId: { type: "string", description: "Single cluster/process ref id." },
        maxFiles: { type: "integer", description: "Maximum candidate files returned. Default 40, max 500." },
        maxBranches: { type: "integer", description: "Maximum accepted containment branches. Default 12." },
        branchFileCap: { type: "integer", description: "Maximum files under one accepted branch before it is treated as broad. Default 40." },
        refMatchLimit: { type: "integer", description: "Maximum ref matches to score before treating the ref as broad. Default 50." },
      },
      required: [],
      additionalProperties: false,
    },
  },
  "edit.plan": {
    type: "function",
    name: "atlas_edit_plan",
    description: "Preview-only edit planning. Produce symbol/file-scoped edit candidates with preconditions before using scoped write tools.",
    parameters: {
      type: "object",
      properties: {
        taskText: { type: "string", description: "Natural-language edit intent." },
        targetSymbols: { type: "array", items: { type: "string", pattern: ATLAS_SYMBOL_ID_PATTERN }, description: "Opaque ATLAS symbol IDs to scope the plan." },
        targetFiles: { type: "array", items: { type: "string" }, description: "Repository-relative files to scope the plan." },
        search: { type: "string", description: "Text/pattern the planned edit expects to find." },
        replace: { type: "string", description: "Replacement text for replace plans." },
        operation: { type: "string", enum: ["replace", "insert", "delete", "inspect"], description: "Planned operation type." },
        maxEdits: { type: "integer", minimum: 1, maximum: 500, description: "Maximum preview edits to return." },
      },
      required: [],
      additionalProperties: false,
    },
  },
  "code.getSkeleton": {
    type: "function",
    name: "atlas_code_get_skeleton",
    description: "Iris Rung 2 (~300 tokens). Fetch a deterministic code skeleton for a file or symbol without full raw bodies.",
    parameters: {
      type: "object",
      properties: {
        symbolId: { type: "string", pattern: ATLAS_SYMBOL_ID_PATTERN, description: "Optional opaque ATLAS symbol ID returned by ATLAS. Do not pass a file path here; use file for path-based skeletons." },
        file: { type: "string", description: "Optional relative file path to inspect." },
        exportedOnly: { type: "boolean", description: "Prefer exported symbols only when possible." },
      },
      required: [],
      additionalProperties: false,
    },
  },
  "code.getHotPath": {
    type: "function",
    name: "atlas_code_get_hot_path",
    description: "Iris Rung 3 (~600 tokens). Fetch identifier-focused code lines with small context windows for an ATLAS symbol or a repo-relative file.",
    parameters: {
      type: "object",
      properties: {
        symbolId: { type: "string", pattern: ATLAS_SYMBOL_ID_PATTERN, description: "Opaque ATLAS symbol ID returned by ATLAS. Do not construct this from a file path, symbol name, or file:symbol pair." },
        file: { type: "string", description: "Repository-relative file path fallback when you have a file but not an opaque symbolId." },
        identifiersToFind: { type: "array", items: { type: "string" }, description: "Identifiers to match. Prefer a JSON array; legacy scalar strings are normalized." },
        contextLines: { type: "integer", description: "Context lines around each match." },
      },
      required: ["identifiersToFind"],
      additionalProperties: false,
    },
  },
  "code.needWindow": {
    type: "function",
    name: "atlas_code_need_window",
    description: "Iris Rung 4 (~2000 tokens). Request a policy-gated raw code window for one ATLAS symbol or file only after card, skeleton, or hot-path evidence is insufficient. Prefer expectedLines as a JSON number and identifiersToFind as a JSON array; legacy strings are normalized.",
    parameters: {
      type: "object",
      properties: {
        symbolId: { type: "string", pattern: ATLAS_SYMBOL_ID_PATTERN, description: "Opaque ATLAS symbol ID from symbol.search, symbol.getCard, slice.build, skeleton, or hot path results. Do not pass a file path, symbol name, or file:symbol pair here." },
        file: { type: "string", description: "Repository-relative file path fallback when you have a file but not an opaque symbolId." },
        reason: { type: "string", description: "Required proof-of-need justification for raw window escalation." },
        identifiersToFind: { type: "array", items: { type: "string" }, description: "Identifiers expected in the requested window, for example [\"generateMusic\",\"json_decode\"]. Prefer a JSON array; legacy scalar strings are normalized." },
        expectedLines: { type: "integer", description: "Approximate line count. Prefer a JSON number, for example 40; legacy numeric strings are normalized." },
        maxTokens: { type: "integer", description: "Max tokens budget for the raw window." },
      },
      required: ["reason", "expectedLines", "identifiersToFind"],
      additionalProperties: false,
    },
  },
  "context": {
    type: "function",
    name: "atlas_context",
    description: "Task-shaped discovery. Retrieve generated ATLAS context for explain, debug, review, or implement work before broad native reads.",
    parameters: {
      type: "object",
      properties: {
        taskText: { type: "string", description: "Task description for ATLAS context retrieval." },
        taskType: { type: "string", description: "Task type such as debug, review, implement, or explain." },
        contextMode: { type: "string", description: "Context breadth mode: precise or broad." },
        focusSymbols: { type: "array", items: { type: "string", pattern: ATLAS_SYMBOL_ID_PATTERN }, description: "Optional opaque ATLAS symbol IDs returned by ATLAS results." },
        focusPaths: { type: "array", items: { type: "string" }, description: "Optional file paths to focus." },
        maxTokens: { type: "integer", description: "Budget: maximum generated context tokens." },
        maxActions: { type: "integer", description: "Budget: maximum retrieval actions." },
      },
      required: ["taskText"],
      additionalProperties: false,
    },
  },
  "context.summary": {
    type: "function",
    name: "atlas_context_summary",
    description: "Task-shaped summary. Retrieve compact ATLAS context with an answer, evidence list, quality hints, and next action guidance.",
    parameters: {
      type: "object",
      properties: {
        taskText: { type: "string", description: "Task description for ATLAS context retrieval." },
        taskType: { type: "string", description: "Task type such as debug, review, implement, or explain." },
        contextMode: { type: "string", description: "Context breadth mode: precise or broad." },
        focusSymbols: { type: "array", items: { type: "string", pattern: ATLAS_SYMBOL_ID_PATTERN }, description: "Optional opaque ATLAS symbol IDs returned by ATLAS results." },
        focusPaths: { type: "array", items: { type: "string" }, description: "Optional file paths to focus." },
        maxTokens: { type: "integer", description: "Budget: maximum generated context tokens." },
        maxActions: { type: "integer", description: "Budget: maximum retrieval actions." },
        maxEvidence: { type: "integer", description: "Maximum evidence items to include in the compact summary." },
        includeCards: { type: "boolean", description: "Include compact symbol cards beside the summary evidence." },
      },
      required: ["taskText"],
      additionalProperties: false,
    },
  },
  "agent.feedback": {
    type: "function",
    name: "atlas_agent_feedback",
    description: "Record which symbols were useful or missing to improve future ATLAS context quality.",
    parameters: {
      type: "object",
      properties: {
        sliceHandle: { type: "string", description: "Slice handle used during the task." },
        usefulSymbols: { type: "array", items: { type: "string", pattern: ATLAS_SYMBOL_ID_PATTERN }, description: "Opaque ATLAS symbol IDs that were helpful. Non-ID placeholders are accepted for diagnostics but do not improve symbol ranking." },
        missingSymbols: { type: "array", items: { type: "string", pattern: ATLAS_SYMBOL_ID_PATTERN }, description: "Opaque ATLAS symbol IDs that were missing or needed. Non-ID placeholders are accepted for diagnostics but do not improve symbol ranking." },
        taskType: { type: "string", description: "Task type such as debug, review, implement, or explain." },
        taskText: { type: "string", description: "Short description of the task context." },
        taskTags: { type: "array", items: { type: "string" }, description: "Short outcome/context tags such as role:dev or outcome:succeeded." },
      },
      required: ["sliceHandle"],
      additionalProperties: false,
    },
  },
  "agent.feedback.query": {
    type: "function",
    name: "atlas_agent_feedback_query",
    description: "Query ATLAS feedback aggregates for offline tuning and relevance diagnostics.",
    parameters: {
      type: "object",
      properties: {
        since: { type: "string", description: "Optional ISO timestamp lower bound." },
        limit: { type: "integer", description: "Maximum aggregate rows to return." },
        taskType: { type: "string", description: "Optional task type filter such as debug, review, implement, or explain." },
        halfLifeDays: { type: "number", description: "Optional recency decay half-life in days for weighted aggregates." },
      },
      required: [],
      additionalProperties: false,
    },
  },
  "delta.get": {
    type: "function",
    name: "atlas_delta_get",
    description: "Review evidence. Fetch an ATLAS semantic diff and blast-radius delta between two ledger versions.",
    parameters: {
      type: "object",
      properties: {
        fromVersion: { type: "string", description: "Base version ID." },
        toVersion: { type: "string", description: "Head version ID." },
        maxCards: { type: "integer", description: "Budget: maximum cards." },
        maxTokens: { type: "integer", description: "Budget: maximum estimated tokens." },
      },
      required: ["fromVersion", "toVersion"],
      additionalProperties: false,
    },
  },
  "pr.risk.analyze": {
    type: "function",
    name: "atlas_pr_risk_analyze",
    description: "Review evidence. Run ATLAS PR risk analysis with scored findings, blast-radius evidence, and test recommendations.",
    parameters: {
      type: "object",
      properties: {
        fromVersion: { type: "string", description: "Base version ID." },
        toVersion: { type: "string", description: "Head version ID." },
        riskThreshold: { type: "number", description: "Optional risk threshold (0-100)." },
      },
      required: ["fromVersion", "toVersion"],
      additionalProperties: false,
    },
  },
  "pr.risk": {
    type: "function",
    name: "atlas_pr_risk",
    description: "Assessor-first review. Fetch ATLAS semantic delta, blast radius, risk findings, and test recommendations in one combined call.",
    parameters: {
      type: "object",
      properties: {
        fromVersion: { type: "string", description: "Base version ID." },
        toVersion: { type: "string", description: "Head version ID." },
        maxCards: { type: "integer", description: "Budget for the semantic delta." },
        maxTokens: { type: "integer", description: "Token budget for the semantic delta." },
        riskThreshold: { type: "number", description: "Optional risk threshold (0-100)." },
      },
      required: ["fromVersion", "toVersion"],
      additionalProperties: false,
    },
  },
  "memory.store": {
    type: "function",
    name: "atlas_memory_store",
    description: "Memory. Store or update a native ATLAS v2 development memory linked to symbols and repo-relative files.",
    parameters: {
      type: "object",
      properties: {
        repoId: { type: "string", description: "Optional repository identifier; defaults to the current ATLAS repo." },
        type: { type: "string", enum: ["decision", "bugfix", "task_context", "pattern", "convention", "architecture", "performance", "security"], description: "Memory type." },
        title: { type: "string", description: "Short memory title." },
        content: { type: "string", description: "Memory content. Capture why the decision/context matters." },
        tags: { type: "array", items: { type: "string" }, description: "Optional tags." },
        confidence: { type: "number", description: "Confidence from 0 to 1." },
        symbolIds: { type: "array", items: { type: "string", pattern: ATLAS_SYMBOL_ID_PATTERN }, description: "Optional linked ATLAS symbol IDs." },
        fileRelPaths: { type: "array", items: { type: "string" }, description: "Optional linked repo-relative files." },
        memoryId: { type: "string", description: "Optional existing memory ID to update." },
      },
      required: ["type", "title", "content"],
      additionalProperties: false,
    },
  },
  "memory.query": {
    type: "function",
    name: "atlas_memory_query",
    description: "Memory. Search native ATLAS v2 memories by text, type, tags, linked symbols, linked files, staleness, recency, or confidence.",
    parameters: {
      type: "object",
      properties: {
        repoId: { type: "string", description: "Optional repository identifier; defaults to the current ATLAS repo." },
        query: { type: "string", description: "Text search over title, content, and tags." },
        types: { type: "array", items: { type: "string", enum: ["decision", "bugfix", "task_context", "pattern", "convention", "architecture", "performance", "security"] }, description: "Optional memory type filters." },
        tags: { type: "array", items: { type: "string" }, description: "Required tags; all supplied tags must match." },
        symbolIds: { type: "array", items: { type: "string", pattern: ATLAS_SYMBOL_ID_PATTERN }, description: "Optional linked symbol filters." },
        fileRelPaths: { type: "array", items: { type: "string" }, description: "Optional linked file filters." },
        staleOnly: { type: "boolean", description: "Return only stale memories." },
        limit: { type: "integer", description: "Maximum memories to return." },
        offset: { type: "integer", description: "Pagination offset." },
        sortBy: { type: "string", enum: ["recency", "confidence", "score"], description: "Sort mode." },
      },
      required: [],
      additionalProperties: false,
    },
  },
  "memory.remove": {
    type: "function",
    name: "atlas_memory_remove",
    description: "Memory. Soft-delete a native ATLAS v2 memory.",
    parameters: {
      type: "object",
      properties: {
        repoId: { type: "string", description: "Optional repository identifier; defaults to the current ATLAS repo." },
        memoryId: { type: "string", description: "Memory ID to remove." },
        deleteFile: { type: "boolean", description: "Accepted for compatibility; native v2 memories are ledger-backed." },
      },
      required: ["memoryId"],
      additionalProperties: false,
    },
  },
  "memory.surface": {
    type: "function",
    name: "atlas_memory_surface",
    description: "Memory. Auto-surface native ATLAS v2 memories relevant to symbols, files, or task type.",
    parameters: {
      type: "object",
      properties: {
        repoId: { type: "string", description: "Optional repository identifier; defaults to the current ATLAS repo." },
        symbolIds: { type: "array", items: { type: "string", pattern: ATLAS_SYMBOL_ID_PATTERN }, description: "Symbols to match." },
        fileRelPaths: { type: "array", items: { type: "string" }, description: "Files to match." },
        taskType: { type: "string", enum: ["decision", "bugfix", "task_context", "pattern", "convention", "architecture", "performance", "security"], description: "Optional memory type to prefer." },
        limit: { type: "integer", description: "Maximum memories to return." },
      },
      required: [],
      additionalProperties: false,
    },
  },
  "policy.get": {
    type: "function",
    name: "atlas_policy_get",
    description: "Policy. Fetch native ATLAS v2 policy for the current repository.",
    parameters: {
      type: "object",
      properties: {
        repoId: { type: "string", description: "Optional repository identifier; defaults to the current ATLAS repo." },
      },
      required: [],
      additionalProperties: false,
    },
  },
  "policy.set": {
    type: "function",
    name: "atlas_policy_set",
    description: "Policy. Patch native ATLAS v2 policy values such as code-window caps, memory enablement, and runtime enablement.",
    parameters: {
      type: "object",
      properties: {
        repoId: { type: "string", description: "Optional repository identifier; defaults to the current ATLAS repo." },
        policyPatch: {
          type: "object",
          properties: {
            maxWindowLines: { type: "integer" },
            maxWindowTokens: { type: "integer" },
            requireIdentifiers: { type: "boolean" },
            allowBreakGlass: { type: "boolean" },
            defaultMinCallConfidence: { type: "number" },
            defaultDenyRaw: { type: "boolean" },
            memoryEnabled: { type: "boolean" },
            runtimeEnabled: { type: "boolean" },
            budgetCaps: {
              type: "object",
              properties: {
                maxCards: { type: "integer" },
                maxEstimatedTokens: { type: "integer" },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
      },
      required: ["policyPatch"],
      additionalProperties: false,
    },
  },
  "usage.stats": {
    type: "function",
    name: "atlas_usage_stats",
    description: "Usage. Report native ATLAS v2 action counts, latency, and estimated token savings from ledger usage events.",
    parameters: {
      type: "object",
      properties: {
        repoId: { type: "string", description: "Optional repository identifier; defaults to the current ATLAS repo." },
        scope: { type: "string", enum: ["session", "history", "both"], description: "Stats scope." },
        since: { type: "string", description: "Optional ISO timestamp lower bound." },
        limit: { type: "integer", description: "Maximum history rows." },
        aggregateLimit: { type: "integer", description: "Maximum rows scanned for aggregate totals. Default: 1000." },
        persist: { type: "boolean", description: "Accepted for compatibility; native v2 records events continuously." },
      },
      required: [],
      additionalProperties: false,
    },
  },
  "runtime.execute": {
    type: "function",
    name: "atlas_runtime_execute",
    description: "Runtime. Execute a policy-gated command inside the repository with timeout, output caps, redaction, and optional output artifact storage.",
    parameters: {
      type: "object",
      properties: {
        repoId: { type: "string", description: "Optional repository identifier; policy is scoped by repo." },
        runtime: { type: "string", enum: ["node", "python", "python3", "shell"], description: "Runtime family to execute." },
        executable: { type: "string", description: "Optional PATH command override. Paths are denied." },
        args: { type: "array", items: { type: "string" }, description: "Arguments passed directly to the executable without a shell." },
        code: { type: "string", description: "Optional code snippet written to a temporary ATLAS artifact file and executed." },
        relativeCwd: { type: "string", description: "Working directory relative to repo root; must not escape the repo." },
        timeoutMs: { type: "integer", description: "Execution timeout in milliseconds." },
        queryTerms: { type: "array", items: { type: "string" }, description: "Terms for intent-mode output excerpts." },
        maxResponseLines: { type: "integer", description: "Maximum lines in summary mode." },
        persistOutput: { type: "boolean", description: "Persist full redacted output for runtime.queryOutput. Defaults true." },
        outputMode: { type: "string", enum: ["minimal", "summary", "intent"], description: "Response verbosity. Defaults to minimal." },
      },
      required: ["runtime"],
      additionalProperties: false,
    },
  },
  "runtime.queryOutput": {
    type: "function",
    name: "atlas_runtime_query_output",
    description: "Runtime. Query persisted runtime output artifacts by keyword without re-running the command.",
    parameters: {
      type: "object",
      properties: {
        artifactHandle: { type: "string", description: "Artifact handle from runtime.execute." },
        queryTerms: { type: "array", items: { type: "string" }, description: "Keywords to search for." },
        maxExcerpts: { type: "integer", description: "Maximum excerpt windows to return." },
        contextLines: { type: "integer", description: "Context lines around each match." },
        stream: { type: "string", enum: ["stdout", "stderr", "both"], description: "Output stream to search." },
      },
      required: ["artifactHandle", "queryTerms"],
      additionalProperties: false,
    },
  },
  "scip.ingest": {
    type: "function",
    name: "atlas_scip_ingest",
    description: "SCIP. Ingest a prebuilt .scip index into the native ATLAS v2 ledger and rebuild the materialized view.",
    parameters: {
      type: "object",
      properties: {
        indexPath: { type: "string", description: "Path to the .scip index, absolute or relative to repo root." },
        dryRun: { type: "boolean", description: "Decode and summarize without mutating the ledger." },
        force: { type: "boolean", description: "Force reingest even when this fileset was already consumed." },
        branch: { type: "string", description: "Ledger branch to append path deltas to. Defaults to the active branch." },
      },
      required: ["indexPath"],
      additionalProperties: false,
    },
  },
  "file.read": {
    type: "function",
    name: "atlas_file_read",
    description: "Targeted non-indexed file read. Read markdown, configs, templates, JSON/YAML, or data files through ATLAS with line range, search, or JSON path targeting; use card/skeleton/hot-path for indexed source code first.",
    parameters: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "File path relative to the repository root." },
        maxBytes: { type: "integer", description: "Maximum bytes to read." },
        offset: { type: "integer", description: "0-based starting line number." },
        limit: { type: "integer", description: "Maximum lines to return." },
        search: { type: "string", description: "Case-insensitive regex pattern to search for." },
        searchContext: { type: "integer", description: "Context lines around each search match." },
        jsonPath: { type: "string", description: "Dot-separated path to extract from JSON/YAML files." },
      },
      required: ["filePath"],
      additionalProperties: false,
    },
  },
  "file.write": {
    type: "function",
    name: "atlas_file_write",
    description: "Write non-indexed repository files through ATLAS using exactly one write mode.",
    parameters: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "File path relative to the repository root." },
        content: { type: "string", description: "Full file content for create/overwrite mode." },
        replaceLines: {
          type: "object",
          properties: {
            start: { type: "integer", description: "0-based inclusive start line." },
            end: { type: "integer", description: "0-based exclusive end line." },
            content: { type: "string", description: "Replacement content." },
          },
          required: ["start", "end", "content"],
          additionalProperties: false,
        },
        replacePattern: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Regex pattern to find." },
            replacement: { type: "string", description: "Replacement text." },
            global: { type: "boolean", description: "Replace all occurrences." },
          },
          required: ["pattern", "replacement"],
          additionalProperties: false,
        },
        jsonPath: { type: "string", description: "Dot-separated path to update in JSON/YAML." },
        jsonValue: { description: "Value to write when jsonPath is used." },
        insertAt: {
          type: "object",
          properties: {
            line: { type: "integer", description: "0-based line number to insert at." },
            content: { type: "string", description: "Content to insert." },
          },
          required: ["line", "content"],
          additionalProperties: false,
        },
        append: { type: "string", description: "Content to append to the file." },
        createBackup: { type: "boolean", description: "Create a .bak backup before modifying." },
        createIfMissing: { type: "boolean", description: "Create the file if it does not exist." },
      },
      required: ["filePath"],
      additionalProperties: false,
    },
  },
});

export const HIDDEN_ATLAS_SURFACE_ACTIONS = Object.freeze(new Set([
  "agent.feedback",
  "agent.feedback.query",
  "buffer.status",
  "context",
  "info",
  "policy.get",
  "repo.quality",
  "repo.status",
  "memory.surface",
  "runtime.queryOutput",
  "usage.stats",
]));

export function isAtlasActionSurfaced(action) {
  return !HIDDEN_ATLAS_SURFACE_ACTIONS.has(String(action || "").trim());
}

export const ATLAS_TOOL_DEFS = Object.freeze(withNativeAtlasSchemas(ATLAS_TOOL_DEFS_RAW));
export const SURFACED_ATLAS_TOOL_DEFS = Object.freeze(
  Object.fromEntries(Object.entries(ATLAS_TOOL_DEFS).filter(([action]) => isAtlasActionSurfaced(action))),
);

function withNativeAtlasSchemas(defs) {
  const out = {};
  for (const [action, def] of Object.entries(defs)) {
    const generated = atlasDescriptorSchemaForAction(action);
    const parameters = generated
      ? mergeSchemaDescriptions(generated, def.parameters)
      : cloneJson(def.parameters);
    out[action] = {
      ...def,
      parameters: filterFallbackOnlyAtlasSchema(action, parameters),
    };
  }
  return out;
}

function filterFallbackOnlyAtlasSchema(action, parameters) {
  if (["query", "code", "repo", "agent"].includes(action) && Array.isArray(parameters?.properties?.action?.enum)) {
    parameters.properties.action.enum = parameters.properties.action.enum
      .filter((toolName) => {
        const normalized = String(toolName || "").replace(/^atlas[._]/, "").replace(/_/g, ".");
        return normalized !== "file.read" && isAtlasActionSurfaced(normalized);
      });
  }
  return parameters;
}

function mergeSchemaDescriptions(generated, existing) {
  const out = cloneJson(generated);
  mergeDescriptionsInPlace(out, existing || {});
  return out;
}

function mergeDescriptionsInPlace(target, source) {
  if (!target || typeof target !== "object" || !source || typeof source !== "object") return;
  if (!target.description && typeof source.description === "string") target.description = source.description;
  if (!Object.prototype.hasOwnProperty.call(target, "default") && Object.prototype.hasOwnProperty.call(source, "default")) {
    target.default = source.default;
  }
  const targetProps = target.properties && typeof target.properties === "object" ? target.properties : {};
  const sourceProps = source.properties && typeof source.properties === "object" ? source.properties : {};
  for (const [key, child] of Object.entries(targetProps)) {
    mergeDescriptionsInPlace(child, sourceProps[key]);
  }
  if (target.items && source.items) mergeDescriptionsInPlace(target.items, source.items);
  if (
    target.additionalProperties
    && typeof target.additionalProperties === "object"
    && source.additionalProperties
    && typeof source.additionalProperties === "object"
  ) {
    mergeDescriptionsInPlace(target.additionalProperties, source.additionalProperties);
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export const TOOL_EXECUTION_SPECS = Object.freeze({
  read_file: {
    access: "read",
    summary: "Read file contents with line-aware slices.",
    observation: { type: "tool.read", label: "Read", format: "file", pathKeys: ["file_path", "path"], requireTarget: true, includeRange: true },
  },
  chain_read: {
    access: "read",
    summary: "Read one file for researcher review; must be paired with chain_verdict.",
    observation: { type: "tool.chain_read", label: "ChainRead", format: "file", pathKeys: ["path"], requireTarget: true, pair: "chain_read+chain_verdict" },
  },
  chain_verdict: {
    access: "read",
    summary: "Record whether the preceding chain_read was relevant before reading another file.",
    observation: { type: "tool.chain_verdict", label: "ChainReview", format: "chain_verdict", pathKeys: ["path"], pair: "chain_read+chain_verdict" },
  },
  pull_brief: {
    access: "read",
    summary: "Build a bounded deterministic file brief for targeted context retrieval.",
    observation: { type: "tool.pull_brief", label: "PullBrief", format: "generic", targetKeys: ["query", "mode"] },
  },
  list_files: {
    access: "read",
    summary: "List directories and files within the allowed workspace scope.",
    observation: { type: "tool.list", label: "List", format: "list", targetKeys: ["path", "directory", "pattern"] },
  },
  search_files: {
    access: "read",
    summary: "Search file contents deterministically through the required ripgrep-backed search_files tool.",
    observation: { type: "tool.search", label: "Search", format: "search", targetKeys: ["path", "directory", "file_path"] },
  },
  git_history: {
    access: "read",
    summary: "Inspect git log/show/blame/diff history without shell access.",
    observation: { type: "tool.git_history", label: "GitHistory", format: "generic", targetKeys: ["path", "op", "ref"] },
  },
  inspect_file: {
    access: "read",
    summary: "Inspect file metadata and image dimensions; pass `paths: [...]` to batch many files in one call instead of looping.",
    observation: { type: "tool.inspect", label: "Inspect", format: "file", pathKeys: ["file_path", "path"], arrayPathKeys: ["paths"], requireTarget: true },
  },
  hash_file: {
    access: "read",
    summary: "Hash files deterministically for verification and audit.",
    observation: { type: "tool.hash", label: "Hash", format: "file", pathKeys: ["file_path", "path"], requireTarget: true },
  },
  write_file: {
    access: "write",
    summary: "Create or overwrite allowed files.",
    observation: { type: "tool.write", label: "Write", format: "file", pathKeys: ["file_path", "path"], requireTarget: true },
  },
  edit_file: {
    access: "write",
    summary: "Patch existing allowed files without shell editing.",
    observation: { type: "tool.edit", label: "Edit", format: "edit", pathKeys: ["file_path", "path"], requireTarget: true },
  },
  move_file: {
    access: "write",
    summary: "Move or rename files inside the allowed scope.",
    observation: { type: "tool.move", label: "Move", format: "move_copy", sourceKey: "source", destinationKey: "destination" },
  },
  copy_file: {
    access: "write",
    summary: "Copy files inside the allowed scope.",
    observation: { type: "tool.copy", label: "Copy", format: "move_copy", sourceKey: "source", destinationKey: "destination" },
  },
  make_dir: {
    access: "write",
    summary: "Create directories inside the allowed scope.",
    observation: { type: "tool.mkdir", label: "MkDir", format: "file", pathKeys: ["path"], requireTarget: true },
  },
  resize_image: {
    access: "write",
    summary: "Resize PNG images deterministically.",
    observation: { type: "tool.resize_image", label: "Resize image", format: "resize_image", pathKeys: ["path", "file_path"] },
  },
  read_image_metadata: {
    access: "read",
    summary: "Inspect image metadata such as format and dimensions.",
    observation: { type: "tool.read_image_metadata", label: "ImageMeta", format: "file", pathKeys: ["path", "file_path"], requireTarget: true },
  },
  validate_artifact_output: {
    access: "read",
    summary: "Validate artifact output contents and image dimensions.",
    observation: { type: "tool.validate_artifact_output", label: "Validate artifact output", format: "artifact_output", rootKey: "output_root" },
  },
  prune_artifact_output: {
    access: "write",
    summary: "Remove non-deliverable sidecar files from artifact output roots.",
    observation: { type: "tool.prune_artifact_output", label: "Prune artifact output", format: "artifact_output", rootKey: "output_root", includeDryRun: true },
  },
  optimize_image: {
    access: "write",
    summary: "Optimize PNG images by stripping non-essential metadata.",
    observation: { type: "tool.optimize_image", label: "OptimizeImg", format: "file", pathKeys: ["path", "file_path"], requireTarget: true },
  },
  reencode_image: {
    access: "write",
    summary: "Re-encode image files to clean PNGs, including JPEG bytes saved with .png names.",
    observation: { type: "tool.reencode_image", label: "ReencodeImg", format: "reencode_image", pathKeys: ["path", "file_path"] },
  },
  clean_image: {
    access: "write",
    summary: "Inspect, re-encode, resize, or optimize images through one scoped cleanup tool.",
    observation: { type: "tool.clean_image", label: "CleanImage", format: "reencode_image", pathKeys: ["path", "file_path", "output_path"] },
  },
  generate_image: {
    access: "write",
    summary: "Generate new image artifacts inside allowed output scope.",
    observation: { type: "tool.generate_image", label: "Generate image", format: "generate_image", pathKeys: ["path", "file_path", "output_path"] },
  },
  extract_image_text: {
    access: "read",
    summary: "Run local tesseract OCR to extract text from an image.",
    observation: { type: "tool.extract_image_text", label: "ExtractText", format: "file", pathKeys: ["path", "file_path"], requireTarget: true },
  },
  run_scoped_checks: {
    access: "shell",
    summary: "Run lint/typecheck checks for the declared job scope and return compact failure feedback.",
    observation: { type: "tool.run_scoped_checks", label: "ScopedChecks", format: "generic", targetKeys: ["checks", "scope"] },
  },
  create_test_suite: {
    access: "shell",
    summary: "Create or update one DB-backed registered test suite without exposing the suite catalog.",
    observation: { type: "tool.create_test_suite", label: "CreateSuite", format: "generic", targetKeys: ["name", "suite"] },
  },
  create_test: {
    access: "shell",
    summary: "Register or update one test in a suite, rejecting it unless it passes immediately.",
    observation: { type: "tool.create_test", label: "CreateTest", format: "generic", targetKeys: ["suite_id", "suite", "name", "target_files", "target_symbols"] },
  },
  run_test: {
    access: "shell",
    summary: "Run one DB-backed registered test and return compact pass/fail feedback.",
    observation: { type: "tool.run_test", label: "RunTest", format: "generic", targetKeys: ["test_id", "suite_id", "suite", "test"] },
  },
  run_test_suite: {
    access: "shell",
    summary: "Run all active tests in one named/id suite without listing the full catalog.",
    observation: { type: "tool.run_test_suite", label: "RunSuite", format: "generic", targetKeys: ["suite_id", "suite"] },
  },
  bash: {
    access: "shell",
    summary: "Run guarded shell commands only when deterministic tools cannot satisfy the task.",
    observation: { type: "tool.bash", label: "Bash", format: "command", commandKey: "command", kind: "system_call" },
  },
  "query": { access: "atlas", summary: "Compact gateway for native ATLAS v2 retrieval actions." },
  "code": { access: "atlas", summary: "Compact gateway for native ATLAS v2 code-inspection actions." },
  "repo": { access: "atlas", summary: "Compact gateway for native ATLAS v2 repository, policy, usage, and diagnostics actions." },
  "agent": { access: "atlas", summary: "Compact gateway for native ATLAS v2 context, feedback, buffer, and memory actions." },
  "action.search": { access: "atlas", summary: "Search the native ATLAS v2 action catalog for the right tool/action." },
  "manual": { access: "atlas", summary: "Return compact native ATLAS v2 API reference entries." },
  "workflow": { access: "atlas", summary: "Execute multi-step native ATLAS workflows with data transforms and references." },
  "info": { access: "atlas", summary: "Report native ATLAS v2 runtime, storage, view freshness, ledger, and policy diagnostics." },
  "repo.register": { access: "atlas", summary: "Register a repository with ATLAS v2 and initialize ledger/view storage." },
  "repo.status": { access: "atlas", summary: "Get ATLAS repository status, health, and latest version identifiers." },
  "repo.overview": { access: "atlas", summary: "Fetch ATLAS repository summaries, indexed coverage, directory summaries, and hotspots." },
  "index.refresh": { access: "atlas", summary: "Refresh the ATLAS v2 index and materialized view for full or incremental updates." },
  "repo.quality": { access: "atlas", summary: "Inspect ATLAS v2 index quality, parser health, edge resolution, and feedback gaps." },
  "buffer.push": { access: "atlas", summary: "Push an unsaved editor buffer overlay into ATLAS v2 retrieval." },
  "buffer.checkpoint": { access: "atlas", summary: "Clear or persist an ATLAS v2 editor buffer overlay." },
  "buffer.status": { access: "atlas", summary: "Inspect active ATLAS v2 editor buffer overlays." },
  "symbol.search": { access: "atlas", summary: "Search indexed symbols through ATLAS for targeted semantic discovery." },
  "symbol.getCard": { access: "atlas", summary: "Fetch one symbol card (symbolId/symbolRef) or a batch (symbolIds) without loading whole files." },
  "symbol.getCards": { access: "atlas", summary: "Batch fetch symbol cards through ATLAS with partial-success errors." },
  "symbol.usages": { access: "atlas", summary: "List compact call/reference sites for a symbol without full caller cards." },
  "tree.overview": { access: "atlas", summary: "Top-level code-tree orientation: root containment page plus the compressed-tree labeled area map." },
  "tree.walk": { access: "atlas", summary: "Walk a code-tree branch: page a focused path/node/symbol subtree with aggregate counts and area labels." },
  "tree.scope": { access: "atlas", summary: "Prefetch-only task scoping; agents use tree.grow for seed expansion instead." },
  "tree.grow": { access: "atlas", summary: "Grow scope from validated seed files/areas: surrounding branches, siblings, tests, entrypoints, risk metrics." },
  "slice.build": { access: "atlas", summary: "Build a task-scoped ATLAS slice for bounded dependency context." },
  "slice.refresh": { access: "atlas", summary: "Refresh an ATLAS slice incrementally instead of rebuilding from scratch." },
  "edit.plan": { access: "atlas", summary: "Preview symbol/file-scoped edit candidates with preconditions before using write tools." },
  "code.getSkeleton": { access: "atlas", summary: "Inspect signatures/control flow skeleton before escalating to raw code." },
  "code.getHotPath": { access: "atlas", summary: "Inspect identifier-focused code excerpts with tight context windows." },
  "code.needWindow": { access: "atlas", summary: "Request policy-gated raw code windows only when prior rungs are insufficient." },
  "context": { access: "atlas", summary: "Request generated ATLAS context (taskType + contextMode) for precise/broad retrieval." },
  "context.summary": { access: "atlas", summary: "Request compact ATLAS context with an answer, evidence list, and next action guidance." },
  "agent.feedback": { access: "atlas", summary: "Record useful/missing symbols to improve future ATLAS context quality." },
  "agent.feedback.query": { access: "atlas", summary: "Query useful/missing symbol feedback aggregates for retrieval tuning." },
  "delta.get": { access: "atlas", summary: "Fetch ATLAS semantic diff and blast-radius context between versions." },
  "pr.risk.analyze": { access: "atlas", summary: "Run ATLAS PR risk analysis with blast-radius evidence." },
  "pr.risk": { access: "atlas", summary: "Fetch ATLAS semantic diff and risk analysis in one assessor call." },
  "slice.spillover.get": { access: "atlas", summary: "Fetch deferred-edge spillover for an existing slice without rebuilding." },
  "file.read": { access: "atlas", summary: "Bounded file read via ATLAS: offset/limit, search+context, or jsonPath. Honors ETag (ifNoneMatch)." },
  "memory.store": { access: "atlas", summary: "Store or update a native ATLAS v2 development memory linked to symbols/files." },
  "memory.query": { access: "atlas", summary: "Search native ATLAS v2 memories by text, type, tags, linked symbols, or files." },
  "memory.remove": { access: "atlas", summary: "Soft-delete a native ATLAS v2 memory." },
  "policy.get": { access: "atlas", summary: "Fetch native ATLAS v2 policy for the current repository." },
  "policy.set": { access: "atlas", summary: "Patch native ATLAS v2 policy settings." },
  "usage.stats": { access: "atlas", summary: "Report native ATLAS v2 action usage and estimated token savings." },
  "runtime.execute": { access: "atlas", summary: "Execute policy-gated runtime commands inside the repository with output artifacts." },
  "runtime.queryOutput": { access: "atlas", summary: "Query persisted runtime output artifacts by keyword." },
  "scip.ingest": { access: "atlas", summary: "Ingest a prebuilt SCIP index into the native ATLAS v2 ledger." },
  "file.write": { access: "atlas", summary: "Intentionally not exposed in native ATLAS v2. Use scoped write_file/edit_file; those tools push ATLAS live buffers and trigger normal refresh paths." },
});

export const TOOL_ROLE_LIBRARY = Object.freeze({
  baseToolAllowlists: Object.freeze({
    dev: Object.freeze({
      read: [],
      write: ["read_file", "list_files", "search_files", "git_history", "inspect_file", "hash_file", "write_file", "edit_file", "prune_artifact_output", "read_image_metadata", "validate_artifact_output", "clean_image", "extract_image_text", "run_scoped_checks", "create_test_suite", "create_test", "run_test", "run_test_suite", "bash"],
    }),
    artificer: Object.freeze({
      read: [],
      write: ["read_file", "list_files", "search_files", "inspect_file", "write_file", "prune_artifact_output", "read_image_metadata", "validate_artifact_output", "clean_image", "extract_image_text", "bash"],
      imageGeneration: ["generate_image"],
    }),
    assessor: Object.freeze({
      read: ["read_file", "list_files", "search_files", "git_history", "inspect_file", "hash_file", "run_scoped_checks", "create_test_suite", "create_test", "run_test", "run_test_suite", "bash"],
      write: ["read_file", "list_files", "search_files", "git_history", "inspect_file", "hash_file", "run_scoped_checks", "create_test_suite", "create_test", "run_test", "run_test_suite", "bash"],
    }),
    researcher: Object.freeze({
      read: ["chain_read", "chain_verdict", "list_files", "search_files", "git_history", "inspect_file", "hash_file"],
      write: ["chain_read", "chain_verdict", "list_files", "search_files", "git_history", "inspect_file", "hash_file"],
    }),
    planner: Object.freeze({
      read: ["read_file", "list_files", "search_files", "git_history", "inspect_file", "hash_file"],
      write: ["read_file", "list_files", "search_files", "git_history", "inspect_file", "hash_file"],
    }),
    preflight: Object.freeze({ read: [], write: [] }),
    delegator: Object.freeze({ read: [], write: [] }),
    default: Object.freeze({
      read: ["read_file", "list_files", "search_files", "git_history", "inspect_file", "hash_file"],
      write: ["read_file", "list_files", "search_files", "git_history", "inspect_file", "hash_file", "write_file", "edit_file", "bash"],
    }),
  }),
  deterministicMcp: Object.freeze({
    read: Object.freeze(["read_file", "list_files", "search_files", "git_history", "inspect_file", "hash_file"]),
    write: Object.freeze(["write_file", "edit_file", "move_file", "copy_file", "make_dir", "prune_artifact_output"]),
    imageHelpers: Object.freeze(["read_image_metadata", "validate_artifact_output", "clean_image"]),
    imageGeneration: Object.freeze(["generate_image"]),
    ocr: Object.freeze(["extract_image_text"]),
    shellRoles: Object.freeze(["dev", "artificer", "assessor"]),
    writeRoles: Object.freeze(["dev", "artificer"]),
    imageHelperRoles: Object.freeze(["dev", "artificer"]),
    imageGenerationRoles: Object.freeze(["artificer"]),
  }),
  atlasRoutes: Object.freeze({
    researcher: Object.freeze({
      phase: "research",
      tools: Object.freeze([
        "info",
        "repo.status",
        "repo.overview",
        "tree.overview",
        "tree.walk",
        "tree.scope",
        "tree.grow",
        "repo.quality",
        "buffer.status",
        "symbol.search",
        "symbol.getCard",
        "symbol.usages",
        "slice.build",
        "slice.refresh",
        "slice.spillover.get",
        "code.getSkeleton",
        "code.getHotPath",
        "code.needWindow",
        "context",
        "context.summary",
        "agent.feedback",
        "agent.feedback.query",
        "memory.query",
        "policy.get",
        "usage.stats",
      ]),
      rationale: "Use ATLAS-first laddered retrieval for bounded investigation, escalating from cards/slices to focused code views only when needed. Durable findings ride your structured appendix (memories field, max 5/round) and persist automatically — do not call memory.store/memory.remove; the harness also auto-promotes validated findings post-assessment.",
    }),
    planner: Object.freeze({
      phase: "planning",
      tools: Object.freeze([
        "info",
        "repo.status",
        "repo.overview",
        "tree.overview",
        "tree.walk",
        "tree.scope",
        "tree.grow",
        "repo.quality",
        "buffer.status",
        "slice.build",
        "slice.refresh",
        "context",
        "context.summary",
        "symbol.search",
        "symbol.getCard",
        "symbol.usages",
        "code.getSkeleton",
        "code.getHotPath",
        "agent.feedback",
        "agent.feedback.query",
        "memory.query",
        "policy.get",
        "usage.stats",
      ]),
      rationale: "Use ATLAS slices/context to narrow planning scope, then inspect only targeted structure/hot paths for decomposition confidence. Durable planning decisions are promoted to memory automatically by the harness; memory curation is the researcher's role.",
    }),
    assessor: Object.freeze({
      phase: "assessment",
      tools: Object.freeze([
        "info",
        "repo.status",
        "repo.overview",
        "tree.overview",
        "tree.walk",
        "tree.scope",
        "tree.grow",
        "repo.quality",
        "buffer.status",
        "symbol.search",
        "pr.risk",
        "pr.risk.analyze",
        "delta.get",
        "symbol.getCard",
        "symbol.usages",
        "slice.build",
        "slice.refresh",
        "slice.spillover.get",
        "code.getSkeleton",
        "code.getHotPath",
        "code.needWindow",
        "agent.feedback",
        "agent.feedback.query",
        "memory.query",
        "policy.get",
        "runtime.queryOutput",
        "usage.stats",
      ]),
      rationale: "Use ATLAS versions/risk plus focused code evidence for blast-radius analysis; verdict authority remains assessor judgment. Post-verdict findings are promoted to durable memory automatically by the harness; memory curation is the researcher's role.",
    }),
    dev: Object.freeze({
      phase: "dev",
      tools: Object.freeze([
        "info",
        "repo.status",
        "repo.overview",
        "tree.overview",
        "tree.walk",
        "tree.scope",
        "tree.grow",
        "repo.quality",
        "buffer.status",
        "symbol.search",
        "symbol.getCard",
        "symbol.usages",
        "slice.build",
        "slice.refresh",
        "slice.spillover.get",
        "code.getSkeleton",
        "code.getHotPath",
        "code.needWindow",
        "context",
        "context.summary",
        "agent.feedback",
        "agent.feedback.query",
        "memory.query",
        "policy.get",
        "usage.stats",
        "runtime.queryOutput",
      ]),
      rationale: "Developer routing uses ATLAS ladder/context for targeted retrieval; writes go through scoped write_file/edit_file so file scope and worktree isolation stay enforced. Durable bugfix and decision memories are promoted automatically by the harness; memory curation is the researcher's role.",
    }),
    artificer: Object.freeze({
      phase: null,
      tools: Object.freeze([]),
      rationale: "Artificer produces non-code deliverables; ATLAS retrieval is not in scope, deterministic write tools handle artifact output.",
    }),
    delegator: Object.freeze({
      phase: null,
      tools: Object.freeze([]),
      rationale: "Delegator emits routing JSON only; no tool surface required.",
    }),
  }),
});

const ROLE_TOOL_ALLOWLISTS = TOOL_ROLE_LIBRARY.baseToolAllowlists;

export const DETERMINISTIC_READ_TOOLS = TOOL_ROLE_LIBRARY.deterministicMcp.read;
export const DETERMINISTIC_WRITE_TOOLS = TOOL_ROLE_LIBRARY.deterministicMcp.write;
export const DETERMINISTIC_IMAGE_HELPER_TOOLS = TOOL_ROLE_LIBRARY.deterministicMcp.imageHelpers;
export const DETERMINISTIC_IMAGE_TOOLS = TOOL_ROLE_LIBRARY.deterministicMcp.imageGeneration;
export const DETERMINISTIC_OCR_TOOLS = TOOL_ROLE_LIBRARY.deterministicMcp.ocr;

export const WEB_TOOL_ROLES = new Set(["researcher", "artificer"]);
export const GATED_ROLES = new Set(["researcher", "planner", "dev", "assessor"]);

export const MEANINGFUL_ATLAS_ACTIONS = new Set([
  "repo.overview",
  "tree.overview",
  "tree.walk",
  "tree.scope",
  "tree.grow",
  "symbol.search",
  "symbol.getCard",
  "symbol.getCards",
  "symbol.usages",
  "slice.build",
  "slice.refresh",
  "slice.spillover.get",
  "edit.plan",
  "code.getSkeleton",
  "code.getHotPath",
  "code.needWindow",
  "delta.get",
  "pr.risk.analyze",
  "pr.risk",
  "context.summary",
  "memory.query",
]);

export const GATED_NATIVE_TOOLS = new Set([
  "chain_read",
  "chain_verdict",
  "list_files",
  "search_files",
  "git_history",
  "inspect_file",
  "hash_file",
  "read_file",
  "write_file",
  "edit_file",
  "move_file",
  "copy_file",
  "make_dir",
  "bash",
  "read_image_metadata",
  "validate_artifact_output",
  "optimize_image",
  "reencode_image",
  "clean_image",
  "resize_image",
  "prune_artifact_output",
  "extract_image_text",
  "run_scoped_checks",
  "create_test_suite",
  "create_test",
  "run_test",
  "run_test_suite",
]);

export const TOOL_OBSERVATION_ALIASES = Object.freeze({
  bash: "bash",
  read: "read_file",
  write: "write_file",
  edit: "edit_file",
  glob: "list_files",
  grep: "search_files",
  shell: "bash",
  exec_command: "bash",
});

const NATIVE_SCHEMAS = Object.freeze({
  read_file: TOOL_READ_FILE,
  write_file: TOOL_WRITE_FILE,
  edit_file: TOOL_EDIT_FILE,
  list_files: TOOL_LIST_FILES,
  search_files: TOOL_SEARCH_FILES,
  git_history: TOOL_GIT_HISTORY,
  inspect_file: TOOL_INSPECT_FILE,
  hash_file: TOOL_HASH_FILE,
  resize_image: TOOL_RESIZE_IMAGE,
  read_image_metadata: TOOL_READ_IMAGE_METADATA,
  validate_artifact_output: TOOL_VALIDATE_ARTIFACT_OUTPUT,
  prune_artifact_output: TOOL_PRUNE_ARTIFACT_OUTPUT,
  optimize_image: TOOL_OPTIMIZE_IMAGE,
  reencode_image: TOOL_REENCODE_IMAGE,
  clean_image: TOOL_CLEAN_IMAGE,
  extract_image_text: TOOL_EXTRACT_IMAGE_TEXT,
  run_scoped_checks: TOOL_RUN_SCOPED_CHECKS,
  create_test_suite: TOOL_CREATE_TEST_SUITE,
  create_test: TOOL_CREATE_TEST,
  run_test: TOOL_RUN_TEST,
  run_test_suite: TOOL_RUN_TEST_SUITE,
  bash: TOOL_BASH,
  move_file: TOOL_MOVE_FILE,
  copy_file: TOOL_COPY_FILE,
  make_dir: TOOL_MAKE_DIR,
  chain_read: TOOL_CHAIN_READ,
  chain_verdict: TOOL_CHAIN_VERDICT,
  pull_brief: TOOL_PULL_BRIEF,
  generate_image: TOOL_GENERATE_IMAGE,
});

function roleAllowlistForTool(toolName) {
  const roles = [];
  for (const [role, config] of Object.entries(ROLE_TOOL_ALLOWLISTS)) {
    if (role === "default") continue;
    const names = new Set([
      ...(config.read || []),
      ...(config.write || []),
      ...(config.imageGeneration || []),
    ]);
    if (names.has(toolName)) roles.push(role);
  }
  return new Set(roles);
}

function atlasRoleAllowlistForTool(toolName) {
  const roles = [];
  for (const [role, route] of Object.entries(TOOL_ROLE_LIBRARY.atlasRoutes)) {
    if ((route.tools || []).includes(toolName)) roles.push(role);
  }
  return new Set(roles);
}

function capabilityFlagsFor(access) {
  return Object.freeze({
    read: access === "read",
    write: access === "write",
    shell: access === "shell",
    atlas: access === "atlas",
  });
}

export const TOOL_CATALOG = Object.freeze({
  ...Object.fromEntries(Object.entries(NATIVE_SCHEMAS).map(([name, schema]) => {
    const spec = TOOL_EXECUTION_SPECS[name];
    if (!spec) throw new Error(`Missing TOOL_EXECUTION_SPECS entry for native tool ${name}`);
    if (!spec.observation) throw new Error(`Missing observation spec for native tool ${name}`);
    return [name, Object.freeze({
      name,
      schema,
      access: spec.access,
      summary: spec.summary,
      observation: Object.freeze({ ...spec.observation }),
      roleAllowlist: roleAllowlistForTool(name),
      gateTier: GATED_NATIVE_TOOLS.has(name) ? "native-atlas-gated" : "native",
      capabilityFlags: capabilityFlagsFor(spec.access),
    })];
  })),
  ...Object.fromEntries(Object.entries(SURFACED_ATLAS_TOOL_DEFS).map(([name, schema]) => {
    const spec = TOOL_EXECUTION_SPECS[name];
    if (!spec) throw new Error(`Missing TOOL_EXECUTION_SPECS entry for ATLAS tool ${name}`);
    return [name, Object.freeze({
      name,
      schema,
      access: spec.access,
      summary: spec.summary,
      observation: null,
      roleAllowlist: atlasRoleAllowlistForTool(name),
      gateTier: "atlas",
      capabilityFlags: capabilityFlagsFor("atlas"),
    })];
  })),
});

export function getToolCatalogEntry(name) {
  return TOOL_CATALOG[name] || null;
}

export function getToolSchema(name) {
  return TOOL_CATALOG[name]?.schema || null;
}

export function getToolExecutionSpec(name) {
  return TOOL_EXECUTION_SPECS[name] || null;
}

export function getBaseToolNamesForRole(role, allowWrite, { needsImageGeneration = false } = {}) {
  const config = ROLE_TOOL_ALLOWLISTS[role] || ROLE_TOOL_ALLOWLISTS.default;
  const key = allowWrite ? "write" : "read";
  const names = [...(config[key] || [])];
  if (role === "artificer" && allowWrite && needsImageGeneration) {
    names.push(...(config.imageGeneration || []));
  }
  return names;
}

export function roleUsesDeterministicReadMcp(role) {
  return role === "dev"
    || role === "planner"
    || role === "artificer"
    || role === "assessor"
    || role === "researcher";
}

export function roleUsesDeterministicWriteMcp(role) {
  return TOOL_ROLE_LIBRARY.deterministicMcp.writeRoles.includes(role);
}

export function roleUsesDeterministicImageMcp(role) {
  return TOOL_ROLE_LIBRARY.deterministicMcp.imageGenerationRoles.includes(role);
}

export function roleUsesDeterministicImageHelpers(role) {
  return TOOL_ROLE_LIBRARY.deterministicMcp.imageHelperRoles.includes(role);
}

export function getDeterministicMcpToolNames(role, {
  needsImageGeneration = false,
} = {}) {
  if (!roleUsesDeterministicReadMcp(role)) return [];
  const tools = [...DETERMINISTIC_READ_TOOLS];
  if (roleUsesDeterministicWriteMcp(role)) tools.push(...DETERMINISTIC_WRITE_TOOLS);
  if (roleUsesDeterministicImageHelpers(role)) tools.push(...DETERMINISTIC_IMAGE_HELPER_TOOLS);
  if (roleUsesDeterministicImageMcp(role) && needsImageGeneration) tools.push(...DETERMINISTIC_IMAGE_TOOLS);
  if (role === "dev" || role === "artificer") tools.push(...DETERMINISTIC_OCR_TOOLS);
  if (role === "dev" || role === "assessor") tools.push(
    "run_scoped_checks",
    "create_test_suite",
    "create_test",
    "run_test",
    "run_test_suite",
  );
  if (role === "dev" || role === "artificer" || role === "assessor") tools.push("bash");
  if (role === "researcher") {
    const readIdx = tools.indexOf("read_file");
    if (readIdx !== -1) tools.splice(readIdx, 1);
    tools.push("chain_read", "chain_verdict");
  }
  return tools;
}

export function getAtlasToolNames() {
  return Object.keys(SURFACED_ATLAS_TOOL_DEFS);
}

export function getSyntheticAtlasToolSchemas(availableToolNames = []) {
  const available = new Set([...availableToolNames].map((name) => String(name || "")));
  const hasDelta = available.has("atlas.delta.get") || available.has("delta.get");
  const hasRisk = available.has("atlas.pr.risk.analyze") || available.has("pr.risk.analyze");
  const schemas = [];
  if (hasDelta && hasRisk) {
    const def = ATLAS_TOOL_DEFS["pr.risk"];
    schemas.push({
      name: "atlas.pr.risk",
      description: def.description,
      inputSchema: def.parameters,
      annotations: { title: "ATLAS PR Risk" },
    });
  }
  return schemas.map((schema) => ({ ...schema }));
}

export function getAtlasRouteDefinitionForRole(role) {
  const normalizedRole = String(role || "").trim().toLowerCase();
  const route = TOOL_ROLE_LIBRARY.atlasRoutes[normalizedRole] || Object.freeze({
    phase: null,
    tools: Object.freeze([]),
    rationale: "No ATLAS route is defined for this role.",
  });
  return {
    phase: route.phase,
    // Advertised to (and gate-callable by) the agent: prefetch-only actions
    // are excluded here on purpose.
    tools: [...route.tools].filter(isExternallyRoutedAtlasTool),
    // Routed for the role at all — what the handoff prefetch may execute on
    // the agent's behalf. Prefetch-only actions (tree.scope) stay in THIS
    // list; only mutating and fallback-only actions are stripped.
    internalTools: [...route.tools].filter((tool) => !isBlockedFoldedAtlasTool(tool) && !isFallbackOnlyAtlasTool(tool)),
    rationale: route.rationale,
  };
}

function atlasProviderForContract(opts = {}) {
  return String(opts?.atlasAttachment?.provider || opts?.providerName || "").trim().toLowerCase();
}

function atlasTransportForContract(opts = {}) {
  return String(opts?.atlasAttachment?.transport || "").trim().toLowerCase();
}

function hasRuntimeAtlasNaming(opts = {}) {
  return !!(atlasProviderForContract(opts) || atlasTransportForContract(opts));
}

function atlasGateEnabledForContract(opts = {}) {
  if (opts?.atlasGateEnabled != null) return !!opts.atlasGateEnabled;
  if (opts?.atlasAttachment?.gateEnabled != null) return !!opts.atlasAttachment.gateEnabled;
  return resolveAtlasToolGateEnabled();
}

function renderIndexableExtensionList() {
  return [...ATLAS_INDEXABLE_SOURCE_EXTENSIONS].sort().join(", ");
}

function snakeAtlasToolName(tool) {
  return `atlas_${String(tool || "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`;
}

function renderAtlasToolNameForContract(tool, opts = {}) {
  const raw = String(tool || "").trim();
  if (!raw) return raw;
  const surfaceToolNames = opts?.atlasAttachment?.surfaceToolNames;
  if (surfaceToolNames && typeof surfaceToolNames === "object") {
    const mapped = surfaceToolNames[raw] || surfaceToolNames[stripAtlasPrefix(raw)];
    if (mapped) return mapped;
  }
  if (raw.startsWith("atlas.") || raw.startsWith("atlas_")) return raw;
  if (!hasRuntimeAtlasNaming(opts)) return `atlas.${raw}`;

  const provider = atlasProviderForContract(opts);
  const transport = atlasTransportForContract(opts);
  if (transport === "embedded" || ["openai", "grok"].includes(provider)) {
    return ATLAS_TOOL_DEFS[raw]?.name || snakeAtlasToolName(raw);
  }
  return `atlas.${raw}`;
}

function normalizeAtlasActionName(tool) {
  const raw = String(tool || "").trim();
  if (!raw) return "";
  if (ATLAS_TOOL_DEFS[raw]) return raw;
  const stripped = stripAtlasPrefix(raw);
  if (ATLAS_TOOL_DEFS[stripped]) return stripped;
  for (const [action, def] of Object.entries(ATLAS_TOOL_DEFS)) {
    if (def?.name === raw) return action;
  }
  return stripped;
}

function normalizedAtlasActionSet(tools = []) {
  return new Set((Array.isArray(tools) ? tools : [])
    .map((tool) => normalizeAtlasActionName(tool))
    .filter(Boolean));
}

function atlasContractToolsForRoute(route, opts = {}) {
  const routeTools = (Array.isArray(route?.tools) ? [...route.tools] : [])
    .filter(isExternallyRoutedAtlasTool);
  const attached = normalizedAtlasActionSet(opts?.atlasAttachment?.tools);
  if (attached.size === 0) return routeTools;
  return routeTools.filter((tool) => attached.has(stripAtlasPrefix(tool)));
}

function renderProviderNamingLine(opts = {}) {
  if (!hasRuntimeAtlasNaming(opts)) return null;
  const label = atlasBackendLabel(opts?.atlasAttachment);
  const provider = atlasProviderForContract(opts);
  const mode = _toolAttachmentModeFor(provider);
  const providerLabel = _providerLabelFor(provider);
  const transport = String(opts?.atlasAttachment?.transport || "").trim().toLowerCase();
  if (mode === "function") {
    return `${providerLabel} exposes ${label} as function tools; call the exact function names listed in this contract.`;
  }
  if (transport === POSSE_MCP_GATEWAY_TRANSPORT || transport === "posse-gateway" || transport === "deterministic-mcp") {
    return `${providerLabel} exposes ${label} through the Posse MCP gateway as a separate atlas.* tool suite; call the exact tool names listed in this contract.`;
  }
  if (mode === "deterministic-bridge") {
    return `${providerLabel} exposes ${label} through the Posse MCP gateway; call the exact tool names listed in this contract.`;
  }
  if (mode === "mcp") {
    return `${providerLabel} exposes ${label} through MCP; call the exact MCP tool names listed in this contract.`;
  }
  return `Call the exact ${label} tool names listed in this contract for this provider.`;
}

function renderActiveAtlasFallbackLines(opts = {}) {
  // The ATLAS contract is only rendered when ATLAS is attached and advertised
  // for the active tool surface. The contract's presence already asserts
  // ATLAS-is-primary, so we don't restate it here.
  // The "Use standard tools only when:" list below implicitly establishes
  // ATLAS as the default by enumerating the conditions for falling back.
  const label = atlasBackendLabel(opts?.atlasAttachment);
  if (atlasGateEnabledForContract(opts)) {
    const extensions = renderIndexableExtensionList();
    return [
      `For indexable source files (${extensions}), native read_file/chain_read fallback unlocks file by file: before reading a given source file, attempt task-relevant ${label} discovery against that same file or a symbol/slice/summary result that returns that file.`,
      `Good file-specific discovery calls include ${renderAtlasToolNameForContract("code.getSkeleton", opts)}, ${renderAtlasToolNameForContract("code.getHotPath", opts)}, ${renderAtlasToolNameForContract("code.needWindow", opts)}, ${renderAtlasToolNameForContract("symbol.search", opts)}, ${renderAtlasToolNameForContract("slice.build", opts)}, and ${renderAtlasToolNameForContract("context.summary", opts)}.`,
      `Other indexable source files stay locked until separately discovered through ${label}.`,
      `For broad standard list/search/read fallback not tied to one source file, make the required real ${label} retrieval attempts only when broad native fallback is still needed; keep them targeted to the task and stop when the needed context or fallback unlock is obtained.`,
      `For broad audits, sweeps, or unfamiliar repositories, start with ${renderAtlasToolNameForContract("repo.overview", opts)} or ${renderAtlasToolNameForContract("context.summary", opts)} in broad mode, then narrow with ${renderAtlasToolNameForContract("symbol.search", opts)} and ${renderAtlasToolNameForContract("slice.build", opts)}.`,
      `${label} prefetch and internal bookkeeping calls do not count toward file unlocks or broad fallback unlocks.`,
      "Use standard tools only when:",
      `- ${label} is unavailable,`,
      `- ${label} fails to answer the question after the required targeted discovery attempts,`,
      "- you have mutated files and need exact current worktree state,",
      `- you need git state/history/diff operations not exposed through ${label},`,
      "- you need to run tests, build commands, or other shell commands.",
      `If you fall back to standard tools, state what ${label} could not provide.`,
    ];
  }
  const extensions = renderIndexableExtensionList();
  return [
    `For indexable source files (${extensions}), attempt task-relevant ${label} discovery against the file before native read_file/chain_read fallback whenever possible.`,
    `For broad audits, sweeps, or unfamiliar repositories, start with ${renderAtlasToolNameForContract("repo.overview", opts)} or ${renderAtlasToolNameForContract("context.summary", opts)} in broad mode, then narrow with ${renderAtlasToolNameForContract("symbol.search", opts)} and ${renderAtlasToolNameForContract("slice.build", opts)}.`,
    "Use standard tools only when:",
    `- ${label} is unavailable,`,
    `- ${label} fails to answer the question after a relevant attempt,`,
    "- you have mutated files and need exact current worktree state,",
    `- you need git state/history/diff operations not exposed through ${label},`,
    "- you need to run tests, build commands, or other shell commands.",
    `If you fall back to standard tools, state what ${label} could not provide.`,
  ];
}

function renderPrefetchGuidance(opts = {}) {
  const status = String(opts?.atlasPrefetchStatus || opts?.atlasAttachment?.prefetchStatus || "").trim().toLowerCase();
  const label = atlasBackendLabel(opts?.atlasAttachment);
  if (status === "ok" || status === "ok_relevant" || status === "prefetch_ok_relevant") {
    return [
      `${label} prefetch supplied task-relevant context for this handoff.`,
      atlasGateEnabledForContract(opts)
        ? `Use prefetch as a comprehension scaffold for the first codebase map; it does not count as active ${label} use or toward the 3-call native fallback gate.`
        : `Use prefetch as a comprehension scaffold for the first codebase map; make additional task-relevant ${label} retrieval only when a specific context gap remains.`,
      ...renderActiveAtlasFallbackLines(opts),
    ];
  }
  if (status === "ok_unhelpful" || status === "prefetch_ok_unhelpful") {
    return [
      `${label} prefetch completed but did not match the requested scope.`,
      ...renderActiveAtlasFallbackLines(opts),
    ];
  }
  if (status && status !== "skipped") {
    return [
      `${label} prefetch status is ${status}. Follow the ${label} CONTEXT fallback notice if one is present.`,
      `If ${label} tools are still advertised, prefer ${label} retrieval before broad native reads.`,
    ];
  }
  return [
    ...renderActiveAtlasFallbackLines(opts),
  ];
}

function pushAvailableToolLine(lines, tools, tool, label, opts = {}) {
  if (!tools.includes(tool)) return;
  lines.push(`- ${renderAtlasToolNameForContract(tool, opts)}: ${label}`);
}

function renderRouteUsageLines(role, tools, opts = {}) {
  const label = atlasBackendLabel(opts?.atlasAttachment);
  const lines = [
    `How to use this ${label} route:`,
  ];

  const providerLine = renderProviderNamingLine(opts);
  if (providerLine) lines.push(providerLine);
  lines.push(...renderPrefetchGuidance(opts));
  lines.push(`${label} should build code-content understanding, not just file discovery: use results to explain what the code does, how data flows, and which exact files need verification; if a result only gives names or signatures, move to the next targeted rung or use the fallback policy.`);
  if (tools.some((tool) => ["query", "code", "repo", "agent", "workflow"].includes(tool))) {
    lines.push(`${label} gateway/workflow tools may take nested action names; nested actions must also appear in this role route. Do not use a wrapper to bypass routing.`);
  }
  lines.push(`${label} symbolId values are opaque. Never invent them from file paths, names, or file:symbol pairs; use IDs returned by ATLAS results, or symbolRef/file inputs where the tool explicitly supports them.`);

  const discovery = [];
  pushAvailableToolLine(discovery, tools, "repo.overview", "best first call for broad audits, bugsweeps, unfamiliar repositories, hotspots, and indexed coverage before narrowing.", opts);
  pushAvailableToolLine(discovery, tools, "symbol.search", "best first call when you know a concept or name but not the exact symbol ID.", opts);
  pushAvailableToolLine(discovery, tools, "slice.build", "best first call for a bounded graph slice around a task or entry symbols.", opts);
  pushAvailableToolLine(discovery, tools, "context.summary", "best first call for compact task-shaped evidence and next-action guidance.", opts);
  if (discovery.length) {
    lines.push("", "Discovery starters:");
    lines.push(...discovery);
  }

  // The route's tool list above already labels each ladder tool with its
  // rung and token cost. Define the ladder once here (the rung tools may
  // not all be in this role's route, but the definition stays canonical)
  // and follow with the role-specific escalation constraint. The Rung 3
  // stop line goes here — directly after the definition — so a planner
  // reading the contract learns the constraint before scanning for Rung 4.
  const LADDER_TOOLS = ["symbol.getCard", "code.getSkeleton", "code.getHotPath", "code.needWindow"];
  const hasLadder = LADDER_TOOLS.some((tool) => tools.includes(tool));
  if (hasLadder) {
    lines.push(
      "",
      `Iris rungs are the ${label} evidence ladder, ordered by cost: Rung 1 (~100 token cards) -> Rung 2 (~300 token skeletons) -> Rung 3 (~600 token hot paths) -> Rung 4 (~2000 token raw windows). Escalate only as far as needed — prefer the cheapest rung that answers the question.`,
    );
    if (role === "planner" && !tools.includes("code.needWindow")) {
      lines.push("Planner routes stop at Rung 3 by design. If raw bodies are still required, name the exact missing symbols or files instead of making a raw-window call.");
    }
  }

  if (tools.includes("pr.risk")) {
    const riskName = renderAtlasToolNameForContract("pr.risk", opts);
    lines.push(
      "",
      "Assessor review path:",
      `- Use ${riskName} when version IDs are available for semantic delta, blast radius, risks, and tests.`,
      "- Use cards, skeletons, hot paths, or raw windows only to verify specific findings from the risk output.",
    );
  }

  return lines;
}

export function renderAtlasRoleContract(role, opts = {}) {
  const normalizedRole = String(role || "").trim().toLowerCase();
  const route = getAtlasRouteDefinitionForRole(normalizedRole);
  const routeTools = atlasContractToolsForRoute(route, opts);
  const title = normalizedRole ? normalizedRole.toUpperCase() : "ROLE";
  const gateEnabled = atlasGateEnabledForContract(opts);
  const label = atlasBackendLabel(opts?.atlasAttachment);
  const lines = [
    "===========================================================",
    `${label} TOOLS CONTRACT - ${title}`,
    "===========================================================",
    "",
  ];

  if (!routeTools.length) {
    lines.push(
      `No ${label} tools are routed to this role. Use the deterministic tools granted by the execution contract.`,
      "",
      formatAtlasBackendText(route.rationale, label),
    );
    return lines.join("\n");
  }

  lines.push(
    "This contract is generated from TOOL_ROLE_LIBRARY.atlasRoutes in the shared tool catalog.",
    hasRuntimeAtlasNaming(opts)
      ? "Tool names in this runtime contract are rendered for the active provider/transport; call them exactly as listed."
      : "Checked-in generated contracts use canonical MCP tool names; embedded function-tool providers render exact function names at runtime.",
    "",
    `Route phase: ${route.phase || "none"}`,
    `Route rationale: ${formatAtlasBackendText(route.rationale, label)}`,
    "",
    `Generated ${label} route:`,
  );
  for (const tool of routeTools) {
    const summary = ATLAS_TOOL_DEFS[tool]?.description || TOOL_EXECUTION_SPECS[tool]?.summary || "ATLAS tool.";
    lines.push(`- ${renderAtlasToolNameForContract(tool, opts)}: ${formatAtlasBackendText(summary, label)}`);
  }

  // The contract's presence already asserts "ATLAS is the primary path"
  // (it's only loaded when the role's ATLAS attachment is active). The
  // cost ordering and escalation rule are already in the Iris rungs
  // definition emitted by renderRouteUsageLines. The closing block only
  // needs the cross-tool fallback policy and the anti-fabrication rule.
  lines.push(
    "",
    ...renderRouteUsageLines(normalizedRole, routeTools, opts),
    "",
    gateEnabled
      ? `Use deterministic file/search/read tools only after the required targeted ${label} discovery or 3-call native fallback gate unlock, when ${label} is unavailable or insufficient, or when you have mutated files and need exact current worktree state.`
      : `Use deterministic file/search/read tools when ${label} is unavailable or insufficient, or when you have mutated files and need exact current worktree state.`,
    `Use deterministic git/test/build/shell tools when those operations are not exposed through ${label}.`,
    "Do not invent missing repo content.",
  );

  return `${lines.join("\n")}\n`;
}

const ATLAS_MUTATING_ACTIONS = new Set([
  "buffer.push",
  "buffer.checkpoint",
  "file.write",
  "index.refresh",
  "memory.remove",
  // memory.store is intentionally NOT here: curating a development memory is not a
  // repo mutation (Posse `write` = repo write). It is surfaced per-route via the
  // route tool-lists (researcher only) rather than blocked as a mutating action.
  "policy.set",
  "repo.register",
  "runtime.execute",
  "scip.ingest",
  "workflow",
]);

const ATLAS_FALLBACK_ONLY_ACTIONS = new Set([
  "file.read",
]);

// Actions the handoff prefetch runs on the agent's behalf with better input
// (full task text) than the agent could reconstruct — kept in role routes so
// the prefetch can use them, but never advertised to the agent. Agents get
// tree.grow (seed expansion) instead.
const ATLAS_PREFETCH_ONLY_ACTIONS = new Set([
  "tree.scope",
]);

export function isPrefetchOnlyAtlasTool(name) {
  return ATLAS_PREFETCH_ONLY_ACTIONS.has(stripAtlasPrefix(name));
}

function stripAtlasPrefix(name) {
  const raw = String(name || "");
  if (raw.startsWith("atlas.")) return raw.slice("atlas.".length);
  if (raw.startsWith("atlas_")) return raw.slice("atlas_".length).replace(/_/g, ".");
  return raw;
}

export function isBlockedFoldedAtlasTool(name) {
  return ATLAS_MUTATING_ACTIONS.has(stripAtlasPrefix(name));
}

export function isFallbackOnlyAtlasTool(name) {
  return ATLAS_FALLBACK_ONLY_ACTIONS.has(stripAtlasPrefix(name));
}

export function isExternallyRoutedAtlasTool(name) {
  const action = stripAtlasPrefix(name);
  // Route allowlist membership keeps hidden-surface read actions (info,
  // policy.get, usage.stats, etc.). Those actions are routed/allowed for the
  // role even though they are not advertised as standalone enum values; only
  // mutating and fallback-only actions are stripped from the role route.
  return !isBlockedFoldedAtlasTool(action)
    && !isFallbackOnlyAtlasTool(action)
    && !ATLAS_PREFETCH_ONLY_ACTIONS.has(action);
}

export function buildNativeToolDescriptor(schema) {
  return {
    name: schema.name,
    description: schema.description,
    inputSchema: schema.parameters || { type: "object", properties: {}, additionalProperties: false },
    annotations: {
      title: schema.name,
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  };
}

export function buildFoldedAtlasToolDescriptor(schema = {}) {
  const annotations = schema.annotations && typeof schema.annotations === "object"
    ? schema.annotations
    : {};
  const name = String(schema.name || "");
  const mutating = isBlockedFoldedAtlasTool(name);
  const canonicalDescription = ATLAS_TOOL_DEFS[stripAtlasPrefix(name)]?.description;
  return {
    ...schema,
    description: canonicalDescription || schema.description,
    annotations: {
      ...annotations,
      title: annotations.title || name,
      readOnlyHint: !mutating,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  };
}
