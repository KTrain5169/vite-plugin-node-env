import { defineConfig } from "vite-plus";

import { solidStart } from "@solidjs/start/config";
import { lazyPlugins } from "vite-plus";

import { node } from "@ktrain5369/vite-plugin-node-env";

export default defineConfig({
  plugins: lazyPlugins(() => [node({ environment: "ssr", outputRunnableCli: true }), solidStart()]),
});
