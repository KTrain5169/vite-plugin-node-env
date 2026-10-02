---
"@ktrain5369/vite-plugin-node-env": minor
---

Add framework mode, where `entry` is omitted and the plugin supplies a dev runtime instead of a backend.

- `entry` is now optional. With no `entry`, the plugin runs the dev server in a worker and talks to it over an RPC message port, so framework plugins can use it as a Vite plugin rather than owning a build.
- `outputRunnableCli: true` is now supported in framework mode. The plugin detects the framework's server build input and generates `dist/server/cli.js` that imports it, so `node dist/server/cli.js` serves the framework's app. It stays off by default there, since frameworks normally supply their own production runner.
- The entry's shape is now validated at build time against `serverType`, using Vite's own module importer so TypeScript, CSS and path aliases load exactly as they will at runtime. `web` requires a default export with `fetch`; `node` requires a default export accepting at least two arguments. A misconfigured `serverType` now fails the build instead of a server that only breaks once started.
- Building now fails with an actionable message when `srvx` is not installed but the generated code imports it — the runnable CLI, or `serverType: "node"`. Previously this surfaced late as a bundler error about an unresolved import.

**Breaking:** the built entry is now written to `dist/server/index.js`. It was `dist/server/entry.js`. Update any deploy script, Dockerfile or `node dist/server/entry.js` invocation.

Fixes:

- The "build entries were replaced" warning no longer fires on build input keys contributed by other plugins. It previously flagged any foreign key rather than only this plugin's own.
- Fixed a deadlock where the first worker-to-main RPC call never resolved, because the worker's peer signalled readiness only in response to an incoming message.
- Fixed a `DataCloneError` when an RPC payload carried a function inside a class instance, which affected React Router and SolidStart.
