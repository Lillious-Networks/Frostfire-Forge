import { sendRequest, getIsLoaded, cachedPlayerId } from "./socket.js";
import Cache from "./cache";
const cache = Cache.getInstance();
import { updateChunkVisibility, updateViewportCache, lastViewportChunks, getCameraX, getCameraY, setCameraX, setCameraY } from "./renderer.js";
import { chatInput, pauseMenu, optionsMenu, fpsSlider, musicSlider, effectsSlider, mutedCheckbox, canvas, friendsList } from "./ui.js";
import { getUserHasInteracted, setUserHasInteracted, setControllerConnected, getLastSentDirection, setLastSentDirection,
    getLastTypingPacket, setLastTypingPacket, getContextMenuKeyTriggered, setContextMenuKeyTriggered, blacklistedKeys, movementKeys, 
    pressedKeys,
    setIsKeyPressed,
    getIsKeyPressed,
    getIsMoving,
    handleKeyPress,
    keyHandlers,
    COOLDOWN_DURATION,
    cooldowns,
    stopMovement,
    setIsMoving} from "./input.js";
import { friendsListSearch } from "./friends.js";
import { createContextMenu, createPartyContextMenu } from "./actions.js";
let typingTimer: number | null = null;

const userInteractionListener = () => {
  if (!getUserHasInteracted()) {
    setUserHasInteracted(true);
    document.removeEventListener("mousedown", userInteractionListener);
  }
};

window.addEventListener("mousedown", userInteractionListener);
window.addEventListener("gamepadconnected", () => {
  setControllerConnected(true);
});
window.addEventListener("gamepaddisconnected", () => {
  setControllerConnected(false);
});
window.addEventListener('resize', () => {
  updateViewportCache();
  lastViewportChunks.clear();
  updateChunkVisibility();
});

window.addEventListener("gamepadjoystick", (e: CustomEventInit) => {
  if (!getIsLoaded()) return;
  if (pauseMenu.style.display == "block") return;

  // Get the joystick coordinates
  const x = e.detail.x;
  const y = e.detail.y;

  // Check if joystick is in neutral position (increased deadzone)
  const deadzone = 0.5;
  if (Math.abs(x) < deadzone && Math.abs(y) < deadzone) {
    if (getLastSentDirection() !== "ABORT") {
      sendRequest({
        type: "MOVEXY",
            data: "ABORT",
      });
      setLastSentDirection("ABORT");
    }
    return;
  }

  // Determine the angle in degrees
  const angle = Math.atan2(y, x) * (180 / Math.PI);

  // Determine direction based on angle ranges
  let direction = "";
  if (angle >= -22.5 && angle < 22.5) {
    direction = "RIGHT";
  } else if (angle >= 22.5 && angle < 67.5) {
    direction = "DOWNRIGHT";
  } else if (angle >= 67.5 && angle < 112.5) {
    direction = "DOWN";
  } else if (angle >= 112.5 && angle < 157.5) {
    direction = "DOWNLEFT";
  } else if (angle >= 157.5 || angle < -157.5) {
    direction = "LEFT";
  } else if (angle >= -157.5 && angle < -112.5) {
    direction = "UPLEFT";
  } else if (angle >= -112.5 && angle < -67.5) {
    direction = "UP";
  } else if (angle >= -67.5 && angle < -22.5) {
    direction = "UPRIGHT";
  }

  // Only send if direction changed
  if (direction && direction !== getLastSentDirection()) {
    if (pauseMenu.style.display == "block") return;
    sendRequest({
      type: "MOVEXY",
          data: direction,
    });
    setLastSentDirection(direction);
  }
});

chatInput.addEventListener("input", () => {
  // Clear any existing timer
  if (typingTimer) {
    window.clearTimeout(typingTimer);
  }

  // Send typing packet if enough time has passed since last one
  if (getLastTypingPacket() + 1000 < performance.now()) {
    sendRequest({
      type: "TYPING",
      data: null,
    });
    setLastTypingPacket(performance.now());
  }

  // Set new timer to send another packet after delay
  typingTimer = window.setTimeout(() => {
    if (chatInput.value.length > 0) {
      sendRequest({
        type: "TYPING",
        data: null,
      });
      setLastTypingPacket(performance.now());
    }
  }, 1000);
});

