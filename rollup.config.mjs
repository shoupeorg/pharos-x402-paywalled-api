import { nodeResolve } from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";

export default {
  input: "src/worker.js",
  output: { file: "dist/worker.js", format: "es", sourcemap: false, inlineDynamicImports: true },
  plugins: [
    nodeResolve({ browser: true, exportConditions: ["worker", "browser", "import", "default"], preferBuiltins: false }),
    commonjs(),
    json(),
  ],
};
