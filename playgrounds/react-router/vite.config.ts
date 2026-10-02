import { reactRouter } from "@react-router/dev/vite";
import { defineConfig, type PluginOption } from "vite-plus";

import { node } from "@ktrain5369/vite-plugin-node-env";

export default defineConfig({
  plugins: [node({ environment: "ssr" }), reactRouter()] as PluginOption[],
  resolve: {
    tsconfigPaths: true,
  },
});