window.addEventListener("keydown", async (e) => {
  if (e.key === 'ContextMenu' || e.code === 'ContextMenu') {
    setContextMenuKeyTriggered(true);
  }
  // Prevent blacklisted keys
  if (blacklistedKeys.has(e.code)) {
    // Check for tab
    if (e.code === "Tab" && !getContextMenuKeyTriggered()) {
      const target = Array.from(cache.players).find(player => player.targeted);
      if (target) {
        target.targeted = false;
      }
      //displayElement(targetStats, false);
      sendRequest({ type: "TARGETCLOSEST", data: null });
      e.preventDefault();
      return;
    }
    
    e.preventDefault();
    return;
  }
  if (!getIsLoaded() || (pauseMenu.style.display === "block" && e.code !== "Escape")) return;
  if ((chatInput === document.activeElement || document.activeElement == friendsListSearch) && !["Enter", "Escape"].includes(e.code)) return;

  // Handle movement keys
  if (movementKeys.has(e.code)) {
    pressedKeys.add(e.code);
    if (!getIsKeyPressed()) {
      setIsKeyPressed(true);
      if (!getIsMoving()) {
        handleKeyPress();
      }
    }
  }

  // Handle other mapped keys
  const now = Date.now();
  const handler = keyHandlers[e.code as keyof typeof keyHandlers];
  if (!handler) return;
  // Prevent repeated calls within cooldown
  if (cooldowns[e.code] && now - cooldowns[e.code] < COOLDOWN_DURATION) return;

  cooldowns[e.code] = now;

  try {
    await handler();
  } catch (err) {
    console.error(`Error handling key ${e.code}:`, err);
  }
});

window.addEventListener("keyup", (e) => {
  if (chatInput === document.activeElement) return;
  if (movementKeys.has(e.code)) {
    pressedKeys.delete(e.code);
    if (pressedKeys.size === 0) {
      setIsKeyPressed(false);
    }
  }
});

window.addEventListener("resize", () => {
  updateViewportCache();
  const currentPlayer = Array.from(cache.players).find((player) => player.id === cachedPlayerId);
  if (currentPlayer) {
    setCameraX(currentPlayer.position.x - window.innerWidth / 2 + 8);
    setCameraY(currentPlayer.position.y - window.innerHeight / 2 + 48);
    window.scrollTo(getCameraX(), getCameraY());
  }
  if (document.getElementById("context-menu")) {
    document.getElementById("context-menu")!.remove();
  }
});

window.addEventListener("blur", () => {
  setIsKeyPressed(false);
  pressedKeys.clear();
});

document
  .getElementById("pause-menu-action-back")
  ?.addEventListener("click", () => {
    pauseMenu.style.display = "none";
  });

document
  .getElementById("pause-menu-action-options")
  ?.addEventListener("click", () => {
    // If any other menu is open, close all other menus
    pauseMenu.style.display = "none";
    optionsMenu.style.display = "block";
  });

document
  .getElementById("pause-menu-action-exit")
  ?.addEventListener("click", () => {
    sendRequest({
      type: "LOGOUT",
          data: null,
    });
    window.location.href = "/";
  });

fpsSlider.addEventListener("input", () => {
  document.getElementById(
    "limit-fps-label"
  )!.innerText = `FPS: (${fpsSlider.value})`;
});

musicSlider.addEventListener("input", () => {
  document.getElementById(
    "music-volume-label"
  )!.innerText = `Music: (${musicSlider.value})`;
});

effectsSlider.addEventListener("input", () => {
  document.getElementById(
    "effects-volume-label"
  )!.innerText = `Effects: (${effectsSlider.value})`;
});

