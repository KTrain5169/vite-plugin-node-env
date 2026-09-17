import { isRunnableDevEnvironment, type Plugin } from "vite";

interface PluginOptions {
  entry: string;
  environment?: string;
}

export interface NodeApp {
  fetch(req: Request): Response | Promise<Response>;
}

const virtualModuleId = "virtual:vite-plugin-node";
const resolvedVirtualModuleId = `\0${virtualModuleId}`;

export function node(opts: PluginOptions): Plugin {
  const environmentName = opts.environment ?? "server";
  return {
    name: "vite-plugin-node",

    config() {
      return {
        environments: {
          [environmentName]: {},
        },
      };
    },

    resolveId(id) {
      if (id === virtualModuleId) {
        return resolvedVirtualModuleId;
      }
    },

    load: {
      filter: {
        id: resolvedVirtualModuleId,
      },

      async handler(id) {
        if (id !== resolvedVirtualModuleId) {
          return;
        }

        const resolved = await this.resolve(opts.entry);

        if (!resolved) {
          throw new Error(`Could not resolve backend entry: ${opts.entry}`);
        }

        const entryId = resolved.id;

        return `
import * as entry from ${JSON.stringify(entryId)}

let current = entry.default

if (
  !current ||
  typeof current.fetch !== 'function'
) {
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

    applyToEnvironment(environment) {
      return environment.name === environmentName;
    },

    async configureServer(server) {
      const environment = server.environments[environmentName];

      if (!isRunnableDevEnvironment(environment)) {
        throw new Error("Specified environment is not a runnable dev environment");
      }

      const app = await environment.runner.import(opts.entry);

      if (typeof app.fetch !== "function") {
        throw new Error("Backend runtime did not expose a fetch() handler");
      }

      this.info("Backend loaded");
    },
  };
}
