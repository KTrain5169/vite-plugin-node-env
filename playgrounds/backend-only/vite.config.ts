import { defineConfig } from "vite-plus";
import { node } from "vite-plugin-node";

export default defineConfig({
  plugins: [
    node({
      entry: "src/index.ts",
    }),
  ],
});
