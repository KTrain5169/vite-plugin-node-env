import { parentPort, workerData, type MessagePort } from "node:worker_threads";
import { pathToFileURL } from "node:url";

import { ESModulesEvaluator, ModuleRunner, createNodeImportMeta } from "vite/module-runner";

import type { RequestMessage, ResponseMessage, WorkerResponse } from "./consts.ts";
import { RpcPeer, serializeError } from "./node-rpc.ts";

interface BackendRuntime {
  fetch(request: Request): Response | Promise<Response>;
}

interface WorkerData {
  mode: "dev" | "preview";
  /** Backend mode: module id (dev) or built entry file path (preview). */
  runtime?: string;
  /** Backend mode request channel. */
  requestPort?: MessagePort;
  /** Runtime-provider mode RPC channel. */
  rpcPort?: MessagePort;
}

const data = workerData as WorkerData;

let runner: ModuleRunner | undefined;

if (data.mode === "dev") {
  const hotTransport = {
    connect({
      onMessage,
      onDisconnection,
    }: {
      onMessage: (data: unknown) => void;
      onDisconnection: () => void;
    }) {
      parentPort!.on("message", onMessage);

      parentPort!.on("close", onDisconnection);
    },

    send(data: unknown) {
      parentPort!.postMessage(data);
    },
  };

  runner = new ModuleRunner(
    {
      transport: hotTransport,
      createImportMeta: createNodeImportMeta,
    },
    new ESModulesEvaluator(),
  );
}

//
// Backend mode: eagerly import the entry and serve requests over the
// request channel.
//

if (data.requestPort && data.runtime) {
  const requestPort = data.requestPort;

  let runtime: BackendRuntime;

  if (data.mode === "dev" && runner) {
    runtime = await runner.import<BackendRuntime>(data.runtime);
  } else {
    const module = await import(pathToFileURL(data.runtime).href);

    runtime = module as BackendRuntime;
  }

  if (typeof runtime.fetch !== "function") {
    throw new TypeError("Backend runtime does not export a fetch() function");
  }

  requestPort.on("message", async (message: RequestMessage) => {
    if (message.type !== "request") {
      return;
    }

    try {
      const request = createRequest(message);

      const response = await runtime.fetch(request);

      const body = response.body === null ? undefined : await response.arrayBuffer();

      const result: ResponseMessage = {
        type: "response",
        id: message.id,
        status: response.status,
        statusText: response.statusText,
        headers: [...response.headers] as [string, string][],
        body,
      };

      if (body) {
        requestPort.postMessage(result, [body]);
      } else {
        requestPort.postMessage(result);
      }
    } catch (error) {
      const result: WorkerResponse = {
        type: "error",
        id: message.id,
        error: serializeError(error),
      };

      requestPort.postMessage(result);
    }
  });

  requestPort.start();

  requestPort.postMessage({
    type: "ready",
  });
}

//
// Runtime-provider mode: no entry of our own. Handle module imports coming
// from the main process (usually a framework plugin's dev middleware
// driving `environment.runner.import()`), evaluating them with the runner
// above and proxying their exports back.
//

if (data.rpcPort) {
  const peer = new RpcPeer(data.rpcPort, "worker");

  if (runner) {
    peer.onImport = (moduleId) => runner!.import(moduleId);
  }

  peer.start();
}

function createRequest(message: RequestMessage): Request {
  const headers = new Headers(message.headers);

  const hasBody = message.method !== "GET" && message.method !== "HEAD";

  return new Request(message.url, {
    method: message.method,
    headers,
    body: hasBody ? message.body : undefined,
    ...(hasBody ? { duplex: "half" } : {}),
  });
}
