import { MessageChannel, Worker } from "node:worker_threads";
import { isAbsolute, resolve as resolvePath } from "node:path";
import {
  DevEnvironment,
  type HotChannel,
  type HotPayload,
  type Plugin,
  type ResolvedConfig,
  type WebSocketServer,
} from "vite";
import { exactRegex } from "@rolldown/pluginutils";

export interface NodeApp {
  fetch(request: Request): Response | Promise<Response>;
}

interface PluginOptions {
  entry: string;
  environment?: string;
}

interface RequestMessage {
  type: "request";
  id: number;
  method: string;
  url: string;
  headers: [string, string][];
  body?: ArrayBuffer;
}

interface ResponseMessage {
  type: "response";
  id: number;
  status: number;
  statusText: string;
  headers: [string, string][];
  body?: ArrayBuffer;
}

interface ErrorMessage {
  type: "error";
  id: number;
  error: {
    name: string;
    message: string;
    stack?: string;
  };
}

interface ReadyMessage {
  type: "ready";
}

type WorkerResponse = ResponseMessage | ErrorMessage;

// Matches Vite's internal (non-exported) CreateDevEnvironmentContext shape.
interface CreateDevEnvironmentContext {
  ws: WebSocketServer;
}

const virtualModuleId = "virtual:vite-plugin-node";
const resolvedVirtualModuleId = `\0${virtualModuleId}`;

interface NodeRuntime {
  request(message: Omit<RequestMessage, "id" | "type">): Promise<ResponseMessage>;

  close(): Promise<void>;
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

function createNodeEnvironment(
  name: string,
  config: ResolvedConfig,
  context: CreateDevEnvironmentContext,
): {
  environment: DevEnvironment;
  runtime: NodeRuntime;
} {
  const { port1: requestServerPort, port2: requestWorkerPort } = new MessageChannel();

  const worker = new Worker(new URL("./node-worker.mjs", import.meta.url), {
    workerData: {
      runtime: virtualModuleId,
      requestPort: requestWorkerPort,
    },
    transferList: [requestWorkerPort],
  });

  const workerHotChannel: HotChannel = {
    skipFsCheck: true,

    send(data: HotPayload) {
      worker.postMessage(data);
    },

    on(event: string, handler: (...args: any[]) => void) {
      // This worker is permanently connected.
      if (event === "vite:client:connect") {
        return;
      }

      if (event === "vite:client:disconnect") {
        const listener = () => {
          handler(undefined, client);
        };

        handlerToWorkerListener.set(handler, listener);

        worker.on("exit", listener);

        return;
      }

      const listener = (value: unknown) => {
        if (
          typeof value === "object" &&
          value !== null &&
          "type" in value &&
          value.type === "custom" &&
          "event" in value &&
          value.event === event
        ) {
          handler("data" in value ? value.data : undefined, client);
        }
      };

      handlerToWorkerListener.set(handler, listener);

      worker.on("message", listener);
    },

    off(event, handler) {
      if (event === "vite:client:connect") {
        return;
      }

      if (event === "vite:client:disconnect") {
        const listener = handlerToWorkerListener.get(handler);

        if (listener) {
          worker.off("exit", listener);
          handlerToWorkerListener.delete(handler);
        }

        return;
      }

      const listener = handlerToWorkerListener.get(handler);

      if (listener) {
        worker.off("message", listener);
        handlerToWorkerListener.delete(handler);
      }
    },
  };

  const client = {
    send(data: HotPayload) {
      worker.postMessage(data);
    },
  };

  const handlerToWorkerListener = new WeakMap<Function, (...args: any[]) => void>();

  let nextRequestId = 0;

  const pending = new Map<
    number,
    {
      resolve: (response: ResponseMessage) => void;

      reject: (error: Error) => void;
    }
  >();

  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;

  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  requestServerPort.on("message", (message: ReadyMessage | WorkerResponse) => {
    if (message.type === "ready") {
      resolveReady();
      return;
    }

    const pendingRequest = pending.get(message.id);

    if (!pendingRequest) {
      return;
    }

    pending.delete(message.id);

    if (message.type === "error") {
      const error = new Error(message.error.message);

      error.name = message.error.name;

      if (message.error.stack) {
        error.stack = message.error.stack;
      }

      pendingRequest.reject(error);
      return;
    }

    pendingRequest.resolve(message);
  });

  const workerFailed = (error: Error) => {
    rejectReady(error);

    for (const { reject } of pending.values()) {
      reject(error);
    }

    pending.clear();
  };

  worker.on("error", workerFailed);

  worker.on("exit", (code) => {
    if (code === 0) {
      return;
    }

    workerFailed(new Error(`Backend worker exited with code ${code}`));
  });

  const runtime: NodeRuntime = {
    async request(message) {
      await ready;

      const id = ++nextRequestId;

      return new Promise<ResponseMessage>((resolve, reject) => {
        pending.set(id, {
          resolve,
          reject,
        });

        const payload: RequestMessage = {
          ...message,
          type: "request",
          id,
        };

        if (payload.body) {
          requestServerPort.postMessage(payload, [payload.body]);
        } else {
          requestServerPort.postMessage(payload);
        }
      });
    },

    async close() {
      requestServerPort.close();
      await worker.terminate();
    },
  };

  const environment = new DevEnvironment(name, config, {
    ...context,
    hot: true,
    transport: workerHotChannel,
  });

  return {
    environment,
    runtime,
  };
}

async function serializeRequest(
  req: import("node:http").IncomingMessage,
): Promise<Omit<RequestMessage, "id" | "type">> {
  const headers: [string, string][] = [];

  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.push([name, item]);
      }
    } else if (value !== undefined) {
      headers.push([name, value]);
    }
  }

  const method = req.method ?? "GET";

  let body: ArrayBuffer | undefined;

  if (method !== "GET" && method !== "HEAD") {
    const chunks: Buffer[] = [];

    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const buffer = Buffer.concat(chunks);

    body = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }

  const protocol = getFirstHeader(req.headers["x-forwarded-proto"]) ?? "http";

  const host = req.headers.host ?? "localhost";

  const url = new URL(req.url ?? "/", `${protocol}://${host}`).toString();

  return {
    method,
    url,
    headers,
    body,
  };
}

function getFirstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}
