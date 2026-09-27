import { isAbsolute, resolve as resolvePath } from "node:path";
import {
  DevEnvironment,
  type Plugin,
  type Connect,
  type PreviewServer,
  type Logger,
  type ResolvedConfig,
} from "vite";
import { exactRegex } from "@rolldown/pluginutils";
import {
  type PluginOptions,
  type NodeRuntime,
  type CreateDevEnvironmentContext,
  virtualModuleId,
  resolvedVirtualModuleId,
  virtualServerId,
  resolvedVirtualServerId,
} from "./consts.ts";
import { createNodeEnvironment, serializeRequest } from "./server.ts";
import { createNodeRuntime, type NodeRpcHost } from "./node-runtime.ts";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface FetchStandard {
  fetch(request: Request): Response | Promise<Response>;
}

type EnvironmentBuildInput = string | string[] | Record<string, string> | undefined;

/**
 * Relaxed view of an environment's options, used to inspect (without
 * depending on Vite's internal types) the slots a framework plugin may
 * also configure: the dev runtime and the build entries.
 */
interface EnvironmentConfigLike {
  build?: {
    rolldownOptions?: { input?: EnvironmentBuildInput };
    rollupOptions?: { input?: EnvironmentBuildInput };
  };
  dev?: {
    createEnvironment?: unknown;
  };
}

function readEnvironmentConfig(
  config: { environments?: Record<string, unknown> },
  name: string,
): EnvironmentConfigLike | undefined {
  return config.environments?.[name] as EnvironmentConfigLike | undefined;
}

function getBuildInput(environment?: EnvironmentConfigLike): EnvironmentBuildInput {
  return environment?.build?.rolldownOptions?.input ?? environment?.build?.rollupOptions?.input;
}

/**
 * Returns the build input entries that conflict with the entries this
 * plugin injects. Same-name entries (e.g. `entry`, which frameworks like
 * React Router also use) are silently replaced by Vite's config merge,
 * depending on plugin order.
 */
function findConflictingInputEntries(
  input: EnvironmentBuildInput,
  ours: Record<string, string>,
): string[] {
  if (input === undefined) {
    return [];
  }

  if (typeof input === "string") {
    return ["<input>"];
  }

  if (Array.isArray(input)) {
    return ["<input>"];
  }

  const conflicts: string[] = [];

  for (const [key, value] of Object.entries(input)) {
    if (ours[key] !== value) {
      conflicts.push(key);
    }
  }

  return conflicts;
}

/**
 * Build entry module.
 *
 * The generated code is deliberately free of runtime shape checks: the
 * `typeof` guards that used to live here cost bundle size on every build and
 * only fired once the server was already starting. A plain `import handler
 * from "<entry>"` instead makes the bundler resolve the default export while
 * it builds, so a missing default export is a build error rather than a
 * startup crash.
 *
 * Shapes differ per `serverType` and the CLI unwraps accordingly:
 * - `node`: the default export is a Node-style `(req, res)` handler, wrapped
 *   here into a fetch handler via srvx's `toFetchHandler`.
 * - `web`: the default export is already the standard `{ fetch }` object and
 *   is re-exported unchanged.
 */
function getBuildCode(entryPath: string, serverType: string) {
  if (serverType === "node") {
    return `
import { toFetchHandler } from 'srvx/node'
import handler from ${JSON.stringify(entryPath)}

export default toFetchHandler(handler)
`;
  }

  return `
export { default } from ${JSON.stringify(entryPath)}
`;
}

