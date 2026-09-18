import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    deps: { resolveDepSubpath: true },
    entry: ["src/index.ts", "src/node-worker.ts"],
    dts: {
      generator: "oxc",
    },
    exports: true,
    publint: true,
    attw: { profile: "strict" },
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
