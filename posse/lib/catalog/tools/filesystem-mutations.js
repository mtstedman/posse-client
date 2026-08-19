// Canonical deterministic filesystem mutation schemas.
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
