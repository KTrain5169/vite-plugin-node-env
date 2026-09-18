import { DevEnvironment, type ResolvedConfig } from "vite";

import { createNodeRuntime } from "./node-runtime.ts";

import { createNodeHotChannel } from "./node-hot-channel.ts";

import {
  virtualModuleId,
  type CreateDevEnvironmentContext,
  type NodeRuntime,
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
  const node = createNodeRuntime({
    entry: virtualModuleId,
    mode: "dev",
  });

  const environment = new DevEnvironment(name, config, {
    ...context,
    hot: true,
    transport: createNodeHotChannel(node.worker),
  });

  return {
    environment,
    runtime: node.runtime,
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
