import { isAbsolute, resolve as resolvePath } from "node:path";
import { DevEnvironment, type Plugin } from "vite";
import { exactRegex } from "@rolldown/pluginutils";
import {
  type PluginOptions,
  type NodeRuntime,
  virtualModuleId,
  resolvedVirtualModuleId,
} from "./consts.ts";
import { createNodeEnvironment, serializeRequest } from "./server.ts";

export interface FetchStandard {
  fetch(request: Request): Response | Promise<Response>;
}

export function node(opts: PluginOptions): Plugin {
  const environmentName = opts.environment ?? "server";

  const runtimes = new WeakMap<DevEnvironment, NodeRuntime>();

  let root = process.cwd();

  return {
    name: "vite-plugin-node",

    configResolved(config) {
      root = config.root;
    },

    config() {
      return {
        environments: {
          [environmentName]: {
            dev: {
              createEnvironment(name, config, context) {
                const { environment, runtime } = createNodeEnvironment(name, config, context);

                runtimes.set(environment, runtime);

                return environment;
              },
            },
          },
        },
      };
    },

    applyToEnvironment(environment) {
      return environment.name === environmentName;
    },

    resolveId(id) {
      if (id === virtualModuleId) {
        return resolvedVirtualModuleId;
      }
    },

    load: {
      // Restricts the handler to our virtual module id so Rolldown's native
      // filter can skip calling into JS for every other module.
      filter: {
        id: exactRegex(resolvedVirtualModuleId),
      },

      async handler(id) {
        // A bare relative path like "src/index.ts" (no leading "./" or "/") would
        // otherwise be mistaken for a bare module specifier by the resolver.
        const entryPath = isAbsolute(opts.entry) ? opts.entry : resolvePath(root, opts.entry);

        const resolved = await this.resolve(entryPath, id);

        if (!resolved) {
          throw new Error(`Could not resolve backend entry: ${opts.entry}`);
        }

        const entryId = resolved.id;

        return `
import * as entry from ${JSON.stringify(entryId)}

let current = entry.default

if (!current || typeof current.fetch !== 'function') {
  throw new TypeError(
    ${JSON.stringify(`${opts.entry} must default-export an object containing fetch()`)}
  )
}

if (import.meta.hot) {
  import.meta.hot.accept(
    ${JSON.stringify(entryId)},
    (next) => {
      const nextApp = next?.default

      if (
        !nextApp ||
        typeof nextApp.fetch !== 'function'
      ) {
        console.error(
          ${JSON.stringify(
            `${opts.entry} HMR update was rejected because its default export does not contain fetch()`,
          )}
        )

        return
      }

      current = nextApp
    },
  )
}

export function fetch(request) {
  return current.fetch(request)
}
`;
      },
    },

    configureServer(server) {
      const environment = server.environments[environmentName];

      if (!environment) {
        throw new Error(`Environment "${environmentName}" does not exist`);
      }

      const runtime = runtimes.get(environment);

      if (!runtime) {
        throw new Error(`No runtime exists for environment "${environmentName}"`);
      }

      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? "/";

        // Don't intercept Vite's own internal HTTP endpoints.
        if (
          url.startsWith("/@vite/") ||
          url.startsWith("/@fs/") ||
          url.startsWith("/@id/") ||
          url.startsWith("/__vite_ping")
        ) {
          next();
          return;
        }

        try {
          const request = await serializeRequest(req);

          const response = await runtime.request(request);

          res.statusCode = response.status;
          res.statusMessage = response.statusText;

          for (const [name, value] of response.headers) {
            res.setHeader(name, value);
          }

          if (response.body) {
            res.end(Buffer.from(response.body));
          } else {
            res.end();
          }
        } catch (error) {
          next(error);
        }
      });

      server.httpServer?.once("close", () => {
        void runtime.close();
      });
    },
  };
}
