import { regionId, nodeId } from "./config";
import { clusterNodes } from "./index";
import { clearOnStart } from "./startclear";

/**
 * `clear` (player.clear, which wipes the guests and parties of the shared database) for this node: in a cluster only
 * when no other node of the region is alive, see clearOnStart. For the node's start and for the /shutdown and /restart
 * commands. Whether it ran.
 */
export function clearShared(clear: () => Promise<void>): Promise<boolean> {
  return clearOnStart(clear, clusterNodes(), nodeId(), regionId());
}
