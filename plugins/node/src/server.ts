import { Worker } from "node:worker_threads";
import { type ResolvedConfig, DevEnvironment, type HotChannel, type HotPayload } from "vite";
import {
  type CreateDevEnvironmentContext,
  type NodeRuntime,
  virtualModuleId,
  type ResponseMessage,
  type ReadyMessage,
  type WorkerResponse,
  type RequestMessage,
} from "./consts.ts";

export function createNodeEnvironment(
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

export async function serializeRequest(
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

export function getFirstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}
