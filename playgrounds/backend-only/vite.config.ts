import { defineConfig } from "vite-plus";
import { node } from "@ktrain5369/vite-plugin-node-env";

export default defineConfig({
  plugins: [
    node({
      entry: "src/index.ts",
    }),
  ],
});
