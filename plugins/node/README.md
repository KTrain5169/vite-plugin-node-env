# `@ktrain5369/vite-plugin-node-env`

Vite plugin to run web standard (fetch) servers in a Node worker thread environment.

## Usage

```ts
import { defineConfig } from "vite";
import { node } from "vite-plugin-node";

export default defineConfig({
  plugins: [
    node({
      entry: "src/server.ts",
    }),
  ],
});
```

where `src/server.ts` follows the `fetch` handler pattern:

```ts
export default {
  fetch(req: Request) {
    return new Response();
  },
};
```
