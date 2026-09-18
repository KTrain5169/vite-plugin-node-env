import { isAbsolute, resolve as resolvePath } from "node:path";
import { DevEnvironment, type Plugin, type Connect, type PreviewServer } from "vite";
import { exactRegex } from "@rolldown/pluginutils";
import {
  type PluginOptions,
  type NodeRuntime,
  virtualModuleId,
  resolvedVirtualModuleId,
} from "./consts.ts";
import { createNodeEnvironment, serializeRequest } from "./server.ts";
import { createNodeRuntime } from "./node-runtime.ts";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface FetchStandard {
  fetch(request: Request): Response | Promise<Response>;
}

function getBuildCode(
  entryPath: string,
  entryId: string,
  serverType: string,
  _opts: PluginOptions,
) {
  if (serverType === "node") {
    return `
import { toFetchHandler } from 'srvx/node'
const entry = await import(${entryPath})

export const handler = entry.default

if (typeof handler !== 'function') {
  throw new TypeError("default export is not callable")
}

export const fetch = toFetchHandler(handler)
`;
  }

  return `
const entry = await import(${entryPath})

export const fetch =
  entry.default?.fetch ?? entry.fetch

if (typeof fetch !== 'function') {
  throw new TypeError("no fetch function exported")
}
`;
}

function getDevCode(entryPath: string, entryId: string, serverType: string, _opts: PluginOptions) {
  const isNode = serverType === "node";

  return `
import ${isNode ? "{ fetchNodeHandler } from 'srvx/node'" : ""}
const entry = await import(${entryPath})

let current = entry.default ?? entry

if (${isNode ? "typeof current !== 'function'" : "typeof current.fetch !== 'function'"}) {
  throw new TypeError(
    ${JSON.stringify(`${_opts.entry} must default-export an object containing fetch()`)}
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
            `${_opts.entry} HMR update was rejected because its default export does not contain fetch()`,
          )}
        )

        return
      }

      current = nextApp
    },
  )
}

export function fetch(request) {
  ${isNode ? "return fetchNodeHandler(current)" : "return current.fetch(request)"}
}
`;
}

export function node(opts: PluginOptions): Plugin {
  const serverType = opts.serverType ?? "web";
  const environmentName = opts.environment ?? "server";

  const runtimes = new WeakMap<DevEnvironment, NodeRuntime>();

  let command: string;

  let root = process.cwd();

  return {
    name: "vite-plugin-node",

    configResolved(config) {
      root = config.root;
      command = config.command;
    },

    config() {
      return {
        appType: "custom",
        builder: {
          async buildApp(builder) {
            await builder.build(builder.environments[environmentName]);
          },
        },
        environments: {
          [environmentName]: {
            consumer: "server",
            dev: {
              createEnvironment(name, config, context) {
                const { environment, runtime } = createNodeEnvironment(name, config, context);

                runtimes.set(environment, runtime);

                return environment;
              },
            },
            build: {
              ssr: true,
              outDir: `dist/${environmentName}`,

              rolldownOptions: {
                input: virtualModuleId,

                output: {
                  entryFileNames: "index.mjs",
                  format: "esm",
                },
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

        if (command === "build") {
          return getBuildCode(entryPath, entryId, serverType, opts);
        }

        return getDevCode(entryPath, entryId, serverType, opts);
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

      server.middlewares.use(createNodeRequestHandler(runtime));

      server.httpServer?.once("close", () => {
        void runtime.close();
      });
    },

    configurePreviewServer(server) {
      const node = createNodeRuntime({
        mode: "preview",
        entry: resolvePreviewEntry(server, environmentName),
      });

      server.middlewares.use(createNodeRequestHandler(node.runtime));

      server.httpServer?.once("close", () => {
        void node.runtime.close();
      });
    },
  };
}

const serverEntryFileName = "server.mjs";

export function resolvePreviewEntry(server: PreviewServer, environmentName: string): string {
  const environment = server.config.environments[environmentName];

  if (!environment) {
    throw new Error(`Environment "${environmentName}" does not exist`);
  }

  return resolvePath(server.config.root, environment.build.outDir, serverEntryFileName);
}

function createNodeRequestHandler(runtime: NodeRuntime) {
  return async (
    req: Connect.IncomingMessage,
    res: ServerResponse<IncomingMessage>,
    next: Connect.NextFunction,
  ) => {
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
  };
}
