// ESLint v9 flat config.
//
// Lints the TypeScript sources with type-aware rules, and the plain-JS browser frontend with a
// browser global set. Build artifacts, deps, and vendored assets are ignored.

import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Ignore generated / vendored paths.
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", "docs/**", "**/*.d.ts"],
  },

  // Base JS recommended rules.
  js.configs.recommended,

  // Type-checked rules for the TypeScript sources.
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": "off",
    },
  },

  // Browser frontend (vanilla ES modules served from src/portal/public).
  {
    files: ["src/portal/public/**/*.js"],
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      "no-undef": "off",
    },
  },

  // Node tooling scripts (.mjs).
  {
    files: ["scripts/**/*.mjs", "*.js", "*.mjs"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
);
