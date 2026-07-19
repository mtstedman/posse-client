// Native deterministic-MCP tool schema definitions (pure data).
//
// Canonical JSON Schemas for the in-tree deterministic tools. Per the catalog
// contract this file holds pure data only: no imports, no logic. The assembled
// catalog, role allowlists, and contract rendering that consume these schemas
// live in
// lib/domains/integrations/functions/deterministic-mcp/tool-descriptors.js.

export const TOOL_READ_FILE = {
  type: "function",
  name: "read_file",
  description:
    "Read the contents of a file. Returns numbered lines for precise references. " +
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

// Internal-only coordination primitive. It is deliberately present in the
// canonical catalog so every runtime can execute the same operation, but its
// tool-suite declaration advertises it on no transport. Out-of-scope mutation
// handlers invoke it themselves; agents do not spend a second tool call asking
// for the scope they just demonstrated they need.
export const TOOL_REQUEST_SCOPE = {
  type: "function",
  name: "request_scope",
  description:
    "Pause the current job and request human approval for one exact file path outside its writable scope.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Exact repository-relative file path that needs writable scope.",
      },
      access: {
        type: "string",
        enum: ["modify", "create"],
        description: "Whether the job needs permission to modify an existing file or create a new file.",
      },
      operation: {
        type: "string",
        enum: ["write_file", "edit_file"],
        description: "Mutation that encountered the scope boundary.",
      },
      reason: {
        type: "string",
        description: "Short explanation of why this path is required for the current task.",
      },
    },
    required: ["path", "access", "operation"],
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

export const TOOL_AGENT_FEEDBACK = {
  type: "function",
  name: "agent_feedback",
  description:
    "Live status-update tool for the Monitor Agents channel. " +
    "Send a short operator-facing update on visible state: current phase, decision or strategy change, blocker, verification transition, or finalization status. " +
    "Do not include hidden reasoning or private chain-of-thought.",
  parameters: {
    type: "object",
    properties: {
      phase: {
        type: "string",
        enum: ["reading", "planning", "editing", "testing", "verifying", "blocked", "finalizing", "handoff"],
        description: "Current operational phase.",
      },
      status: {
        type: "string",
        enum: ["running", "blocked", "waiting", "verifying", "done"],
        description: "Current visible status.",
      },
      summary: {
        type: "string",
        description: "One short operator-facing update, no hidden reasoning. Keep under 240 characters.",
      },
    },
    required: ["phase", "summary"],
    additionalProperties: false,
  },
};

export const TOOL_GET_OPERATOR_FEEDBACK = {
  type: "function",
  name: "get_operator_feedback",
  description:
    "Retrieve pending live operator feedback for the current job at startup or after a tool result signals operator_feedback_available. " +
    "This is the only channel that delivers operator nudge text; do not expect nudge text in the assembled prompt. " +
    "Every returned item must be acknowledged with ack_operator_feedback before normal task work continues.",
  parameters: {
    type: "object",
    properties: {
      limit: {
        type: "integer",
        description: "Maximum feedback items to retrieve. Default: 20.",
      },
    },
    required: [],
    additionalProperties: false,
  },
};

export const TOOL_ACK_OPERATOR_FEEDBACK = {
  type: "function",
  name: "ack_operator_feedback",
  description:
    "Acknowledge one retrieved operator feedback item. " +
    "The default decision is accepted, so the usual case only needs interaction_id. " +
    "Use rejected or deferred only when you cannot apply the feedback now; those decisions require a short reason.",
  parameters: {
    type: "object",
    properties: {
      interaction_id: {
        type: "integer",
        description: "The id returned by get_operator_feedback.",
      },
      decision: {
        type: "string",
        enum: ["accepted", "rejected", "deferred"],
        description: "Acknowledgement decision. Defaults to accepted.",
      },
      reason: {
        type: "string",
        description: "Required for rejected or deferred; optional for accepted.",
      },
    },
    required: ["interaction_id"],
    additionalProperties: false,
  },
};

