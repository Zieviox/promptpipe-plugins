"use strict";
// The linter the coding guide names (design/7-review.md Part 1, JavaScript): ESLint's recommended
// rules, with the naming rule set to snake_case, plus the guide's "strict mode" and "`const` by
// default". The naming rule is ESLint's own `id-match` on declarations only: functions and fields
// snake_case, records Ada_Case, constants UPPER_SNAKE (W3); a library's own names (DOM, Preact,
// Node) are used, not declared, so they pass.
const js = require("@eslint/js");
const globals = require("globals");

const NAME =
  "^(_?[a-z][a-z0-9]*(_[a-z0-9]+)*|[A-Z][a-z0-9]*(_[A-Z][a-z0-9]*)*|[A-Z][A-Z0-9]*(_[A-Z0-9]+)*|_)$";

module.exports = [
  { ignores: ["**/vendor/**", "node_modules/**"] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "script",
      globals: { ...globals.browser, PP: "readonly" },
    },
    rules: {
      "id-match": ["error", NAME, { properties: false, onlyDeclarations: true }],
      "prefer-const": "error",
      "no-var": "error",
      strict: ["error", "global"],
    },
  },
  {
    // content scripts: the page script runs each one as a function's body (it may return early)
    files: ["runtime-site/routine.js", "deepseek/site.js", "qwen-chat/site.js"],
    languageOptions: {
      parserOptions: { ecmaFeatures: { globalReturn: true } },
      globals: { provider: "readonly" },
    },
  },
  {
    // the page side's adapter for Turndown (HTML to Markdown, markdown_get)
    files: ["runtime-site/routine.js"],
    languageOptions: { globals: { TurndownService: "readonly", turndownPluginGfm: "readonly" } },
  },
  {
    // the screen's adapter: the libraries it wraps (vendor/), and only here
    files: ["runtime-screen/view.js"],
    languageOptions: {
      globals: {
        preact: "readonly",
        htm: "readonly",
        markdownit: "readonly",
        Sortable: "readonly",
      },
    },
  },
  {
    files: ["test/**", "scripts/**", "eslint.config.js"],
    languageOptions: { globals: { ...globals.node } },
  },
];
