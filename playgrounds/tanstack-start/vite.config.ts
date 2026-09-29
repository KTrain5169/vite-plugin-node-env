import { defineConfig, lazyPlugins } from "vite-plus";
import { devtools } from "@tanstack/devtools-vite";

import { tanstackStart } from "@tanstack/react-start/plugin/vite";

import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

import { node } from "@ktrain5369/vite-plugin-node-env";

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: lazyPlugins(() => [
    devtools(),
    node({ environment: "ssr", outputRunnableCli: true }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ]),
  fmt: {
    ignorePatterns: ["**/routeTree.gen.ts"],
  },
});

export default config;
