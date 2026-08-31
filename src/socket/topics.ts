import log from "../modules/logger.ts";

const subscriptions = new Map<string, Set<any>>();

export const topicBus = {
  subscribe(topic: string, connection: any): void {
    if (!subscriptions.has(topic)) {
      subscriptions.set(topic, new Set());
    }
    subscriptions.get(topic)!.add(connection);
  },

  unsubscribe(topic: string, connection: any): void {
    const subscribers = subscriptions.get(topic);
    if (subscribers) {
      subscribers.delete(connection);
    }
  },

  publish(topic: string, payload: Uint8Array): void {
    const subscribers = subscriptions.get(topic);
    if (!subscribers) return;

    for (const connection of subscribers) {
      try {
        connection.send(payload);
      } catch (error: any) {
        log.debug(`Topic publish to connection failed: ${error?.message || error}`);
      }
    }
  },

  /**
   * Like publish, but delivers as unreliable datagrams (fire-and-forget).
   * Use for loss-tolerant status fan-outs (e.g. CONNECTION_COUNT) so a
   * per-second broadcast to every player doesn't contend for the reliable
   * stream's ordering queue at 1000+ connections.
   */
  publishBestEffort(topic: string, payload: Uint8Array): void {
    const subscribers = subscriptions.get(topic);
    if (!subscribers) return;

    for (const connection of subscribers) {
      try {
        if (typeof connection.sendBestEffort === "function") {
          connection.sendBestEffort(payload);
        } else {
          connection.send(payload);
        }
      } catch (error: any) {
        log.debug(`Best-effort topic publish to connection failed: ${error?.message || error}`);
      }
    }
  },

  clear(connection: any): void {
    for (const subscribers of subscriptions.values()) {
      subscribers.delete(connection);
    }
  },
};
