import { defineConfig } from "vite-plus";
import { node } from "../../plugins/node/src";

export default defineConfig({
  plugins: [
    node({
      entry: "src/index.ts",
    }),
  ],
});
