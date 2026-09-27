import type { WebSocketServer } from "vite";

export interface PluginOptions {
  /**
   * Entry module for the backend. Must default-export a fetch-style handler
   * (see `serverType`).
   *
   * When omitted, the plugin does not run an entry of its own and instead
   * only provides the dev runtime for the configured environment. This is
   * useful with frameworks: assign the plugin to the framework's `ssr`
   * environment and the framework's dev middleware drives server-side
   * rendering through `environment.runner.import()`, with module evaluation
   * happening inside the plugin's Node worker.
   */
  entry?: string;
  environment?: string;
  serverType?: "node" | "web";
  external?: string[];
  outputRunnableCli?: boolean;
  /**
   * Skip all build and preview configuration for the target environment
   * (no injected build entries, no outDir, no CLI output, no preview
   * middleware). The environment's build is owned by something else, usually
   * a framework plugin (e.g. TanStack Start, SolidStart v2). The plugin
   * still provides the dev runtime and its request-handling middleware.
   *
   * Requires `entry`.
   */
  devOnly?: boolean;
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

export const virtualServerId = "virtual:vite-plugin-node-env/server";
export const resolvedVirtualServerId: string = `\0${virtualServerId}`;

export const virtualModuleId = "virtual:vite-plugin-node-env/module";
export const resolvedVirtualModuleId: string = `\0${virtualModuleId}`;

export interface NodeRuntime {
  request(message: Omit<RequestMessage, "id" | "type">): Promise<ResponseMessage>;

  close(): Promise<void>;
}
