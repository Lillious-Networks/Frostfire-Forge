import.meta.hot.accept;
import { config } from "../web/global.js";
const socket = new WebSocket(config.WEBSOCKET_URL || "ws://localhost:3000");
const version = config?.VERSION;
import "./events.ts";
import pako from "../libs/pako.js";
import packet from "./packetencoder.ts";
import Cache from "./cache.ts";
import { updateTime } from "./ambience.ts";
import { setWeatherType } from "./renderer.ts";
const cache = Cache.getInstance();
import { createPlayer } from "./player.ts";
import { updateFriendsList } from "./friends.ts";
import { createInvitationPopup } from "./invites.ts";
import { updateFriendOnlineStatus } from "./friends.js";
import loadMap from "./map.ts";
import {
  createPartyUI,
  canvas,
  positionText,
  fpsSlider,
  musicSlider,
  effectsSlider,
  mutedCheckbox,
  statUI,
  packetsSentReceived,
  onlinecount,
  progressBarContainer,
  inventoryGrid,
  chatMessages,
  healthLabel,
  manaLabel,
  notificationContainer,
  notificationMessage,
} from "./ui.ts";
import { playAudio, playMusic } from "./audio.ts";
import { updateXp } from "./xp.ts";
import { createNPC } from "./npc.ts";
import parseAPNG from "../libs/apng_parser.js";
import { getCookie } from "./cookies.ts";
socket.binaryType = "arraybuffer";
let sentRequests: number = 0,
  receivedResponses: number = 0;

let clearNotificationTimeout: any = null;

function sendRequest(data: any) {
  sentRequests++;
  socket.send(packet.encode(JSON.stringify(data)));
}

let cachedPlayerId: string | null = null;

socket.onopen = () => {
  sendRequest({
    type: "PING",
    data: null,
  });
};

socket.onclose = (ev: CloseEvent) => {
  // Remove the loading bar if it exists
  progressBarContainer.style.display = "none";
  showNotification(
    `You have been disconnected from the server: ${ev.code}`,
    false,
    true
  );
};

socket.onerror = (ev: Event) => {
  progressBarContainer.style.display = "none";
  showNotification(
    `An error occurred while connecting to the server: ${ev.type}`,
    false,
    true
  );
};

