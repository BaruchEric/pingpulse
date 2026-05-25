import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["convex/_generated/**", "dashboard/**", "**/dist/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        crypto: "readonly",
        fetch: "readonly",
        Response: "readonly",
        Request: "readonly",
        ReadableStream: "readonly",
        TextEncoder: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        btoa: "readonly",
        atob: "readonly",
        setTimeout: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);
