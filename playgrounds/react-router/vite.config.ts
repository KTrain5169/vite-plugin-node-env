import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";
import { lazyPlugins } from "vite-plus";

export default defineConfig({
  plugins: lazyPlugins(() => [tailwindcss(), reactRouter()]),
  resolve: {
    tsconfigPaths: true,
  },
});
