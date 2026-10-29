import { isQuestRateLimited, requestTrade, tradeAction } from "../receiver";
import type { PacketContext } from "./context";

// Packet handlers moved from receiver.ts's packetReceiver switch (phase 6, Task 1). The case bodies are unchanged.

export const handles: ReadonlySet<string> = new Set(["TRADE_REQUEST", "TRADE_OFFER", "TRADE_ACCEPT", "TRADE_CANCEL"]);

export async function handle(ctx: PacketContext): Promise<unknown> {
  const { currentPlayer, data, type, wt } = ctx;
  switch (type) {

      case "TRADE_REQUEST": {
        if (!currentPlayer) return;
        if (isQuestRateLimited(String(currentPlayer.id))) return;
        await requestTrade(wt, currentPlayer, (data as any)?.id);
        break;
      }

      case "TRADE_OFFER": {
        if (!currentPlayer) return;
        await tradeAction(wt, currentPlayer, "offer", data);
        break;
      }

      case "TRADE_ACCEPT": {
        if (!currentPlayer) return;
        await tradeAction(wt, currentPlayer, "accept");
        break;
      }

      case "TRADE_CANCEL": {
        if (!currentPlayer) return;
        await tradeAction(wt, currentPlayer, "cancel");
        break;
      }
  }
}
