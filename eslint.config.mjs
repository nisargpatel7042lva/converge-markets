import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      ".claude/**",
      "**/dist/**",
      "**/.next/**",
      "**/.next-e2e/**",
      "apps/web/public/**",
      "apps/web/e2e-results/**",
      "apps/web/next-env.d.ts",
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
