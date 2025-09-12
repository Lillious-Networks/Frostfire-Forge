import { sendRequest, getIsLoaded } from "./socket.js";
import Cache from "./cache";
const cache = Cache.getInstance();
import { toggleUI, toggleDebugContainer, handleStatsUI } from "./ui.js";
import { handleCommand, handleChatMessage } from "./chat.js";
import { setDirection, setPendingRequest } from "./renderer.js";
import { chatInput } from "./chat.js";
import { friendsListSearch } from "./friends.js";
import { inventoryUI, spellBookUI, friendsListUI, pauseMenu, menuElements } from "./ui.js";
let userHasInteracted: boolean = false;
let lastSentDirection = "";

let toggleInventory = false;
let toggleSpellBook = false;
let toggleFriendsList = false;
let controllerConnected: boolean = false;
let contextMenuKeyTriggered = false;
let isKeyPressed = false;
let isMoving = false;
const pressedKeys = new Set();
const movementKeys = new Set(["KeyW", "KeyA", "KeyS", "KeyD"]);
let lastTypingPacket = 0;
const cooldowns: { [key: string]: number } = {};
const COOLDOWN_DURATION = 500; // milliseconds

export const keyHandlers = {
  F2: () => toggleDebugContainer(),
  Escape: () => handleEscapeKey(),
  KeyB: () => {
    toggleInventory = toggleUI(inventoryUI, toggleInventory, -350);
  },
  KeyP: () => {
    if (toggleFriendsList) {
      toggleFriendsList = toggleUI(friendsListUI, toggleFriendsList, -425);
    }

    toggleSpellBook = toggleUI(spellBookUI, toggleSpellBook, -425);
  },
  KeyO: () => {
    if (toggleSpellBook) {
      toggleSpellBook = toggleUI(spellBookUI, toggleSpellBook, -425);
    }

    toggleFriendsList = toggleUI(friendsListUI, toggleFriendsList, -425);
  },
  KeyC: () => handleStatsUI(),
  KeyX: () => sendRequest({ type: "STEALTH", data: null }),
  KeyZ: () => sendRequest({ type: "NOCLIP", data: null }),
  Enter: async () => handleEnterKey(),
  Space: () => handleSpaceKey(),
} as const;

// Movement keys configuration
const blacklistedKeys = new Set([
  'ContextMenu',
  'AltLeft',
  'AltRight',
  'ControlLeft',
  'ControlRight',
  'ShiftLeft',
  'ShiftRight',
  'F1',
  'F3',
  'F4',
  'F5',
  'F6',
  'F7',
  'F8',
  'F9',
  'F10',
  'Tab',
]);

function handleEscapeKey() {
  stopMovement();
  chatInput.blur();
  
  const isPauseMenuVisible = pauseMenu.style.display === "block";
  pauseMenu.style.display = isPauseMenuVisible ? "none" : "block";
  
  // Close other menus
  menuElements.forEach(elementId => {
    const element = document.getElementById(elementId);
    if (element?.style.display === "block") {
      element.style.display = "none";
    }
  });
}

async function handleEnterKey() {
  // Check if friendslist search is focused
  if (friendsListSearch === document.activeElement) return;
  const isTyping = chatInput === document.activeElement;
  
  if (!isTyping) {
    
    chatInput.focus();
    return;
  }

  sendRequest({ type: "STOPTYPING", data: null });
  
  const message = chatInput.value.trim();
  if (!message) {
    chatInput.value = "";
    chatInput.blur();
    return;
  }

  if (message.startsWith("/")) {
    await handleCommand(message);
  } else {
    await handleChatMessage(message);
  }

  chatInput.value = "";
}

function handleSpaceKey() {
  const target = cache.players.find(player => player.targeted);
  if (target) {
    sendRequest({ type: "ATTACK", data: target });
  }
}

function handleKeyPress() {
  if (!getIsLoaded() || controllerConnected || pauseMenu.style.display === "block" || isMoving) return;
  isMoving = true;
  setDirection("");
  setPendingRequest(false);
}

function stopMovement() {
  // Send abort packet when chat is opened
  sendRequest({
    type: "MOVEXY",
    data: "ABORT",
  });
  // Clear pressed keys to prevent continued movement
  pressedKeys.clear();
  isKeyPressed = false;
  isMoving = false;
}

function setIsMoving(value: boolean) {
  isMoving = value;
}

function getIsMoving() {
  return isMoving;
}

function getUserHasInteracted() {
    return userHasInteracted;   
}

function setUserHasInteracted(value: boolean) {
    userHasInteracted = value;   
}

function getControllerConnected() {
    return controllerConnected;
}

function setControllerConnected(value: boolean) {
    controllerConnected = value;
}

function getLastSentDirection() {
    return lastSentDirection;
}

function setLastSentDirection(value: string) {
    lastSentDirection = value;
}

function getLastTypingPacket() {
    return lastTypingPacket;
}

function setLastTypingPacket(value: number) {
    lastTypingPacket = value;
}

function getContextMenuKeyTriggered() {
    return contextMenuKeyTriggered;
}

function setContextMenuKeyTriggered(value: boolean) {
    contextMenuKeyTriggered = value;
}

function getIsKeyPressed() {
    return isKeyPressed;
}

function setIsKeyPressed(value: boolean) {
    isKeyPressed = value;
}

export {
    getIsKeyPressed, setIsKeyPressed, pressedKeys, movementKeys, handleKeyPress, stopMovement, setIsMoving, getIsMoving, getUserHasInteracted, setUserHasInteracted,
    getControllerConnected, setControllerConnected, getLastSentDirection, setLastSentDirection, getLastTypingPacket,
    setLastTypingPacket, cooldowns, COOLDOWN_DURATION, getContextMenuKeyTriggered, setContextMenuKeyTriggered, blacklistedKeys
};