export const TOOL_BASH = {
  type: "function",
  name: "bash",
  description:
    "Execute a read-only inspection command or test/build runner and return stdout+stderr. " +
    "On Windows this runs through PowerShell when shell features are needed; prefer repo-native test commands and PowerShell-compatible syntax over Unix-only filters. " +
    "Do not use this for lint/typecheck when run_scoped_checks can cover the declared scope. " +
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
    "Run the canonical deterministic lint/typecheck checks for the declared job scope in one batch, including scoped PHP syntax lint when PHP files are present. " +
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
    "Register or update one or many tests inside an existing suite. For a batch, provide shared suite_id/suite plus tests (max 24); each result is reported independently. " +
    "Every candidate is executed before it can be inserted or updated and must return/resolve exactly true. A failing candidate is never added, and a failing update never replaces the last passing definition. " +
    "Declare the production files/functions each test covers so Posse can scope future runs. " +
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
      tests: {
        type: "array",
        minItems: 1,
        maxItems: 24,
        description:
          "Batch form (max 24). Each candidate is run before registration; failed candidates remain unregistered while valid candidates continue. Uses the outer suite_id/suite and optional timeout_ms by default.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Human-readable test name." },
            slug: { type: "string", description: "Optional stable test slug. Defaults from name." },
            explanation: { type: "string", description: "What this test checks and why it belongs in the suite." },
            language: { type: "string", enum: ["javascript", "python"], description: "Runtime language for the test function." },
            function_name: { type: "string", description: "Optional test function/export name." },
            target_files: {
              type: "array",
              items: { type: "string" },
              description: "Workspace-relative production file paths covered by this test.",
            },
            target_symbols: {
              type: "array",
              items: { type: "string" },
              description: "Optional production functions/classes/symbols covered by this test.",
            },
            target_imports: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  path: { type: "string", description: "Workspace-relative file to import." },
                  symbols: { type: "array", items: { type: "string" } },
                  default: { type: "string" },
                  namespace: { type: "string" },
                },
                required: ["path"],
                additionalProperties: false,
              },
            },
            test: { type: "string", description: "Test source. It must return/resolve exactly true to be registered." },
            timeout_ms: { type: "integer", description: "Optional per-test timeout override in milliseconds." },
          },
          required: ["name", "explanation", "language", "target_files", "test"],
          additionalProperties: false,
        },
      },
    },
    required: [],
    additionalProperties: false,
  },
};

export const TOOL_RUN_TEST = {
  type: "function",
  name: "run_test",
  description:
    "Run one or many registered Posse tests. Select one by id or by suite plus test name/slug; for a batch, provide tests (max 24). " +
    "Returns per-test suite/name identity, pass/fail, and compact failure feedback without stopping the batch after one failure.",
  parameters: {
    type: "object",
    properties: {
      test_id: { type: "integer", description: "Registered test id." },
      suite_id: { type: "integer", description: "Suite id when selecting by test name." },
      suite: { type: "string", description: "Suite name or slug when selecting by test name." },
      test: { type: "string", description: "Test name or slug when test_id is omitted." },
      timeout_ms: { type: "integer", description: "Per-test timeout in milliseconds. Default: 30000, max: 120000." },
      tests: {
        type: "array",
        minItems: 1,
        maxItems: 24,
        description:
          "Batch form (max 24). Each item selects a test by test_id or by test name/slug using the outer suite_id/suite. Results preserve input order.",
        items: {
          type: "object",
          properties: {
            test_id: { type: "integer", description: "Registered test id." },
            test: { type: "string", description: "Test name or slug when test_id is omitted." },
            timeout_ms: { type: "integer", description: "Optional per-test timeout override in milliseconds." },
          },
          required: [],
          additionalProperties: false,
        },
      },
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
    "If a previously relevant file is restored from the audit ledger, its verdict carries over and no new verdict is needed. " +
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
        description: "What you found. Required for irrelevant verdicts so later pruning preserves why the file was excluded.",
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

export const TOOL_GET_BRIEF = {
  type: "function",
  name: "get_brief",
  description:
    "Load the research brief already prepared for this work item in one call: the researcher's full analysis, " +
    "structured data (key files, patterns, constraints), the ranked file-priority list, the function/class index, " +
    "plus a manifest of staged source files. Call this once at the start of planning instead of reading the " +
    "staged context files one by one. Note: this returns PRE-STAGED handoff context; it does not scan the " +
    "repository the way pull_brief does.",
  parameters: {
    type: "object",
    properties: {},
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

export const TOOL_PROJECT_DB_QUERY = {
  type: "function",
  name: "project_db_query",
  description:
    "Run a single SQL statement against this project's configured application database " +
    "(sqlite/postgres/mysql). Opt-in and operator-configured per repository: the statement " +
    "types you may run depend on the granted permissions (READ→SELECT, WRITE→UPDATE, " +
    "INSERT, DELETE, CREATE, ALTER) plus read-only inspection (PRAGMA/EXPLAIN/SHOW/DESCRIBE). " +
    "Read-phase roles are capped to SELECT/inspection regardless of the grant. Anything outside " +
    "the grant is rejected, and destructive DDL (DROP/TRUNCATE) is never allowed. One statement " +
    "per call; read results are row- and byte-capped.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "A single SQL statement to execute.",
      },
      maxRows: {
        type: "integer",
        description: "Maximum rows to return for read queries. Default: 200, max: 1000.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
};
