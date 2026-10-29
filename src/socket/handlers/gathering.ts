import fishing from "../../systems/fishing";
import playerCache from "../../services/playermanager.ts";
import { castFish, castGather, castingFish, fishReel, isGatherRateLimited, landFish, stopFishing, subscriptionLocked } from "../receiver";
import type { PacketContext } from "./context";

// Packet handlers moved from receiver.ts's packetReceiver switch (phase 6, Task 1). The case bodies are unchanged.

export const handles: ReadonlySet<string> = new Set(["GATHER", "FISH_CAST", "FISH_REEL", "FISH_LAND", "FISH_CANCEL"]);

export async function handle(ctx: PacketContext): Promise<unknown> {
  const { currentPlayer, data, type, wt } = ctx;
  switch (type) {

      case "GATHER": {
        if (!currentPlayer) return;
        if (subscriptionLocked(wt, currentPlayer, "loot")) return;
        if (isGatherRateLimited(String(wt.data.id))) return;
        await castGather(currentPlayer, (data as any)?.nodeId);
        break;
      }

      case "FISH_CAST": {
        // A click on a fishable tile (systems/fishing), under the same limit as gathering's presses
        if (!currentPlayer) return;
        if (subscriptionLocked(wt, currentPlayer, "loot")) return;
        if (isGatherRateLimited(String(wt.data.id))) return;
        await castFish(currentPlayer, data);
        break;
      }

      case "FISH_REEL": {
        // the player began reeling in a fish that bit (systems/fishing BITE_ESCAPE_MS)
        if (!currentPlayer) return;
        fishReel(currentPlayer.id);
        break;
      }

      case "FISH_LAND": {
        if (!currentPlayer) return;
        if (isGatherRateLimited(String(wt.data.id))) return;
        await landFish(currentPlayer);
        break;
      }

      case "FISH_CANCEL": {
        if (!currentPlayer) return;
        // the player reeled the line in with no fish on it: the staff stays out while the bobber comes back to it
        if (castingFish(playerCache.get(currentPlayer.id) || currentPlayer)) await stopFishing(currentPlayer, fishing.LINE_IN_MS);
        break;
      }
  }
}
