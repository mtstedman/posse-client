// @ts-check



export const TOOL_GIT_HISTORY = {
  type: "function",
  name: "git_history",
  description:
    "Inspect git history deterministically (log, show, blame, diff) " +
    "without shell access. show accepts a commit revision and reports commit changes; it does not return file contents. " +
    "Revision:path selectors (for example HEAD:src/app.js) are unsupported. Use path to filter history/diffs, " +
    "and the issued read_file/chain_read tool or code.window for current source. Historical file blobs are not exposed by this tool.",
  parameters: {
    type: "object",
    properties: {
      op: {
        type: "string",
        enum: ["log", "show", "blame", "diff"],
        description: "Git history operation to run.",
      },
      path: { type: "string", minLength: 1, description: "Optional history/diff path filter, not a file-content request. Required for blame." },
      ref: { type: "string", description: "Optional commit ref/revision selector (e.g. HEAD~5); revision:path and blob objects are unsupported. For diff, two safe refs separated by whitespace are normalized to A..B." },
      limit: { type: "integer", description: "log-only result cap. Default: 20, max: 100." },
      since: { type: "string", description: "log-only --since value (e.g. 2025-01-01)." },
      author: { type: "string", description: "log-only --author filter." },
      grep: { type: "string", description: "log-only --grep commit-message filter." },
    },
    required: ["op"],
    allOf: [{
      if: {
        properties: { op: { const: "blame" } },
        required: ["op"],
      },
      then: { required: ["path"] },
    }],
    additionalProperties: false,
  },
};
