import { expect, test } from "bun:test";

// Mock EventEmitter
type EventCallback = (...args: any[]) => void;

const eventListeners: Record<string, EventCallback[]> = {};

const mockEventEmitter = {
  on: function (event: string, callback: EventCallback) {
    if (!eventListeners[event]) {
      eventListeners[event] = [];
    }
    eventListeners[event].push(callback);
    return this;
  },
  emit: function (event: string, ...args: any[]) {
    if (eventListeners[event]) {
      eventListeners[event].forEach((callback) => {
        callback(...args);
      });
    }
    return this;
  },
  off: function (event: string, callback: EventCallback) {
    if (eventListeners[event]) {
      eventListeners[event] = eventListeners[event].filter((cb) => cb !== callback);
    }
    return this;
  },
};

const event = mockEventEmitter as any;
const listener = mockEventEmitter as any;

test("event.on registers listener", () => {
  const callback = () => {};
  event.on("test_event", callback);
  expect(eventListeners["test_event"]).toContain(callback);
});

test("event.emit triggers listeners", () => {
  let triggered = false;
  const callback = () => {
    triggered = true;
  };
  event.on("trigger_test", callback);
  event.emit("trigger_test");
  expect(triggered).toBe(true);
});

test("event.emit passes arguments to listeners", () => {
  let receivedArg: any = null;
  const callback = (arg: any) => {
    receivedArg = arg;
  };
  event.on("arg_test", callback);
  event.emit("arg_test", "test_value");
  expect(receivedArg).toBe("test_value");
});

test("event.off removes listener", () => {
  const callback = () => {};
  event.on("remove_test", callback);
  event.off("remove_test", callback);
  expect(eventListeners["remove_test"]).not.toContain(callback);
});

test("listener.on registers listener", () => {
  const callback = () => {};
  listener.on("listener_test", callback);
  expect(eventListeners["listener_test"]).toBeDefined();
});

test("event.on returns event emitter for chaining", () => {
  const result = event.on("chain_test", () => {});
  expect(result).toBe(event);
});

test("listener.emit triggers listeners", () => {
  let triggered = false;
  const callback = () => {
    triggered = true;
  };
  listener.on("listener_trigger", callback);
  listener.emit("listener_trigger");
  expect(triggered).toBe(true);
});

test("multiple listeners can listen to same event", () => {
  let count = 0;
  const callback1 = () => count++;
  const callback2 = () => count++;
  event.on("multi_test", callback1);
  event.on("multi_test", callback2);
  event.emit("multi_test");
  expect(count).toBe(2);
});
