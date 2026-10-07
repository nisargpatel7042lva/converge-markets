import { defineConfig } from "tsup";

// The published build: one ESM file and one declaration file. viem is a peer dependency (the app
// brings its own client), everything else is bundled in or listed in `dependencies`.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  platform: "neutral",
  external: ["viem", "zod", "@noble/curves", "@noble/hashes"],
});
