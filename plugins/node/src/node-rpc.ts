import type { MessagePort } from "node:worker_threads";
import { EvaluatedModules, type ModuleRunner } from "vite/module-runner";

/**
 * RPC protocol between the Vite main process and the Node worker.
 *
 * The worker owns the {@link ModuleRunner} that evaluates modules. The
 * main process (usually a framework plugin's dev middleware) drives it via
 * `environment.runner.import()`, which proxies through this protocol:
 * module imports are performed by the worker and their exports are
 * described back to the main process, where exported functions become
 * callable stubs and calls are dispatched back into the worker.
 *
 * Values crossing the boundary are deep-walked: functions become callable
 * references (in both directions), `Request`/`Response` objects are
 * serialized with buffered bodies, plain objects/arrays are walked, and
 * everything else must be structured-cloneable.
 *
 * The protocol runs on a dedicated `MessagePort`, separate from the hot
 * channel (module fetching/HMR) and the backend request channel.
 */

export type RpcSide = "main" | "worker";

const FN_KIND = "__vite-plugin-node-env:fn";
const REQUEST_KIND = "__vite-plugin-node-env:request";
const RESPONSE_KIND = "__vite-plugin-node-env:response";

const CIRCULAR_ERROR =
  "vite-plugin-node-env: circular value cannot cross the worker boundary (wrap it in a function export instead)";

export interface RpcSerializedError {
  name: string;
  message: string;
  stack?: string;
}

interface RpcReadyMessage {
  type: "ready";
}

interface RpcImportMessage {
  type: "import";
  /** The side that initiated the request. */
  from: RpcSide;
  id: number;
  moduleId: string;
}

interface RpcCallMessage {
  type: "call";
  from: RpcSide;
  id: number;
  /** Reference to a function provided by the receiving side. */
  ref: number;
  args: unknown[];
}

interface RpcResultMessage {
  type: "result";
  from: RpcSide;
  id: number;
  value: unknown;
}

interface RpcErrorMessage {
  type: "error";
  from: RpcSide;
  id: number;
  error: RpcSerializedError;
}

export type RpcMessage =
  | RpcReadyMessage
  | RpcImportMessage
  | RpcCallMessage
  | RpcResultMessage
  | RpcErrorMessage;

interface FnMarker {
  kind: typeof FN_KIND;
  ref: number;
}

interface RequestMarker {
  kind: typeof REQUEST_KIND;
  method: string;
  url: string;
  headers: [string, string][];
  body?: ArrayBuffer;
}

interface ResponseMarker {
  kind: typeof RESPONSE_KIND;
  status: number;
  statusText: string;
  headers: [string, string][];
  body?: ArrayBuffer;
}

type RpcMarker = FnMarker | RequestMarker | ResponseMarker;

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

