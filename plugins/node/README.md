# `@ktrain5369/vite-plugin-node-env`

Vite plugin to run web standard (fetch) servers in a Node worker thread environment.

## Usage

```ts
import { defineConfig } from "vite";
import { node } from "vite-plugin-node-env";

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

Note that by default this configures the `server` environment in Vite, not `ssr`. This is because usually, most standalone Node.js backend servers aren't written with SSR in mind, so to prevent conflicts with other possible plugins, the default configured environment is changed.
You can configure it to target `ssr` (or any ohter environment) with `node({ environment: 'ssr' })`
