import { isAbsolute, resolve as resolvePath, relative as relativePath } from "node:path";
import { existsSync } from "node:fs";
import {
  DevEnvironment,
  createRunnableDevEnvironment,
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
 * plugin injects. Only keys this plugin actually contributes are considered:
 * a framework's own entries (e.g. React Router's `entry`) coexist happily
 * alongside ours and must not be reported.
 *
 * What matters is whether *our* entries survived the config merge, since
 * same-name keys are silently replaced depending on plugin order.
 */
function findClobberedInputEntries(
  input: EnvironmentBuildInput,
  ours: Record<string, string>,
): string[] {
  // A non-record input cannot carry our keyed entries at all, so ours were
  // necessarily dropped in favour of it.
  if (typeof input === "string" || Array.isArray(input)) {
    return Object.keys(ours);
  }

  if (input === undefined) {
    return Object.keys(ours);
  }

  const clobbered: string[] = [];

  for (const [key, value] of Object.entries(ours)) {
    if (input[key] !== value) {
      clobbered.push(key);
    }
  }

  return clobbered;
}

/**
 * The generated runnable CLI and the `node` build entry both import `srvx`.
 * This function checks for `srvx` during the build so it's not a runtime error.
 */
function assertSrvxIsResolvable(root: string, reasons: string[]): void {
  const candidates = [
    resolvePath(root, "node_modules", "srvx"),
    resolvePath(root, "node_modules", "srvx", "package.json"),
  ];

  if (candidates.some((candidate) => existsSync(candidate))) {
    return;
  }

  throw new Error(
    `[vite-plugin-node-env] "srvx" is not installed in ${resolvePath(root, "node_modules")}, ` +
      `but this configuration generates code that imports it (${reasons.join("; ")}). ` +
      `Install it alongside the plugin: \`npm install srvx\`.`,
  );
}

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

/**
 * Build-time validation of the user's entry shape.
 * Uses Vite's importer
 */
async function validateServerEntry(
  config: ResolvedConfig,
  entryId: string,
  serverType: string,
  entryDescription: string,
): Promise<void> {
  const probeName = "__vite_plugin_node_env_probe";

  // The environment must exist in the config to be constructed, but it is
  // removed again below so the builder never sees (and never builds) it.
  // `moduleRunnerTransform` is what Vite's own `runnerImport` sets up, and is
  // required for the runner to evaluate the module at all.
  const environments = config.environments as unknown as Record<string, unknown>;

  environments[probeName] = {
    consumer: "server",
    dev: { moduleRunnerTransform: true },
  };

  const environment = createRunnableDevEnvironment(probeName, config);

  let module: Record<string, unknown> | undefined;

  try {
    await environment.init();

    module = (await environment.runner.import(entryId)) as Record<string, unknown>;
  } catch (error) {
    // Inconclusive, not a failure: some entries cannot be evaluated outside a
    // real request context. Skip the check rather than break a valid build.
    config.logger.warn(
      `[vite-plugin-node-env] Skipped the build-time shape check for ${entryDescription}: ` +
        `${(error as Error).message.split("\n")[0]}`,
    );

    return;
  } finally {
    await environment.close();
    delete environments[probeName];
  }

  if (serverType === "node") {
    const handler = module.default;

    if (typeof handler !== "function") {
      throw new Error(
        `[vite-plugin-node-env] ${entryDescription} must default-export a function when ` +
          `serverType is "node", but its default export is ${describeValue(handler)}. ` +
          `A node entry looks like \`export default (req, res) => { ... }\`.`,
      );
    }

    if (handler.length < 2) {
      throw new Error(
        `[vite-plugin-node-env] ${entryDescription} must default-export a node handler that ` +
          `accepts at least 2 arguments (request, response), but the function declares ` +
          `${handler.length}. If it is a fetch-style handler, use serverType "web" instead.`,
      );
    }

    return;
  }

  const exported = module.default;

  if (typeof exported !== "object" || exported === null) {
    throw new Error(
      `[vite-plugin-node-env] ${entryDescription} must default-export an object containing a ` +
        `fetch() method (serverType "web"), but its default export is ${describeValue(exported)}. ` +
        `A web entry looks like \`export default { fetch }\`. If it is a node handler, use ` +
        `serverType "node" instead.`,
    );
  }

  const fetch = (exported as { fetch?: unknown }).fetch;

  if (typeof fetch !== "function") {
    throw new Error(
      `[vite-plugin-node-env] ${entryDescription} must default-export an object with a ` +
        `fetch() method (serverType "web"), but \`default.fetch\` is ${describeValue(fetch)}. ` +
        `A web entry looks like \`export default { fetch }\`.`,
    );
  }

  if (fetch.length < 1) {
    throw new Error(
      `[vite-plugin-node-env] ${entryDescription} must default-export a fetch() method that ` +
        `accepts at least 1 argument (the request), but it declares ${fetch.length}.`,
    );
  }
}

