import { defineConfig } from "vite-plus";
import { nitro } from "nitro/vite";

import { solidStart } from "@solidjs/start/config";
import { lazyPlugins } from "vite-plus";

export default defineConfig({
  plugins: lazyPlugins(() => [solidStart(), nitro()]),
});
