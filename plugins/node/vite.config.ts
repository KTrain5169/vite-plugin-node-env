import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/index.ts", "src/node-worker.ts"],
    dts: {
      tsgo: true,
    },
    exports: true,
    publint: true,
    attw: true,
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