const serverCliCode = (serverType: string) => `
// The build entry's default export is the entry itself for \`node\` (a
// Node-style handler, already wrapped by toFetchHandler) and the standard
// \`{ fetch }\` object for \`web\`. srvx's \`serve()\` wants the fetch function
// itself, so unwrap only the web shape.
import entry from '${virtualModuleId}'

const fetch = ${serverType === "node" ? "entry" : "entry.fetch"}

import { parseArgs } from "node:util";
import { serve } from "srvx";
import { loggerMiddleware } from "srvx/log";

const args = parseArgs({
  options: {
    host: {
      type: "string",
      short: "H",
      default: "localhost",
    },
    port: {
      type: "string",
      short: "p",
      default: "3000",
    },
    protocol: {
      type: "string",
      default: "http",
    },
    "tls-cert": {
      type: "string",
    },
    "tls-key": {
      type: "string",
    },
    "tls-passphrase": {
      type: "string",
    },
    proxy: {
      type: "string",
      default: ["none"],
      multiple: true,
    },
    help: {
      type: "boolean",
      short: "h",
    },
  },
});

const helpText = \`
Options:
  --host, -H <host>          Host to bind to (default: localhost)
  --port, -p <port>          Port to listen on (default: 3000)
  --protocol <protocol>      http | https
  --tls-cert <path>          TLS certificate
  --tls-key <path>           TLS private key
  --tls-passphrase <string>  TLS passphrase
  --proxy                    Trust proxy headers (can pass multiple, 'all' blindly trusts, 'none' does not trust)
  -h, --help                 Show help
\`;

if (args.values.help) {
  console.log(helpText);
  process.exit(0);
}

const port = Number(args.values.port);

const proxies = args.values.proxy;

if (args.values.protocol !== "http" && args.values.protocol !== "https") {
  throw new Error("Invalid protocol passed! Expected either 'http' or 'https'.");
}

function parseProxyArgs(args) {
  if (proxies.length > 1) {
    proxies.forEach((v) => {
      if (v === "none" || v === "all") {
        throw new Error(
          "Multiple --proxy flags passed but one or more are either 'none' or 'all'!",
        );
      }
    });
    return args;
  } else {
    const arg = args[0];

    switch (arg) {
      case "none":
        return false;
      case "all":
        return true;
      default:
        return [arg];
    }
  }
}

const termHandler = async () => {
    await server.close()
}

console.log(\`🚀 Starting server...\`)

const server = serve({
  fetch,
  middleware: [loggerMiddleware()],
  hostname: args.values.host,
  port,
  protocol: args.values.protocol,
  trustProxy: parseProxyArgs(args.values.proxy),
  tls: {
    cert: args.values["tls-cert"],
    key: args.values["tls-key"],
    passphrase: args.values["tls-passphrase"],
  },
});

await server.ready()
process.once('SIGINT', termHandler);
process.once('SIGTERM', termHandler);
`;

