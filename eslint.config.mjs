import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      ".claude/**",
      "**/dist/**",
      "**/.next/**",
      "contracts/**",
      "**/generated/**",
      "**/.envio/**",
      "**/envio-env.d.ts",
      "**/.cre_build_tmp.js",
      "services/scheduler/cre/**/node_modules/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { rules: { "@typescript-eslint/no-explicit-any": "error" } },
);
