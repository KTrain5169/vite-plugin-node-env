import type { HotChannel, HotPayload } from "vite";
import type { Worker } from "node:worker_threads";

export function createNodeHotChannel(worker: Worker): HotChannel {
  const handlerToWorkerListener = new WeakMap<Function, (...args: any[]) => void>();

  const client = {
    send(data: HotPayload) {
      worker.postMessage(data);
    },
  };

  return {
    skipFsCheck: true,

    send(data: HotPayload) {
      worker.postMessage(data);
    },

    on(event: string, handler: (...args: any[]) => void) {
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
          typeof value !== "object" ||
          value === null ||
          !("type" in value) ||
          value.type !== "custom" ||
          !("event" in value) ||
          value.event !== event
        ) {
          return;
        }

        handler("data" in value ? value.data : undefined, client);
      };

      handlerToWorkerListener.set(handler, listener);

      worker.on("message", listener);
    },

    off(event, handler) {
      if (event === "vite:client:connect") {
        return;
      }

      const listener = handlerToWorkerListener.get(handler);

      if (!listener) {
        return;
      }

      if (event === "vite:client:disconnect") {
        worker.off("exit", listener);
      } else {
        worker.off("message", listener);
      }

      handlerToWorkerListener.delete(handler);
    },
  };
}