function getDevCode(entryPath: string, entryId: string, serverType: string, _opts: PluginOptions) {
  const isNode = serverType === "node";

  return `
${isNode ? "import { fetchNodeHandler } from 'srvx/node'" : ""}
const entry = await import(${JSON.stringify(entryPath)})

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

/**
 * Build-time entry shape validation.
 *
 * With the runtime `typeof` guards removed from the generated build code, a
 * missing default export is already a build error (the generated code
 * imports it). What the bundler *cannot* catch is a default export of the
 * wrong kind, so check the module's known export bindings here and fail the
 * build with an actionable message.
 *
 * Best-effort by design: if the entry has not been analyzed yet (it is often
 * still awaiting transformation when this virtual module loads) there is
 * nothing to assert, so this stays silent rather than failing a valid build.
 */
async function validateEntryShape(
  entryId: string,
  serverType: string,
  context: { getModuleInfo?: (id: string) => unknown },
): Promise<void> {
  const exportedBindings = (
    context.getModuleInfo?.(entryId) as { exportedBindings?: Set<string> | null } | null | undefined
  )?.exportedBindings;

  if (!exportedBindings) {
    return;
  }

  if (!exportedBindings.has("default")) {
    throw new Error(
      `Backend entry ${JSON.stringify(entryId)} has no default export. ` +
        `It must ${serverType === "node" ? "default-export a Node request handler function" : 'default-export an object containing a fetch() function ("export default { fetch }")'}.`,
    );
  }
}

export function node(opts: PluginOptions): Plugin {
  const serverType = opts.serverType ?? "web";
  const environmentName = opts.environment ?? "server";

  if (environmentName === "client") {
    throw new Error("opts.environment must not be set to client");
  }

  // Backend mode runs the plugin's own fetch-style entry in the worker and
  // serves requests through the plugin's middleware. Without an entry, the
  // plugin only provides the dev runtime for the environment, which is
  // meant to be shared with a framework (e.g. assigned to `ssr`).
  const backendMode = opts.entry !== undefined;
  const devOnly = opts.devOnly === true;

  if (devOnly && !backendMode) {
    throw new Error(
      "opts.devOnly requires opts.entry. Without an entry there is nothing to run in dev, and entry-less mode already skips all build and preview configuration.",
    );
  }

  const runtimes = new WeakMap<DevEnvironment, NodeRuntime>();
  const rpcHosts = new WeakMap<DevEnvironment, NodeRpcHost>();

  let command: string;

  let root = process.cwd();

  // Claims observed on the environment before this plugin injects its own
  // configuration. Reported in configResolved, where the merge outcome is
  // known.
  let foreignDevRuntime = false;
  let foreignBuildInput = false;

  const rolldownInputs: Record<string, string> = { entry: virtualModuleId };
  if (opts.outputRunnableCli !== false) {
    rolldownInputs.index = virtualServerId;
  }

  const createDevEnvironmentFn = (
    name: string,
    config: ResolvedConfig,
    context: CreateDevEnvironmentContext,
  ): DevEnvironment => {
    const host = createNodeEnvironment(name, config, context, {
      mode: backendMode ? "backend" : "runtime",
    });

    if (host.runtime) {
      runtimes.set(host.environment, host.runtime);
    }

    if (host.rpcHost) {
      rpcHosts.set(host.environment, host.rpcHost);
    }

    return host.environment;
  };

  return {
    name: "vite-plugin-node-env",

    config(userConfig) {
      const existingEnvironment = readEnvironmentConfig(userConfig, environmentName);

      if (existingEnvironment?.dev?.createEnvironment !== undefined) {
        foreignDevRuntime = true;
      }

      if (getBuildInput(existingEnvironment) !== undefined) {
        foreignBuildInput = true;
      }

      return {
        appType: userConfig.appType ?? "custom",

        // Opt into the multi-environment builder. An empty object merges
        // harmlessly with any `builder` config contributed by a framework,
        // and `buildApp` is provided as a (composable) plugin hook below
        // instead of a config-level one, which Vite's config merge would
        // silently replace.
        builder: {},

        environments: {
          [environmentName]: {
            consumer: "server",

            dev: {
              createEnvironment: createDevEnvironmentFn,
            },

            ...(backendMode && !devOnly
              ? {
                  build: {
                    outDir: `dist/${environmentName}`,

                    rolldownOptions: {
                      input: rolldownInputs,

                      output: {
                        format: "esm",
                      },

                      external: opts.external,
                      platform: "node",
                    },
                  },
                }
              : {}),
          },
        },
      };
    },

    buildApp: {
      order: "post",

      async handler(builder) {
        if (!backendMode || devOnly) {
          return;
        }

        const environment = builder.environments[environmentName];

        if (!environment) {
          throw new Error(`Environment "${environmentName}" does not exist`);
        }

        // Build only if nothing else (e.g. a framework's buildApp) already
        // built this environment.
        if (!environment.isBuilt) {
          await builder.build(environment);
        }
      },
    },

    configResolved(resolvedConfig) {
      root = resolvedConfig.root;
      command = resolvedConfig.command;

      const logger = resolvedConfig.logger;
      const environment = readEnvironmentConfig(resolvedConfig, environmentName);

      if (backendMode && !devOnly) {
        const conflicts = findConflictingInputEntries(getBuildInput(environment), rolldownInputs);

        if (conflicts.length > 0 || foreignBuildInput) {
          logger.warn(
            `[vite-plugin-node-env] The "${environmentName}" environment's build input is also configured by the user config or another plugin (e.g. a framework)${conflicts.length > 0 ? ` (entries: ${conflicts.map((entry) => `"${entry}"`).join(", ")})` : ""}. ` +
              `This plugin injects its own build entries, and Vite's config merge silently replaces same-name entries (both sides commonly use "entry"), so entries from one side may have been dropped. ` +
              `If a framework owns this environment, add { devOnly: true } so the framework supplies the build, or move the backend to its own environment via opts.environment.`,
          );
        }
      }

      const createEnvironment = environment?.dev?.createEnvironment;

      if (createEnvironment !== undefined && createEnvironment !== createDevEnvironmentFn) {
        logger.warn(
          `[vite-plugin-node-env] Another plugin replaced the dev runtime (dev.createEnvironment) for the "${environmentName}" environment; this plugin's worker runtime was overridden by config merge order. ` +
            `Pick an environment name not owned by the other plugin via opts.environment.`,
        );
      } else if (foreignDevRuntime) {
        logger.warn(
          `[vite-plugin-node-env] Another plugin also configures dev.createEnvironment for the "${environmentName}" environment. ` +
            `This plugin's worker runtime won by config merge order and the other plugin's dev runtime is unused.`,
        );
      }
    },

    applyToEnvironment(environment) {
      return environment.name === environmentName;
    },

    resolveId(id) {
      if (id === virtualModuleId) {
        return resolvedVirtualModuleId;
      } else if (id === virtualServerId) {
        return resolvedVirtualServerId;
      }
    },

    load: {
      // Restricts the handler to our virtual module id so Rolldown's native
      // filter can skip calling into JS for every other module.
      filter: {
        id: [exactRegex(resolvedVirtualModuleId), exactRegex(resolvedVirtualServerId)],
      },

      async handler(id) {
        if (id === resolvedVirtualModuleId) {
          if (opts.entry === undefined) {
            throw new Error(
              `${virtualModuleId} was imported, but no entry option was configured for this plugin. ` +
                `In entry-less (runtime provider) mode the environment's modules are driven through environment.runner.import() instead.`,
            );
          }

          // A bare relative path like "src/index.ts" (no leading "./" or "/") would
          // otherwise be mistaken for a bare module specifier by the resolver.
          const entryPath = isAbsolute(opts.entry) ? opts.entry : resolvePath(root, opts.entry);

          const resolved = await this.resolve(entryPath, id);

          if (!resolved) {
            throw new Error(`Could not resolve backend entry: ${opts.entry}`);
          }

          const entryId = resolved.id;

          if (command === "build") {
            // Surface a wrong-shaped entry now rather than at server start.
            // The generated build code no longer carries runtime `typeof`
            // checks, so this is the only place the shape is verified.
            await validateEntryShape(resolved.id, serverType, this);

            return getBuildCode(entryPath, serverType);
          }

          return getDevCode(entryPath, entryId, serverType, opts);
        } else if (id === resolvedVirtualServerId) {
          return serverCliCode(serverType);
        }
      },
    },

    configureServer(server) {
      const environment = server.environments[environmentName];

      if (!environment) {
        throw new Error(`Environment "${environmentName}" does not exist`);
      }

      if (!backendMode) {
        // Runtime-provider mode: the environment is driven through
        // runner.import() (usually by a framework's dev middleware), so no
        // request middleware is registered by this plugin.
        const rpcHost = rpcHosts.get(environment);

        if (!rpcHost) {
          throw new Error(noRuntimeMessage(environmentName));
        }

        server.httpServer?.once("close", () => {
          void rpcHost.close();
        });

        return;
      }

      const runtime = runtimes.get(environment);

      if (!runtime) {
        throw new Error(noRuntimeMessage(environmentName));
      }

      return () => {
        server.middlewares.use(nodeRequestLogger(server.config.logger));
        server.middlewares.use(createNodeRequestHandler(runtime));

        server.httpServer?.once("close", () => {
          void runtime.close();
        });
      };
    },

    configurePreviewServer(server) {
      if (!backendMode || devOnly) {
        // The environment's build and preview are owned by something else
        // (usually a framework plugin).
        return;
      }

      const node = createNodeRuntime({
        mode: "preview",
        entry: resolvePreviewEntry(server, environmentName),
      });

      return () => {
        server.middlewares.use(nodeRequestLogger(server.config.logger));
        server.middlewares.use(createNodeRequestHandler(node.runtime));

        server.httpServer?.once("close", () => {
          void node.runtime.close();
        });
      };
    },

    hotUpdate(options) {
      if (this.environment.name !== environmentName) {
        return;
      }

      switch (options.type) {
        case "create":
          this.info(`[vite-plugin-node-env] module created in backend: ${options.file}`);
          break;
        case "update":
          this.info(`[vite-plugin-node-env] module updated in backend: ${options.file}`);
          break;
        case "delete":
          this.info(`[vite-plugin-node-env] module deleted in backend: ${options.file}`);
          break;
      }
    },
  };
}

function noRuntimeMessage(environmentName: string): string {
  return (
    `No runtime exists for environment "${environmentName}" — another plugin may have replaced its dev runtime (dev.createEnvironment). ` +
    `Pick a different environment name via opts.environment.`
  );
}

const serverEntryFileName = "entry.js";

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

function nodeRequestLogger(logger: Logger) {
  return async (
    req: Connect.IncomingMessage,
    res: ServerResponse<IncomingMessage>,
    next: () => void,
  ) => {
    const start = performance.now();
    res.once("finish", () => {
      const time = performance.now() - start;

      logger.info(`[${res.statusCode}] ${req.method} ${req.url} (${time.toFixed()}ms)`, {
        timestamp: true,
      });
    });
    next();
  };
}
