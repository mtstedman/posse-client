// @ts-check



export const TOOL_INSPECT_FILE = {
  type: "function",
  name: "inspect_file",
  description:
    "Structured metadata for one file path or an array of paths, including existence, size, " +
    "extension, timestamps, and basic PNG, JPEG, or WebP dimensions. A string returns one flat " +
    "result; an array returns ordered results with input indexes and loc fields. Invalid or blocked paths fail individually; valid siblings still return metadata.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: ["string", "array"],
        description: "One file path or an array of file paths, absolute or relative to the working directory.",
        minLength: 1,
        minItems: 1,
        items: { type: "string", minLength: 1 },
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
};
