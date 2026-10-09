import { defineConfig } from "tsup";

export default defineConfig({
  bundle: false,
  clean: true,
  dts: true,
  // bundle:false transpiles each file individually and preserves the import
  // graph, so every source file must be an entry (mirrors the base SDK's tsup
  // config 1:1). The `exports` map still only exposes `.` and `./governance`.
  entry: ["src/**/*.ts"],
  format: ["esm"],
  outDir: "dist",
  platform: "node",
  sourcemap: true,
  splitting: false,
  target: "node24"
});
