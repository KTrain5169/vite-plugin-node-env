import { parentPort, workerData, type MessagePort } from "node:worker_threads";

import { ESModulesEvaluator, ModuleRunner, createNodeImportMeta } from "vite/module-runner";

interface BackendRuntime {
  fetch(request: Request): Response | Promise<Response>;
}

interface RequestMessage {
  type: "request";
  id: number;
  method: string;
  url: string;
  headers: [string, string][];
  body?: ArrayBuffer;
}

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

const runner = new ModuleRunner(
  {
    transport: hotTransport,
    createImportMeta: createNodeImportMeta,
  },
  new ESModulesEvaluator(),
);

const runtime = await runner.import<BackendRuntime>(workerData.runtime);

if (typeof runtime.fetch !== "function") {
  throw new TypeError("Backend runtime does not expose fetch()");
}

const requestPort = workerData.requestPort as MessagePort;

requestPort.on("message", async (message: RequestMessage) => {
  if (message.type !== "request") {
    return;
  }

  try {
    const request = createRequest(message);
    const response = await runtime.fetch(request);

    const body = response.body === null ? undefined : await response.arrayBuffer();

    const result = {
      type: "response" as const,
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
    requestPort.postMessage({
      type: "error",
      id: message.id,
      error: serializeError(error),
    });
  }
});

requestPort.start();

// The main thread listens for "ready" on requestPort, not parentPort.
requestPort.postMessage({
  type: "ready",
});

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

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return {
    name: "Error",
    message: String(error),
  };
}
