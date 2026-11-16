import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    capture: "src/capture.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  platform: "node",
  target: "es2022",
  sourcemap: false,
  clean: true,
  noExternal: ["@overturn-ai/shared"],
  outDir: "dist",
});