export function serializeError(error: unknown): RpcSerializedError {
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

export function reconstructError(error: RpcSerializedError): Error {
  const result = new Error(error.message);

  result.name = error.name;

  if (error.stack) {
    result.stack = error.stack;
  }

  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

export class RpcPeer {
  readonly port: MessagePort;
  readonly side: RpcSide;

  /**
   * Set by the worker side to handle `import` requests coming from the main
   * process. Points at the worker's `ModuleRunner.import`.
   */
  onImport?: (moduleId: string) => Promise<unknown>;

  private provided = new Map<number, Function>();
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();

  private nextRefId = 0;
  private nextRequestId = 0;

  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;

  readonly ready: Promise<void> = new Promise<void>((resolve, reject) => {
    this.resolveReady = resolve;
    this.rejectReady = reject;
  });

  private closed = false;

  constructor(port: MessagePort, side: RpcSide) {
    this.port = port;
    this.side = side;

    port.on("message", (message: RpcMessage) => {
      this.handle(message);
    });
  }

  /**
   * Start receiving messages and (on the worker side) announce readiness.
   *
   * The worker is ready as soon as it starts listening, so it resolves its own
   * `ready` promise locally. The main side resolves it when the worker's
   * announcement arrives.
   */
  start(): void {
    this.port.start();

    if (this.side === "worker") {
      this.resolveReady();
      this.port.postMessage({ type: "ready" } satisfies RpcReadyMessage);
    }
  }

  isClosed(): boolean {
    return this.closed;
  }

  /**
   * Reject everything in-flight. Used when the worker dies or the dev
   * server shuts down.
   */
  destroy(error: Error): void {
    if (this.closed) {
      return;
    }

    this.closed = true;

    this.rejectReady(error);

    for (const { reject } of this.pending.values()) {
      reject(error);
    }

    this.pending.clear();

    this.port.close();
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;

    this.resolveReady();

    this.port.close();
  }

  /**
   * Import a module in the worker and get back its (proxied) exports.
   */
  async importModule<T = unknown>(moduleId: string): Promise<T> {
    await this.ready;

    const value = await this.send({ type: "import", moduleId });

    return this.hydrate(value) as T;
  }

  /**
   * Call a function provided by the other side.
   */
  async call(ref: number, args: unknown[]): Promise<unknown> {
    await this.ready;

    const serializedArgs: unknown[] = [];

    for (const arg of args) {
      serializedArgs.push(await this.serialize(arg));
    }

    const value = await this.send({ type: "call", ref, args: serializedArgs });

    return this.hydrate(value);
  }

  private send(
    message: DistributiveOmit<RpcImportMessage | RpcCallMessage, "from" | "id">,
  ): Promise<unknown> {
    const id = ++this.nextRequestId;

    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });

      const payload = { ...message, from: this.side, id } as RpcMessage;

      try {
        this.port.postMessage(payload);
      } catch (error) {
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }

  private handle(message: RpcMessage): void {
    if (typeof message !== "object" || message === null) {
      return;
    }

    switch (message.type) {
      case "ready": {
        this.resolveReady();
        return;
      }

      case "result":
      case "error": {
        // Only results for requests initiated by this side.
        if (message.from !== this.side) {
          return;
        }

        const pending = this.pending.get(message.id);

        if (!pending) {
          return;
        }

        this.pending.delete(message.id);

        if (message.type === "error") {
          pending.reject(reconstructError(message.error));
        } else {
          pending.resolve(message.value);
        }

        return;
      }

      case "call": {
        if (message.from === this.side) {
          return;
        }

        void this.handleCall(message);
        return;
      }

      case "import": {
        if (this.onImport) {
          void this.handleImport(message);
        }

        return;
      }
    }
  }

  private async handleCall(message: RpcCallMessage): Promise<void> {
    const fn = this.provided.get(message.ref);

    if (!fn) {
      this.respondError(message, new TypeError(`Unknown function reference ${message.ref}`));
      return;
    }

    try {
      const args = message.args.map((arg) => this.hydrate(arg));

      const result = await fn(...args);

      const value = await this.serialize(result);

      this.port.postMessage({
        type: "result",
        from: message.from,
        id: message.id,
        value,
      } satisfies RpcResultMessage);
    } catch (error) {
      this.respondError(message, error);
    }
  }

  private async handleImport(message: RpcImportMessage): Promise<void> {
    try {
      const module = await this.onImport!(message.moduleId);

      const value = await this.serialize(module);

      this.port.postMessage({
        type: "result",
        from: message.from,
        id: message.id,
        value,
      } satisfies RpcResultMessage);
    } catch (error) {
      this.respondError(message, error);
    }
  }

  private respondError(message: RpcImportMessage | RpcCallMessage, error: unknown): void {
    this.port.postMessage({
      type: "error",
      from: message.from,
      id: message.id,
      error: serializeError(error),
    } satisfies RpcErrorMessage);
  }

  private async serialize(value: unknown, seen: Set<object> = new Set()): Promise<unknown> {
    if (typeof value === "function") {
      const ref = ++this.nextRefId;

      this.provided.set(ref, value);

      return { kind: FN_KIND, ref } satisfies FnMarker;
    }

    if (value instanceof Request) {
      return {
        kind: REQUEST_KIND,
        method: value.method,
        url: value.url,
        headers: [...value.headers] as [string, string][],
        body: value.body !== null ? await value.arrayBuffer() : undefined,
      } satisfies RequestMarker;
    }

    if (value instanceof Response) {
      return {
        kind: RESPONSE_KIND,
        status: value.status,
        statusText: value.statusText,
        headers: [...value.headers] as [string, string][],
        body: value.body !== null ? await value.arrayBuffer() : undefined,
      } satisfies ResponseMarker;
    }

    if (Array.isArray(value)) {
      if (seen.has(value)) {
        throw new Error(CIRCULAR_ERROR);
      }

      // Each branch tracks its own ancestor path so shared (non-circular)
      // references are still serialized.
      const tracked = new Set(seen);

      tracked.add(value);

      const out: unknown[] = [];

      for (const item of value) {
        out.push(await this.serialize(item, tracked));
      }

      return out;
    }

    if (isPlainObject(value)) {
      if (seen.has(value)) {
        throw new Error(CIRCULAR_ERROR);
      }

      const tracked = new Set(seen);

      tracked.add(value);

      const out: Record<string, unknown> = {};

      for (const [key, item] of Object.entries(value)) {
        out[key] = await this.serialize(item, tracked);
      }

      return out;
    }

    return value;
  }

  private hydrate(value: unknown): unknown {
    if (typeof value !== "object" || value === null) {
      return value;
    }

    const marker = this.hydrateMarker(value);

    if (marker !== undefined) {
      return marker;
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.hydrate(item));
    }

    if (isPlainObject(value)) {
      const out: Record<string, unknown> = {};

      for (const [key, item] of Object.entries(value)) {
        out[key] = this.hydrate(item);
      }

      return out;
    }

    return value;
  }

  /**
   * Reconstructs a marker (function stub, `Request`, `Response`) or returns
   * `undefined` when the value is not a marker.
   */
  private hydrateMarker(value: object): unknown {
    const marker = value as RpcMarker;

    switch (marker.kind) {
      case FN_KIND: {
        if (typeof marker.ref !== "number") {
          return undefined;
        }

        const { ref } = marker;

        return (...args: unknown[]) => this.call(ref, args);
      }

      case REQUEST_KIND: {
        const { method, url, headers, body } = marker;

        return new Request(url, {
          method,
          headers: new Headers(headers),
          ...(body !== undefined ? { body, duplex: "half" } : {}),
        });
      }

      case RESPONSE_KIND: {
        const { status, statusText, headers, body } = marker;

        return new Response(body, {
          status,
          statusText,
          headers: new Headers(headers),
        });
      }
    }

    return undefined;
  }
}

/**
 * A `ModuleRunner` whose module evaluation happens inside the Node worker.
 * Used by the runtime-provider mode so framework dev middleware can drive
 * server-side rendering through `environment.runner.import()`.
 */
export class WorkerProxyModuleRunner {
  readonly evaluatedModules: EvaluatedModules = new EvaluatedModules();

  private readonly peer: RpcPeer;

  constructor(peer: RpcPeer) {
    this.peer = peer;
  }

  import<T = unknown>(url: string): Promise<T> {
    return this.peer.importModule<T>(url);
  }

  // The evaluated module cache lives inside the worker's own ModuleRunner.
  clearCache(): void {}

  async close(): Promise<void> {
    this.peer.close();
  }

  isClosed(): boolean {
    return this.peer.isClosed();
  }
}

export function createWorkerProxyModuleRunner(peer: RpcPeer): ModuleRunner {
  return new WorkerProxyModuleRunner(peer) as unknown as ModuleRunner;
}
