import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts", "src/capture.ts"],
    format: ["cjs", "esm"],
    dts: true,
    clean: true,
    sourcemap: true,
    target: "node22",
    external: ["@overturn-ai/shared"],
  },
  {
    entry: { main: "src/main.ts" },
    format: ["iife"],
    globalName: "OverturnGorgias",
    platform: "browser",
    target: "es2020",
    sourcemap: false,
    clean: false,
    minify: true,
    noExternal: ["@overturn-ai/shared"],
    outDir: "dist",
  },
]);