socket.onmessage = async (event) => {
  receivedResponses++;
  if (!(event.data instanceof ArrayBuffer)) return;
  const data = JSON.parse(packet.decode(event.data))["data"];
  const type = JSON.parse(packet.decode(event.data))["type"];

  switch (type) {
    case "SERVER_TIME": {
      sendRequest({ type: "TIME_SYNC" });
      if (!data) return;
      updateTime(data);
      break;
    }
    case "WEATHER": {
      if (!data || !data.weather) return;
      setWeatherType(data.weather);
      break;
    }
    case "CONSOLE_MESSAGE": {
      if (!data || !data.message) return;
      window.Notify(data.type, data.message);
      break;
    }
    case "INVITATION": {
      // Show the invitation modal
      createInvitationPopup(data);
      break;
    }
    case "UPDATE_FRIENDS": {
      const currentPlayer = cache.players.size
        ? Array.from(cache.players).find((p) => p.id === cachedPlayerId)
        : null;
      if (currentPlayer) {
        currentPlayer.friends = data.friends || [];
        updateFriendsList(data);
      }
      break;
    }
    case "UPDATE_ONLINE_STATUS": {
      updateFriendOnlineStatus(data.username, data.online);
      break;
    }
    case "UPDATE_PARTY": {
      const currentPlayer = cache.players.size
        ? Array.from(cache.players).find((p) => p.id === cachedPlayerId)
        : null;
      if (currentPlayer) {
        currentPlayer.party = data.members || [];
        createPartyUI(currentPlayer.party);
      }
      break;
    }
    case "ANIMATION": {
      try {
        if (!data?.name || !data?.data) return;

        let apng: any;
        const cachedData = cache.animations.get(data.name);

        if (cachedData instanceof Uint8Array) {
          apng = parseAPNG(cachedData);
        } else {
          // Check IndexedDB
          const dbData = await getAnimationFromDB(data.name);
          if (dbData) {
            cache.animations.set(data.name, dbData);
            apng = parseAPNG(dbData);
          } else {
            // @ts-expect-error - pako is loaded globally
            const inflated = pako.inflate(new Uint8Array(data.data.data));
            if (!inflated) {
              console.warn(`[ANIMATION] Inflation failed for: ${data.name}`);
              return;
            }

            cache.animations.set(data.name, inflated);
            await saveAnimationToDB(data.name, inflated);
            apng = parseAPNG(inflated);
          }
        }

        if (!(apng instanceof Error) && cache.players) {
          const findPlayer = async () => {
            const player = cache.players.size
              ? Array.from(cache.players).find((p) => p.id === data.id)
              : null;
            if (player) {
              // Preload all images before switching animation
              if (apng.frames && apng.frames.length > 0) {
                // Create images for all frames
                apng.frames.forEach((frame: any) => frame.createImage());

                // Wait for all images to load
                await Promise.all(
                  apng.frames.map((frame: any) => {
                    return new Promise<void>((resolve) => {
                      if (frame.imageElement?.complete) {
                        resolve();
                      } else if (frame.imageElement) {
                        frame.imageElement.onload = () => resolve();
                        frame.imageElement.onerror = () => resolve(); // Resolve even on error to prevent hanging
                      } else {
                        resolve();
                      }
                    });
                  })
                );
              }

              // Now assign the animation with all images preloaded
              player.animation = {
                frames: apng.frames,
                currentFrame: 0,
                lastFrameTime: performance.now(),
              };
            } else {
              await new Promise((resolve) => setTimeout(resolve, 100));
              await findPlayer();
            }
          };

          findPlayer().catch((err) =>
            console.error("Error in findPlayer:", err)
          );
        }
      } catch (error) {
        console.error("Failed to process animation data:", error);
      }
      break;
    }
    case "PONG":
      sendRequest({
        type: "LOGIN",
        data: null,
      });
      break;
    case "CONNECTION_COUNT": {
      onlinecount.innerText = `${data} online`;
      break;
    } 
    case "SPAWN_PLAYER": {
      await isLoaded();
      createPlayer(data);
      break;
    }
    case "RECONNECT": {
      window.location.reload();
      break;
    }
    case "LOAD_PLAYERS": {
      await isLoaded();
      if (!data) return;
      // Clear existing players that are not the current player
      cache.players.forEach((player) => {
        if (player.id !== cachedPlayerId) {
          cache.players.delete(player);
        }
      });

      data.forEach((player: any) => {
        if (player.id != cachedPlayerId) {
          // Check if the player is already created and remove it
          cache.players.forEach((p) => {
            if (p.id === player.id) {
              cache.players.delete(p);
            }
          });
          createPlayer(player);
        }
      });
      break;
    }
    case "DISCONNECT_MALIFORMED": {
      if (!data) return;
      const arrayToDisconnect = Array.isArray(data) ? data : [data];
      arrayToDisconnect.forEach((playerData) => {
        const player = Array.from(cache.players).find(
          (player) => player.id === playerData.id
        );
        if (player) {
          cache.players.delete(player);
        }
      });
      break;
    }
    case "DISCONNECT_PLAYER": {
      if (!data || !data.id || !data.username) return;

      updateFriendOnlineStatus(data.username, false);

      // Remove player from the array
      const player = Array.from(cache.players).find(
        (player) => player.id === data.id
      );
      if (player) {
        cache.players.delete(player);
      }
      // If they were targeted, hide target stats
      // if (wasTargeted) {
      //   displayElement(targetStats, false);
      // }
      break;
    }
    case "MOVEXY": {
      const player = Array.from(cache.players).find(
        (player) => player.id === data.id
      );
      if (!player) return;

      // Handle movement abort
      if (data._data === "abort") {
        break;
      }

      player.typing = false;

      // Smoothly update player position
      const targetX = canvas.width / 2 + data._data.x;
      const targetY = canvas.height / 2 + data._data.y;

      // Direct position update - no prediction, no interpolation
      player.position.x = targetX;
      player.position.y = targetY;

      if (data.id === cachedPlayerId) {
        positionText.innerText = `Position: ${data._data.x}, ${data._data.y}`;
      }
      break;
    }
    case "CREATE_NPC": {
      await isLoaded();
      if (!data) return;
      createNPC(data);
      break;
    }
    case "LOAD_MAP":
      {
        loaded = await loadMap(data);
      }
      break;
    case "LOGIN_SUCCESS":
      {
        const connectionId = JSON.parse(packet.decode(event.data))["data"];
        const chatDecryptionKey = JSON.parse(packet.decode(event.data))[
          "chatDecryptionKey"
        ];
        sessionStorage.setItem("connectionId", connectionId); // Store client's socket ID
        cachedPlayerId = connectionId;
        const sessionToken = getCookie("token");
        if (!sessionToken) {
          window.location.href = "/game";
          return;
        }

        // Store public key
        sessionStorage.setItem("chatDecryptionKey", chatDecryptionKey);

        const language =
          navigator.language.split("-")[0] || navigator.language || "en";
        sendRequest({
          type: "AUTH",
          data: sessionToken,
          language,
        });
      }
      break;
    case "LOGIN_FAILED":
      {
        window.location.href = "/";
      }
      break;
    case "INVENTORY":
      {
        const data = JSON.parse(packet.decode(event.data))["data"];
        const slots = JSON.parse(packet.decode(event.data))["slots"];
        if (data.length > 0) {
          // Assign each item to a slot
          for (let i = 0; i < data.length; i++) {
            // Create a new item slot
            const slot = document.createElement("div");
            slot.classList.add("slot");
            slot.classList.add("ui");
            const item = data[i];
            slot.classList.add(item.quality.toLowerCase() || "empty");

            if (item.icon) {
              // @ts-expect-error - pako is loaded in index.html
              const inflatedData = pako.inflate(
                new Uint8Array(item.icon.data),
                { to: "string" }
              );
              const iconImage = new Image();
              iconImage.src = `data:image/png;base64,${inflatedData}`;
              iconImage.onload = () => {
                slot.appendChild(iconImage);
              };
              // Overlay item quantity if greater than 1
              if (item.quantity > 1) {
                const quantityLabel = document.createElement("div");
                quantityLabel.classList.add("quantity-label");
                quantityLabel.innerText = `x${item.quantity}`;
                slot.appendChild(quantityLabel);
              }
              inventoryGrid.appendChild(slot);
            } else {
              slot.innerHTML = `${item.item}${
                item.quantity > 1 ? `<br>x${item.quantity}` : ""
              }`;
              inventoryGrid.appendChild(slot);
            }
          }
        }

        for (let i = 0; i < slots - data.length; i++) {
          const slot = document.createElement("div");
          slot.classList.add("slot");
          slot.classList.add("empty");
          slot.classList.add("ui");
          inventoryGrid.appendChild(slot);
        }
      }
      break;
    case "QUESTLOG": {
      // const data = JSON.parse(packet.decode(event.data))["data"];
      break;
    }
    case "QUESTDETAILS": {
      // const data = JSON.parse(packet.decode(event.data))["data"];
      break;
    }
    case "CHAT": {
      cache.players.forEach((player) => {
        if (player.id === data.id) {
          // Escape HTML tags before setting chat message
          player.chat = data.message;
          // Username with first letter uppercase
          const username =
            data?.username?.charAt(0)?.toUpperCase() + data?.username?.slice(1);
          const timestamp = new Date().toLocaleTimeString();
          // Update chat box
          if (data.message?.trim() !== "" && username) {
            const message = document.createElement("div");
            message.classList.add("message");
            message.style.userSelect = "text";
            // Escape HTML in the message before inserting
            const escapedMessage = data.message
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;");
            message.innerHTML = `<span class='bold'>[${timestamp}] </span><span ${player.isAdmin ? "class='admin'" : ""}>${username}: </span><span>${escapedMessage.toString()}</span>`
            chatMessages.appendChild(message);
            // Scroll to the bottom of the chat messages
            chatMessages.scrollTop = chatMessages.scrollHeight;
            // Set typing to false
            player.typing = false;
          }
        }
      });
      break;
    }
    case "TYPING": {
      cache.players.forEach((player) => {
        if (player.id === data.id) {
          player.typing = true;
          // Clear any existing timeout for this player
          if (player.typingTimeout) {
            clearTimeout(player.typingTimeout);
          }
          // Set typing to false after 5 seconds
          player.typingTimeout = setTimeout(() => {
            player.typing = false;
          }, 3000);
        }
      });
      break;
    }
    case "STOPTYPING": {
      cache.players.forEach((player) => {
        if (player.id === data.id) {
          player.typing = false;
        }
      });
      break;
    }
    case "NPCDIALOG": {
      const npc = cache.npcs.find((npc) => npc.id === data.id);
      if (!npc) return;
      npc.dialog = data.dialog;
      break;
    }
    case "STATS": {
      const player = Array.from(cache.players).find(
        (player) => player.id === data.id
      );
      if (!player) return;
      updateXp(data.xp, data.level, data.max_xp);
      player.stats = data;
      break;
    }
    case "CLIENTCONFIG": {
      const data = JSON.parse(packet.decode(event.data))["data"][0];
      fpsSlider.value = data.fps;
      document.getElementById(
        "limit-fps-label"
      )!.innerText = `FPS: (${fpsSlider.value})`;
      musicSlider.value = data.music_volume || 0;
      document.getElementById(
        "music-volume-label"
      )!.innerText = `Music: (${musicSlider.value})`;
      effectsSlider.value = data.effects_volume || 0;
      document.getElementById(
        "effects-volume-label"
      )!.innerText = `Effects: (${effectsSlider.value})`;
      mutedCheckbox.checked = data.muted;
      document.getElementById(
        "muted-checkbox"
      )!.innerText = `Muted: ${mutedCheckbox.checked}`;
      break;
    }
    case "SELECTPLAYER": {
      const data = JSON.parse(packet.decode(event.data))["data"];

      if (!data || !data.id || !data.username) {
        const target = Array.from(cache.players).find((p) => p.targeted);
        if (target) target.targeted = false;
        //displayElement(targetStats, false);
        break;
      }

      cache.players.forEach((player) => {
        player.targeted = player.id === data.id;
      });

      // displayElement(targetStats, true);
      break;
    }
    case "STEALTH": {
      const data = JSON.parse(packet.decode(event.data))["data"];
      const currentPlayer = Array.from(cache.players).find(
        (player) => player.id === cachedPlayerId || player.id === cachedPlayerId
      );

      // Abort movement if self
      if (currentPlayer && data.id === currentPlayer.id) {
        sendRequest({
          type: "MOVEXY",
          data: "ABORT",
        });
      }

      cache.players.forEach((player) => {
        if (player.id === data.id) {
          player.isStealth = data.isStealth;
        }

        // Untarget stealthed players
        if (player.isStealth && player.targeted) {
          player.targeted = false;
          //displayElement(targetStats, false);
        }
      });

      break;
    }
    case "UPDATESTATS": {
      const { target, stats } = JSON.parse(packet.decode(event.data))["data"];
      const t = Array.from(cache.players).find(
        (player) => player.id === target
      );
      if (t) {
        t.stats = stats;
      }
      break;
    }
    case "REVIVE": {
      const data = JSON.parse(packet.decode(event.data))["data"];
      const target = Array.from(cache.players).find(
        (player) => player.id === data.target
      );
      if (!target) return;

      target.stats = data.stats;

      const isSelf = target.id.toString() === cachedPlayerId;

      if (!isSelf) {
        target.targeted = false;
      }

      //displayElement(targetStats, false);
      cache.players.forEach((player) => (player.targeted = false));
      break;
    }
    case "UPDATE_XP": {
      const data = JSON.parse(packet.decode(event.data))["data"];
      // Only update the xp bar if the current player is the target
      if (data.id === cachedPlayerId) {
        updateXp(data.xp, data.level, data.max_xp);
      }
      break;
    }
    case "AUDIO": {
      const name = JSON.parse(packet.decode(event.data))["name"];
      const data = JSON.parse(packet.decode(event.data))["data"];
      const pitch = JSON.parse(packet.decode(event.data))["pitch"] || 1;
      const timestamp = JSON.parse(packet.decode(event.data))["timestamp"];
      playAudio(name, data.data.data, pitch, timestamp);
      break;
    }
    case "MUSIC": {
      const name = JSON.parse(packet.decode(event.data))["name"];
      const data = JSON.parse(packet.decode(event.data))["data"];
      const timestamp = JSON.parse(packet.decode(event.data))["timestamp"];
      playMusic(name, data.data.data, timestamp);
      break;
    }
    case "INSPECTPLAYER": {
      const data = JSON.parse(packet.decode(event.data))["data"];
      // Add the player ID as an attribute to the target stats container
      statUI.setAttribute("data-id", data.id);
      healthLabel!.innerText = `Health: (${data.stats.health})`;
      manaLabel!.innerText = `Mana: (${data.stats.stamina})`;
      statUI.style.transition = "1s";
      statUI.style.left = "10";
      break;
    }
    case "NOTIFY": {
      const data = JSON.parse(packet.decode(event.data))["data"];
      showNotification(data.message, true, false);
      break;
    }
    case "WHISPER": {
      const data = JSON.parse(packet.decode(event.data))["data"];
      // Escape HTML tags before setting chat message
      const escapedMessage = data.message
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      const timestamp = new Date().toLocaleTimeString();
      // Update chat box
      if (data.message?.trim() !== "" && data.username) {
        const message = document.createElement("div");
        message.classList.add("message");
        message.style.userSelect = "text";
        // Username with first letter uppercase
        const username =
          data?.username?.charAt(0)?.toUpperCase() + data?.username?.slice(1);
        message.innerHTML = `${timestamp} <span class="whisper-username">${username}:</span> <span class="whisper-message">${escapedMessage}</span>`;
        chatMessages.appendChild(message);
        // Scroll to the bottom of the chat messages
        chatMessages.scrollTop = chatMessages.scrollHeight;
      }
      break;
    }
    case "PARTY_CHAT": {
      const data = JSON.parse(packet.decode(event.data))["data"];
      // Escape HTML tags before setting chat message
      const escapedMessage = data.message
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      const timestamp = new Date().toLocaleTimeString();
      // Update chat box
      if (data.message?.trim() !== "" && data.username) {
        const message = document.createElement("div");
        message.classList.add("message");
        message.style.userSelect = "text";
        // Username with first letter uppercase
        const username =
          data?.username?.charAt(0)?.toUpperCase() + data?.username?.slice(1);
        message.innerHTML = `${timestamp} <span class="party-username">${username}:</span> <span class="party-message">${escapedMessage}</span>`;
        chatMessages.appendChild(message);
        // Scroll to the bottom of the chat messages
        chatMessages.scrollTop = chatMessages.scrollHeight;
      }
      break;
    }
    case "CURRENCY": {
      break;
    }
    default:
      break;
  }
};

