import type { StreamEvent } from "../shared/types";

type Handler = (event: StreamEvent) => void;

export class ThreadEventBus {
  private readonly handlersByThread = new Map<string, Set<Handler>>();

  subscribe(threadId: string, handler: Handler): () => void {
    const handlers = this.handlersByThread.get(threadId) ?? new Set<Handler>();
    handlers.add(handler);
    this.handlersByThread.set(threadId, handlers);

    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.handlersByThread.delete(threadId);
      }
    };
  }

  publish(event: StreamEvent): void {
    const handlers = this.handlersByThread.get(event.threadId);
    if (!handlers) {
      return;
    }

    for (const handler of handlers) {
      handler(event);
    }
  }
}
