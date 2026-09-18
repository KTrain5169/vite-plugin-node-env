import type { WebSocketServer } from "vite";

export interface PluginOptions {
  entry: string;
  environment?: string;
  serverType?: "node" | "web";
}

export interface RequestMessage {
  type: "request";
  id: number;
  method: string;
  url: string;
  headers: [string, string][];
  body?: ArrayBuffer;
}

export interface ResponseMessage {
  type: "response";
  id: number;
  status: number;
  statusText: string;
  headers: [string, string][];
  body?: ArrayBuffer;
}

export interface ErrorMessage {
  type: "error";
  id: number;
  error: {
    name: string;
    message: string;
    stack?: string;
  };
}

export interface ReadyMessage {
  type: "ready";
}

export type WorkerResponse = ResponseMessage | ErrorMessage;

// Matches Vite's internal (non-exported) CreateDevEnvironmentContext shape.
export interface CreateDevEnvironmentContext {
  ws: WebSocketServer;
}

export const virtualModuleId = "virtual:vite-plugin-node-env";
export const resolvedVirtualModuleId: string = `\0${virtualModuleId}`;

export interface NodeRuntime {
  request(message: Omit<RequestMessage, "id" | "type">): Promise<ResponseMessage>;

  close(): Promise<void>;
}