// Create text on bottom right that displays the version at half opacity
if (version) {
  const versionText = document.createElement("div");
  versionText.style.position = "fixed";
  versionText.style.bottom = "5px";
  versionText.style.right = "10px";
  versionText.style.fontSize = "14px";
  versionText.style.color = "rgba(255, 255, 255, 0.5)";
  versionText.style.zIndex = "1000";
  versionText.style.userSelect = "none";
  versionText.innerText = `v${version}`;
  document.body.appendChild(versionText);
}

function showNotification(
  message: string,
  autoClose: boolean = true,
  reconnect: boolean = false
) {
  if (!notificationContainer || !notificationMessage) return;

  notificationMessage.innerText = message;
  notificationContainer.style.display = "flex";

  const baseTimeout = 5000; // Base timeout of 5 seconds
  const timePerChar = 100; // Additional time per character in milliseconds
  const timeout = baseTimeout + message.length * timePerChar;

  if (autoClose) {
    // Clear any existing timeout
    if (clearNotificationTimeout) {
      clearTimeout(clearNotificationTimeout);
    }
    clearNotificationTimeout = setTimeout(() => {
      if (!notificationContainer || !notificationMessage) return;
      notificationContainer.style.display = "none";
      // If reconnect is true, redirect after hiding notification
      if (reconnect) {
        if (window.navigator.userAgent === "@Electron/Frostfire-Forge-Client") {
          window.close(); // Close the Electron window
        } else {
          // If not in Electron, redirect to home page
          window.location.href = "/";
        }
      }
    }, timeout);
  } else if (reconnect) {
    // If not auto-closing but need to reconnect
    setTimeout(() => {
      if (window.navigator.userAgent === "@Electron/Frostfire-Forge-Client") {
        window.close(); // Close the Electron window
      } else {
        window.location.href = "/";
      }
    }, timeout);
  }
}

let loaded: boolean = false;

function getIsLoaded() {
  return loaded;
}

async function isLoaded() {
  // Check every second if the map is loaded
  await new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      if (loaded) {
        clearInterval(interval);

        resolve();
      }
    }, 10);
  });
}

setInterval(() => {
  if (
    packetsSentReceived.innerText ===
    `Sent: ${sentRequests}, Received: ${receivedResponses}`
  )
    return;
  packetsSentReceived.innerText = `Sent: ${sentRequests}, Received: ${receivedResponses}`;
  sentRequests = 0;
  receivedResponses = 0;
}, 1000);

// Utility IndexedDB wrapper
async function openAnimationDB() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("AnimationCache", 1);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains("animations")) {
        db.createObjectStore("animations");
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getAnimationFromDB(
  name: string
): Promise<Uint8Array | undefined> {
  const db = await openAnimationDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("animations", "readonly");
    const store = tx.objectStore("animations");
    const req = store.get(name);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveAnimationToDB(name: string, data: Uint8Array) {
  const db = await openAnimationDB();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction("animations", "readwrite");
    const store = tx.objectStore("animations");
    const req = store.put(data, name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export { sendRequest, cachedPlayerId, getIsLoaded };
