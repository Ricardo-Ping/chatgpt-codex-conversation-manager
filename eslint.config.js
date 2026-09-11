import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "**/release/**", "**/coverage/**", "**/.mimosa/**", "**/.agents/**", "**/.github/**", "docs/**", "scripts/**", "**/*.cjs", "**/*.mjs"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
      "preserve-caught-error": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }]
    }
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "no-undef": "off",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }]
    }
  },
  {
    files: ["packages/chatgpt-browser-bridge-extension/**/*.js"],
    languageOptions: {
      globals: {
        chrome: "readonly", document: "readonly", navigator: "readonly", location: "readonly", window: "readonly",
        fetch: "readonly", Response: "readonly", Request: "readonly", Headers: "readonly", URL: "readonly", URLSearchParams: "readonly",
        AbortController: "readonly", setTimeout: "readonly", clearTimeout: "readonly", setInterval: "readonly", clearInterval: "readonly",
        console: "readonly", crypto: "readonly", TextEncoder: "readonly", module: "readonly", require: "readonly", globalThis: "readonly"
      }
    }
  },
  {
    // 扩展测试是 CommonJS 风格的 node:test 脚本，允许 require 与 Node 全局
    files: ["packages/chatgpt-browser-bridge-extension/tests/**/*.js"],
    languageOptions: {
      globals: {
        require: "readonly", module: "readonly", global: "readonly", console: "readonly",
        setTimeout: "readonly", clearTimeout: "readonly", crypto: "readonly", TextEncoder: "readonly", globalThis: "readonly"
      }
    },
    rules: { "@typescript-eslint/no-require-imports": "off" }
  }
);
