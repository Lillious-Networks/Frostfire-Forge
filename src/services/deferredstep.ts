import log from "../modules/logger";

/**
 * A timer callback that does async work: a failure (the cache or Redis away) is logged and the rest of that step is
 * skipped. A rejection nobody handles would end the process. `onFail` runs after the log line, for a step whose
 * failure leaves something half done that the caller must put right (it must not throw).
 */
export function deferredStep(what: string, run: () => Promise<void>, onFail?: () => void): () => void {
  return () => {
    run().catch((error) => {
      log.error(`${what} could not be finished: ${error}`);
      try {
        onFail?.();
      } catch (failure) {
        log.error(`${what}: the clean-up after the failure failed too: ${failure}`);
      }
    });
  };
}
