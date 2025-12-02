import {sendRequest, cachedPlayerId} from "./socket.js";
import Cache from "./cache";
const cache = Cache.getInstance();
import encryptRsa from "./crypto.js";
import { chatInput } from "./ui.js";
const isCryptoSupported = typeof window?.crypto?.subtle === "object" && Object.keys(window.crypto.subtle).length !== 0;

// TODO: Add functionality to "set" chat mode when e.g.: /p (press space after)
async function handleChatMessage(message: string) {
  if (isCryptoSupported) {
    const chatDecryptionKey = sessionStorage.getItem("chatDecryptionKey");
    if (!chatDecryptionKey) return;
    const encryptedMessage = await encryptRsa(chatDecryptionKey, message || " ");
    sendRequest({
      type: "CHAT",
      data: { message: encryptedMessage, mode: "decrypt" }
    });
  } else {
    sendRequest({
      type: "CHAT",
      data: { message: message || " ", mode: null }
    });
  }

  // Set timeout to clear chat
  setTimeout(() => {
    const currentPlayer = Array.from(cache.players).find(player => player.id === cachedPlayerId);
    if (currentPlayer?.chat === message) {
      sendRequest({ type: "CHAT", data: null });
    }
  }, 7000 + message.length * 35);
}

async function handleCommand(message: string) {
  const command = message.substring(1);
  if (isCryptoSupported) {
    const chatDecryptionKey = sessionStorage.getItem("chatDecryptionKey");
    if (!chatDecryptionKey) return;
    const encryptedMessage = await encryptRsa(chatDecryptionKey, command || " ");
    sendRequest({
      type: "COMMAND",
      data: { command: encryptedMessage, mode: "decrypt" }
    });
  } else {
    sendRequest({
      type: "COMMAND",
      data: { command: command || " ", }
    });
  }
}

function getLines(ctx: any, text: string, maxWidth: number) {
  const words = text.split(" ");
  const lines = [];
  let currentLine = words[0];

  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    const width = ctx.measureText(currentLine + " " + word).width;
    if (width < maxWidth) {
      currentLine += " " + word;
    } else {
      lines.push(currentLine);
      currentLine = word;
    }
  }
  lines.push(currentLine);
  return lines;
}

export { handleChatMessage, handleCommand, chatInput, getLines };