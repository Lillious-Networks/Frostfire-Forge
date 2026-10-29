import log from "../modules/logger";
import { clusterEnabled } from "./config";
import type { NodeRegistry } from "./nodes";

/**
 * What a node does to the shared database when it starts (player.clear): it drops verification codes and every
 * account's party, deletes the guests and all parties. That is for a world nobody is in. In a cluster it runs only when
 * no other node of the region is beating, as a node that starts or restarts next to running ones would delete the
 * guests and parties of everyone playing there. Two nodes starting at once may both clear: nobody is playing yet.
 *
 * Live nodes that cannot be read skip it: a skipped clear only leaves stale guests and parties. Outside a cluster it
 * runs as always, without a read. A clear that throws is the caller's to handle, as before. Whether it ran.
 */
export async function clearOnStart(
  clear: () => Promise<void>,
  nodes: NodeRegistry | null,
  self: string,
  region: string
): Promise<boolean> {
  if (!clusterEnabled()) {
    await clear();
    return true;
  }
  let others: string[];
  try {
    if (!nodes) throw new Error("the node registry is not started");
    others = (await nodes.live()).filter((n) => n.nodeId !== self && n.regionId === region).map((n) => n.nodeId);
  } catch (error) {
    log.warn(`The shared state was not cleared at start, as the live nodes could not be read: ${error}`);
    return false;
  }
  if (others.length > 0) {
    log.info(`The shared state was not cleared at start: ${others.join(", ")} of region ${region} ${others.length === 1 ? "is" : "are"} alive`);
    return false;
  }
  await clear();
  return true;
}
