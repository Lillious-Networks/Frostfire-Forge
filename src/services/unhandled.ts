import log from "../modules/logger";

/** Whether `reason` is an error of the Redis client (its code starts with ERR_REDIS_). */
export function isRedisError(reason: unknown): boolean {
  return typeof (reason as { code?: unknown } | null)?.code === "string" && (reason as { code: string }).code.startsWith("ERR_REDIS_");
}

/**
 * The last resort for a promise that failed with nobody to handle it. A Redis error is logged and the node keeps
 * running: Redis is away for a while, and the node must not drop its players for it. Any other reason is logged and
 * the process exits with code 1, as Bun does with no handler.
 */
export function onUnhandledRejection(reason: unknown, exit: (code: number) => void = (code) => process.exit(code)): void {
  const stack = reason instanceof Error && reason.stack ? `\n${reason.stack}` : "";
  if (isRedisError(reason)) {
    log.error(`Unhandled Redis rejection, the node keeps running: ${reason}${stack}`);
    return;
  }
  log.error(`Unhandled rejection, the node exits: ${reason}${stack}`);
  exit(1);
}

let installed = false;
/** Registers onUnhandledRejection on the process, once. */
export function installUnhandledRejectionHandler(): void {
  if (installed) return;
  installed = true;
  process.on("unhandledRejection", (reason) => onUnhandledRejection(reason));
}
