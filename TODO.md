# Task list

- [x] Get build working
- [x] Get preview working
- [x] Support Node.js server handlers
- [ ] Fix that issue with code splitting
- [ ] Support for non-server backends (e.g. [seedcord](https://github.com/seedcord/seedcord))
- [ ] Mixed client & server handling
- [ ] Framework-as-Vite-plugin integrations
- [ ] Tests

## Known issues

Framework mode is not tickable above yet: the build path works for all three
framework playgrounds, but `dev` returns 404 in two of them.

- [ ] `dev` 404s in `react-router` — `plugins/node` and the playground resolve two
      different physical copies of Vite (`node_modules/.pnpm/@voidzero-dev+vite-plus-cor_*`),
      so the `isRunnableDevEnvironment` `instanceof` check fails. `dedupePeerDependents`
      and `node-linker=hoisted` did not converge it.
- [ ] `dev` 404s in `tanstack-start` — undiagnosed; no error and no warning is logged.
- [ ] `index2.js` chunk naming: in framework mode rolldown names the extra chunk after
      the virtual module rather than the `index` input key. Cosmetic, but confusing.
- [ ] Build-time entry shape check silently skips entries that import CSS
      (`Failed to load url ./style.css`). Standalone probes resolve fine with
      `configFile: false`, so the real config is re-entering the user plugin chain.
