import mail, { MAIL_ITEMS_MAX } from "../../systems/mail";
import { packetManager } from "../packet_manager";
import { isQuestRateLimited, isTrading, mayUseMail, sendBelongingsOf, sendMailNotice, sendMailNoticeTo, sendMailbox, sendPacket, subscriptionLocked } from "../receiver";
import type { PacketContext } from "./context";

// Packet handlers moved from receiver.ts's packetReceiver switch (phase 6, Task 1). The case bodies are unchanged.

export const handles: ReadonlySet<string> = new Set(["MAIL_OPEN", "MAIL_SEND", "MAIL_TAKE", "MAIL_READ", "MAIL_DELETE", "MAIL_RETURN"]);

export async function handle(ctx: PacketContext): Promise<unknown> {
  const { currentPlayer, data, type, wt } = ctx;
  switch (type) {

      case "MAIL_OPEN": {
        if (!currentPlayer) return;
        if (subscriptionLocked(wt, currentPlayer, "mail")) return;
        if (isQuestRateLimited(`mail:${wt.data.id}`)) return;
        if (!(await mayUseMail(wt, currentPlayer))) break;
        await sendMailbox(wt, currentPlayer);
        break;
      }

      case "MAIL_SEND": {
        if (!currentPlayer) return;
        if (subscriptionLocked(wt, currentPlayer, "mail")) return;
        if (isQuestRateLimited(`mail:${wt.data.id}`)) return;
        if (!(await mayUseMail(wt, currentPlayer))) break;
        if (isTrading(currentPlayer.username)) {
          sendPacket(wt, packetManager.mailSent({ ok: false, message: "You cannot send mail while trading." }));
          break;
        }
        const sent = await mail.send(currentPlayer, data);
        sendPacket(wt, packetManager.mailSent({ ok: sent.ok, message: sent.message }));
        if (!sent.ok) break;
        await sendBelongingsOf(currentPlayer);
        await sendMailNoticeTo(sent.recipient, true);
        break;
      }

      case "MAIL_TAKE": {
        if (!currentPlayer) return;
        if (subscriptionLocked(wt, currentPlayer, "mail")) return;
        if (isQuestRateLimited(`mail:${wt.data.id}`)) return;
        if (!(await mayUseMail(wt, currentPlayer))) break;
        const part = (data as any)?.part;
        if (part !== "all" && part !== "coins" && !(Number.isInteger(part) && part >= 0 && part < MAIL_ITEMS_MAX)) return;
        const taken = await mail.take(currentPlayer.username, Number((data as any)?.mailId), part);
        // What was taken shows in the bags: only a refusal is said.
        if (!taken.ok) sendPacket(wt, packetManager.notify({ message: taken.message }));
        if (taken.ok) await sendBelongingsOf(currentPlayer);
        await sendMailbox(wt, currentPlayer);
        break;
      }

      case "MAIL_READ": {
        if (!currentPlayer) return;
        if (subscriptionLocked(wt, currentPlayer, "mail")) return;
        if (!(await mayUseMail(wt, currentPlayer))) break;
        await mail.markRead(currentPlayer.username, Number((data as any)?.mailId));
        await sendMailNotice(currentPlayer);
        break;
      }

      case "MAIL_DELETE": {
        if (!currentPlayer) return;
        if (subscriptionLocked(wt, currentPlayer, "mail")) return;
        if (isQuestRateLimited(`mail:${wt.data.id}`)) return;
        if (!(await mayUseMail(wt, currentPlayer))) break;
        const deleted = await mail.remove(currentPlayer.username, Number((data as any)?.mailId));
        if (!deleted.ok) sendPacket(wt, packetManager.notify({ message: deleted.message }));
        await sendMailbox(wt, currentPlayer);
        break;
      }

      case "MAIL_RETURN": {
        if (!currentPlayer) return;
        if (subscriptionLocked(wt, currentPlayer, "mail")) return;
        if (isQuestRateLimited(`mail:${wt.data.id}`)) return;
        if (!(await mayUseMail(wt, currentPlayer))) break;
        const mailId = Number((data as any)?.mailId);
        const sender = (await mail.inbox(currentPlayer.username)).find((held) => held.id === mailId)?.sender;
        const returned = await mail.returnToSender(currentPlayer.username, mailId);
        sendPacket(wt, packetManager.notify({ message: returned.message }));
        await sendMailbox(wt, currentPlayer);
        if (returned.ok && sender) await sendMailNoticeTo(sender, true);
        break;
      }
  }
}
