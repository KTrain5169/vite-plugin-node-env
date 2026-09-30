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

- [ ] `dev` 404s in `tanstack-start` — undiagnosed; no error and no warning is logged.
- [ ] `index2.js` chunk naming: in framework mode rolldown names the extra chunk after
      the virtual module rather than the `index` input key. Cosmetic, but confusing.
- [ ] Build-time entry shape check silently skips entries that import CSS
      (`Failed to load url ./style.css`). Standalone probes resolve fine with
      `configFile: false`, so the real config is re-entering the user plugin chain.