function describeValue(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return "an array";
  }

  return `a ${typeof value}`;
}

function serverCliCode(serverType: string, importSource: string) {
  return `
#!/usr/bin/env node

import entry from ${JSON.stringify(importSource)}

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
}

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
  ${isNode ? "return fetchNodeHandler(current, request)" : "return current.fetch(request)"}
}
`;
}

/**
 * Checks that the default export is in the expected shape.
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

/**
 * Finds the server build a framework registered for an environment, so the
 * runnable CLI can import it instead of this plugin's own entry.
 */
function findFrameworkServerBuild(input: EnvironmentBuildInput, root: string): string | undefined {
  if (typeof input === "string") {
    return normalizeServerBuildId(input, root);
  }

  if (input === undefined || Array.isArray(input)) {
    return undefined;
  }

  for (const [key, value] of Object.entries(input)) {
    // Only `cli` is ours in framework mode: this plugin injects no `index`
    // there. A framework is free to use `index` for its own build — Cloudflare's
    // adapter does exactly that — so it must not be skipped.
    if (key === "cli") {
      continue;
    }

    return normalizeServerBuildId(value, root);
  }

  return undefined;
}

/**
 * Prepares a framework's build id for import from the generated CLI.
 */
function normalizeServerBuildId(id: string, root: string): string {
  const withoutNull = id.replace(/^\0/, "");

  if (isAbsolute(withoutNull)) {
    return withoutNull;
  }

  // A scheme longer than one character means a virtual id, not a Windows
  // drive letter.
  if (/^[^/\\:]+:/.test(withoutNull) && !/^[a-zA-Z]:/.test(withoutNull)) {
    return withoutNull;
  }

  return resolvePath(root, withoutNull);
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

  // Captured in configResolved so buildStart can construct a throwaway
  // environment over the real, fully-merged config.
  let fullConfig: ResolvedConfig | undefined;

  // Claims observed on the environment before this plugin injects its own
  // configuration. Reported in configResolved, where the merge outcome is
  // known.
  let foreignDevRuntime = false;

  // Framework mode with `outputRunnableCli: true`: the framework's server
  // build, which the runnable CLI imports. Discovered in `configEnvironment`.
  let frameworkServerBuild: string | undefined;

  // Only generate a CLI in framework mode when the user asked for it
  // explicitly. The default is off there, because the framework normally
  // supplies its own production runner.
  const frameworkCliRequested = !backendMode && opts.outputRunnableCli === true;

  // Build input keys. Deliberately not `entry`: React Router (and other
  // frameworks) use that key for their own server build, and Vite's config
  // merge silently replaces same-name entries, so sharing it would make the
  // two backends clobber each other depending on plugin order.
  const rolldownInputs: Record<string, string> = { index: virtualModuleId };
  if (opts.outputRunnableCli !== false) {
    rolldownInputs.cli = virtualServerId;
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

            // Backend mode owns the environment's build outright. Framework
            // mode (no `entry`) deliberately injects no build configuration:
            // the framework supplies the backend, and a user who wants a
            // runnable entry for it writes a normal `{ fetch }` entry module
            // and passes it as `entry`.
            ...(devOnly
              ? {}
              : backendMode
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

    /**
     * Framework mode, opt-in runnable CLI.
     */
    configEnvironment(name, envConfig) {
      if (name !== environmentName || !frameworkCliRequested) {
        return;
      }

      const build = envConfig.build as Record<string, unknown> | undefined;

      if (!build) {
        return;
      }

      const rolldownOptions = (build.rolldownOptions ?? build.rollupOptions ?? {}) as Record<
        string,
        unknown
      >;

      const input = rolldownOptions.input as EnvironmentBuildInput;

      frameworkServerBuild = findFrameworkServerBuild(input, root);

      if (frameworkServerBuild === undefined) {
        return;
      }

      if (typeof input === "string") {
        rolldownOptions.input = { index: input, cli: virtualServerId };
        return;
      }

      if (input && !Array.isArray(input)) {
        (input as Record<string, string>).cli = virtualServerId;
      }
    },

    /**
     * Validate the entry's shape before the build runs, so a wrong
     * `serverType` fails the build rather than a server that only breaks once
     * started. The module is loaded through Vite's own pipeline, so this works
     * for entries importing CSS, using path aliases, or pulling in framework
     * virtual modules.
     */
    async buildStart() {
      if (!backendMode || devOnly || opts.entry === undefined || fullConfig === undefined) {
        return;
      }

      const entryPath = isAbsolute(opts.entry) ? opts.entry : resolvePath(root, opts.entry);

      // A root-relative id (rather than an absolute path) so the runner
      // resolves the module's own relative imports against the project root.
      const relative = relativePath(root, entryPath).replace(/\\/g, "/");

      await validateServerEntry(
        fullConfig,
        relative.startsWith(".") ? relative : `./${relative}`,
        serverType,
        `The backend entry ${JSON.stringify(opts.entry)}`,
      );
    },

    buildApp: {
      order: "post",

      async handler(builder) {
        // devOnly hands the build entirely to whoever owns the environment.
        // Framework mode normally builds nothing of its own; it only builds
        // when an opt-in runnable CLI was injected above.
        if (devOnly || (!backendMode && !frameworkCliRequested)) {
          return;
        }

        const environment = builder.environments[environmentName];

        if (!environment) {
          throw new Error(`Environment "${environmentName}" does not exist`);
        }

        // Build only if nothing else (e.g. a framework's buildApp) already
        // built this environment. When a framework did, the CLI is part of
        // that build already, since it shares the same merged input.
        if (!environment.isBuilt) {
          await builder.build(environment);
        }
      },
    },

    configResolved(resolvedConfig) {
      root = resolvedConfig.root;
      command = resolvedConfig.command;
      fullConfig = resolvedConfig;
      const logger = resolvedConfig.logger;
      const environment = readEnvironmentConfig(resolvedConfig, environmentName);

      if (backendMode && !devOnly) {
        const clobbered = findClobberedInputEntries(getBuildInput(environment), rolldownInputs);

        if (clobbered.length > 0) {
          logger.warn(
            `[vite-plugin-node-env] This plugin's build entries for the "${environmentName}" environment ` +
              `(${clobbered.map((key) => `"${key}"`).join(", ")}) were replaced by an existing build input ` +
              `from the user config or another plugin, so the backend may not be built. ` +
              `Vite's config merge silently replaces same-name entries depending on plugin order. ` +
              `Move the backend to its own environment via opts.environment, or add { devOnly: true } to let ` +
              `the other plugin own the build.`,
          );
        }
      }

      const createEnvironment = environment?.dev?.createEnvironment;

      // In entry-less mode this plugin has no user entry to run, so its dev
      // runtime is only an offer. A framework owning the environment instead is
      // the intended arrangement, not a conflict, so staying silent is correct.
      // The comparison still has to happen unconditionally: it is what
      // distinguishes "lost the merge" from "won the merge" below.
      if (createEnvironment !== undefined && createEnvironment !== createDevEnvironmentFn) {
        if (backendMode) {
          logger.warn(
            `[vite-plugin-node-env] Another plugin replaced the dev runtime (dev.createEnvironment) for the "${environmentName}" environment; this plugin's worker runtime was overridden by config merge order. ` +
              `Pick an environment name not owned by the other plugin via opts.environment.`,
          );
        }
      } else if (foreignDevRuntime) {
        logger.warn(
          `[vite-plugin-node-env] Another plugin also configures dev.createEnvironment for the "${environmentName}" environment. ` +
            `This plugin's worker runtime won by config merge order and the other plugin's dev runtime is unused.`,
        );
      }

      // srvx is checked here rather than in buildStart so a dev session fails with the
      // same clear message instead of a bundler error surfaced later from the
      // generated module.
      const emitsBuildCode = command === "build" && !devOnly;
      const cliGenerated =
        emitsBuildCode && (backendMode ? opts.outputRunnableCli !== false : frameworkCliRequested);
      const nodeWrapper = backendMode && serverType === "node" && !(devOnly && command === "build");

      if (cliGenerated || nodeWrapper) {
        const reasons: string[] = [];

        if (cliGenerated) {
          reasons.push("the runnable CLI imports srvx");
        }

        if (nodeWrapper) {
          reasons.push('serverType "node" wraps the entry with srvx/node');
        }

        assertSrvxIsResolvable(root, reasons);
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
          // In framework mode the CLI serves the framework's own server build
          // (opt-in). In backend mode it serves this plugin's entry.
          if (!backendMode && frameworkServerBuild === undefined) {
            throw new Error(
              `The runnable CLI was requested in framework mode, but no server build was ` +
                `found for the "${environmentName}" environment. Set ` +
                `{ outputRunnableCli: true } only when that build default-exports ` +
                `\`{ fetch }\` (or a bare handler for serverType: "node").`,
            );
          }

          return serverCliCode(serverType, frameworkServerBuild ?? virtualModuleId);
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

// Must match the `index` build input key; preview loads the built backend from
// the environment's outDir by this name.
const serverEntryFileName = "index.js";

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