[fpsSlider, musicSlider, effectsSlider, mutedCheckbox].forEach(element => {
  element.addEventListener("change", () => {
    sendRequest({
      type: "CLIENTCONFIG",
          data: {
            fps: parseInt(fpsSlider.value),
            music_volume: parseInt(musicSlider.value) || 0,
            effects_volume: parseInt(effectsSlider.value) || 0,
            muted: mutedCheckbox.checked,
          } as ConfigData,
    });
  });
});

// Capture click and get coordinates from canvas
document.addEventListener("contextmenu", (event) => {
  if (!getIsLoaded()) return;
  if (getContextMenuKeyTriggered()) {
    event.preventDefault();
    setContextMenuKeyTriggered(false);
    return;
  }
  // Handle right-click on the UI
  if ((event.target as HTMLElement)?.classList.contains("ui")) {
    // Check if we clicked on a party member
    const partyMember = (event.target as HTMLElement).closest(".party-member") as HTMLElement;
    if (partyMember) {
      const username = partyMember.dataset.username;
      if (username) {
        createPartyContextMenu(event, username);
      }
      event.preventDefault();
      return;
    }
    return;
  }
  // Check where we clicked on the canvas
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;

  // Did we click on a player?
  const clickedPlayer = Array.from(cache.players).find(player => {
    const playerX = player.position.x + 16; // Center of the player
    const playerY = player.position.y + 24; // Center of the player
    return (
      x >= playerX - 16 && x <= playerX + 16 &&
      y >= playerY - 24 && y <= playerY + 24
    );
  });

  if (clickedPlayer) {
    const id = clickedPlayer.id;
    // Create context menu for the clicked player
    createContextMenu(event, id);
    return; // Stop further processing
  }

  // Remove any existing context menu
  const existingMenu = document.getElementById("context-menu");
  if (existingMenu) existingMenu.remove();
  const moveX = Math.floor(x - canvas.width / 2 - 16);
  const moveY = Math.floor(y - canvas.height / 2 - 24);
  sendRequest({
    type: "TELEPORTXY",
        data: { x: moveX, y: moveY },
  });
});

document.addEventListener("click", (event) => {
  // Check if we clicked on a player
  if (!getIsLoaded()) return;
  if ((event.target as HTMLElement)?.classList.contains("ui")) return;
  // If we don't click on the context menu, remove it
  const contextMenu = document.getElementById("context-menu");
  if (contextMenu && !contextMenu.contains(event.target as Node)) {
    contextMenu.remove();
  }

  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;

  const moveX = x - canvas.width / 2 - 16;
  const moveY = y - canvas.height / 2 - 24;
  // Untarget any currently targeted player
  const target = Array.from(cache.players).find(player => player.targeted);
  if (target) {
    target.targeted = false;
  }

  sendRequest({
    type: "SELECTPLAYER",
    data: { x: moveX, y: moveY },
  });
});

chatInput.addEventListener("focus", () => {
  stopMovement();
});

friendsListSearch.addEventListener("focus", () => {
  stopMovement();
});

chatInput.addEventListener("blur", () => {
  sendRequest({
    type: "MOVEXY",
    data: "ABORT",
  });
  pressedKeys.clear();
  setIsKeyPressed(false);
  setIsMoving(false);
});

friendsListSearch.addEventListener("input", () => {
  const searchTerm = friendsListSearch.value.toLowerCase();
  const friendItems = Array.from(friendsList.querySelectorAll('.friend-item')) as HTMLElement[];
  if (!searchTerm) {
    // If search term is empty, show all items
    friendItems.forEach(item => {
      item.style.display = 'block'; // Reset display to default
    });
    return;
  }

  friendItems.forEach(item => {
    const friendName = item.querySelector('.friend-name')?.textContent?.toLowerCase() || '';
    if (friendName.includes(searchTerm)) {
      item.style.display = 'block'; // Show matching items
    } else {
      item.style.display = 'none'; // Hide non-matching items
    }
  });
});