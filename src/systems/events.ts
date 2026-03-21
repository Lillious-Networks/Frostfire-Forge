import EventEmitter from "node:events";
import log from "../modules/logger";
export const event = new EventEmitter();
import { listener } from "../socket/server";
const now = performance.now();

event.on("online", () => {
  const readyTimeMs = performance.now() - now;
  log.success(`TCP server is listening on port 3000 - Ready in ${(readyTimeMs / 1000).toFixed(3)}s (${readyTimeMs.toFixed(0)}ms)`);

  listener.emit("onAwake");

  listener.emit("onStart");

  setInterval(() => {
    listener.emit("onUpdate");
  }, 1000 / 60);

  setInterval(() => {
    listener.emit("onFixedUpdate");
  }, 100);

  setInterval(() => {
    listener.emit("onSave");
  }, 60000);

  setInterval(() => {
    listener.emit("onServerTick");
  }, 1000);
});