import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      ".posse/**",
      ".posse-worktrees/**",
      "coverage/**",
      "dist/**",
      "node_modules/**",
    ],
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: "off",
    },
  },
  {
    files: ["**/*.{js,mjs}"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-empty": "off",
      "no-extra-boolean-cast": "off",
      "no-unused-vars": "off",
      "no-useless-escape": "off",
      "no-useless-assignment": "off",
      "no-useless-catch": "off",
      "no-control-regex": "off",
      "no-constant-condition": "off",
      "no-constant-binary-expression": "off",
      "no-regex-spaces": "off",
      "preserve-caught-error": "off",
    },
  },
];
