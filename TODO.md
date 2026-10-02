# Task list

- [x] Get build working
- [x] Get preview working
- [x] Support Node.js server handlers
- [ ] Fix that issue with code splitting
- [ ] Support for non-server backends (e.g. [seedcord](https://github.com/seedcord/seedcord))
- [ ] More verbose logging & flags in srvx?
- [ ] Mixed client & server handling
- [ ] Framework-as-Vite-plugin integrations
- [ ] Tests

## Known issues

Framework mode is not tickable above yet: the build path works for all three
framework playgrounds, but `dev` returns 404 in two of them.

- [ ] TanStack Start continuously returns `Cannot GET {route}` — **duplicate Vite copies**,
      same class of failure as the old react-router entry. Not TanStack-specific and not
      caused by our plugin. TanStack's dev middleware bails _silently_ at
      `start-plugin-core/dist/esm/vite/dev-server-plugin/plugin.js:58`:
      `js
  if (!isRunnableDevEnvironment(serverEnv) || "dispatchFetch" in serverEnv) return;
  `
      Measured in the playground: the `ssr` env is a genuine `RunnableDevEnvironment`
      with no `dispatchFetch`, yet `isRunnableDevEnvironment(ssr)` returns **false**,
      because that helper is `env instanceof RunnableDevEnvironment` (Vite
      `dist/vite/node/chunks/node.js:42057`) against a _different_ physical copy of
      Vite than the one that constructed the env. `plugins/node` resolves
      `vite-plus-cor_27fdb9d4`; `tanstack-start` resolves `..._7ebf7828`. Control:
      `solid-start`, whose dev works, resolves `27fdb9d4` on both sides and gets
      `isRunnable=true` with an otherwise identical config. Fix is dependency
      resolution (collapse the copies), not plugin logic.
- [ ] Build-time entry shape check silently skips entries that import CSS
      (`Failed to load url ./style.css`). Standalone probes resolve fine with
      `configFile: false`, so the real config is re-entering the user plugin chain.
