import { MessageChannel, Worker } from "node:worker_threads";
import {
  type NodeRuntime,
  type RequestMessage,
  type ResponseMessage,
  type ReadyMessage,
  type WorkerResponse,
} from "./consts.ts";

export interface NodeRuntimeOptions {
  entry: string;
  mode: "dev" | "preview";
}

export interface NodeRuntimeHost {
  worker: Worker;
  runtime: NodeRuntime;
}

export function createNodeRuntime(options: NodeRuntimeOptions): NodeRuntimeHost {
  const { port1: requestServerPort, port2: requestWorkerPort } = new MessageChannel();

  const worker = new Worker(new URL("./node-worker.mjs", import.meta.url), {
    workerData: {
      mode: options.mode,
      runtime: options.entry,
      requestPort: requestWorkerPort,
    },

    transferList: [requestWorkerPort],
  });

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
    if (code !== 0) {
      workerFailed(new Error(`Backend worker exited with code ${code}`));
    }
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

  return {
    worker,
    runtime,
  };
}
