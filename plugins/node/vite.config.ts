import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    // Vitest v4 compatibility: preserve mock call history.
    // Remove after tests no longer rely on calls from setup or earlier tests.
    // https://viteplus.dev/guide/vitest-v5#remove-unneeded-compatibility-settings
    // https://vitest.dev/guide/migration/#clearmocks-is-enabled-by-default
    clearMocks: false,
  },
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
