import { sendRequest, cachedPlayerId } from "./socket.js";
const debugContainer = document.getElementById("debug-container") as HTMLDivElement;
const statUI = document.getElementById("stat-screen") as HTMLDivElement;
const positionText = document.getElementById("position") as HTMLDivElement;
const friendsListUI = document.getElementById("friends-list-container") as HTMLDivElement;
const inventoryUI = document.getElementById("inventory") as HTMLDivElement;
const spellBookUI = document.getElementById("spell-book-container") as HTMLDivElement;
const pauseMenu = document.getElementById("pause-menu-container") as HTMLDivElement;
const menuElements = ["options-menu-container"];
const chatInput = document.getElementById("chat-input") as HTMLInputElement;
const canvas = document.getElementById("game") as HTMLCanvasElement;
const ctx = canvas.getContext("2d");
const fpsSlider = document.getElementById("fps-slider") as HTMLInputElement;
const healthBar = document.getElementById("health-progress-bar") as HTMLDivElement;
const staminaBar = document.getElementById("stamina-progress-bar") as HTMLDivElement;
const targetHealthBar = document.getElementById("target-health-progress-bar") as HTMLDivElement;
const targetStaminaBar = document.getElementById("target-stamina-progress-bar") as HTMLDivElement;
const xpBar = document.getElementById("xp-bar") as HTMLDivElement;
const musicSlider = document.getElementById("music-slider") as HTMLInputElement;
const effectsSlider = document.getElementById("effects-slider") as HTMLInputElement;
const mutedCheckbox = document.getElementById("muted-checkbox") as HTMLInputElement;
const overlay = document.getElementById("overlay") as HTMLDivElement;
const packetsSentReceived = document.getElementById("packets-sent-received") as HTMLDivElement;
const optionsMenu = document.getElementById("options-menu-container") as HTMLDivElement;
const friendsList = document.getElementById("friends-list-content") as HTMLDivElement;
const friendsListSearch = document.getElementById("friends-list-search") as HTMLInputElement;
const onlinecount = document.getElementById("onlinecount") as HTMLDivElement;
const progressBar = document.getElementById("progress-bar") as HTMLDivElement;
const progressBarContainer = document.getElementById("progress-bar-container") as HTMLDivElement;
const inventoryGrid = document.getElementById("grid") as HTMLDivElement;
const chatMessages = document.getElementById("chat-messages") as HTMLDivElement;
const loadingScreen = document.getElementById("loading-screen");
const healthLabel = document.getElementById("stats-screen-health-label") as HTMLDivElement;
const manaLabel = document.getElementById("stats-screen-mana-label") as HTMLDivElement;
const notificationContainer = document.getElementById("game-notification-container");
const notificationMessage = document.getElementById("game-notification-message");
const serverTime = document.getElementById("server-time-value") as HTMLDivElement;
const ambience = document.getElementById("ambience-overlay") as HTMLDivElement;
const weatherCanvas = document.getElementById("weather") as HTMLCanvasElement;
const weatherCtx = weatherCanvas.getContext("2d");
const guildContainer = document.getElementById("guild-container") as HTMLDivElement;
const guildName = document.getElementById("guild-name") as HTMLDivElement;
const guildRank = document.getElementById("guild-rank") as HTMLDivElement;
const guildMembersList = document.getElementById("guild-members-list") as HTMLDivElement;
const guildMemberCount = document.getElementById("guild-member-count") as HTMLDivElement;
const guildMemberInviteInput = document.getElementById("guild-invite-input") as HTMLInputElement;
const guildMemberInviteButton = document.getElementById("guild-invite-button") as HTMLButtonElement;
const collisionDebugCheckbox = document.getElementById("collision-debug-checkbox") as HTMLInputElement;
const chunkOutlineDebugCheckbox = document.getElementById("chunk-outline-debug-checkbox") as HTMLInputElement;
const collisionTilesDebugCheckbox = document.getElementById("collision-tiles-debug-checkbox") as HTMLInputElement;
const noPvpDebugCheckbox = document.getElementById("nopvp-debug-checkbox") as HTMLInputElement;
const wireframeDebugCheckbox = document.getElementById("wireframe-debug-checkbox") as HTMLInputElement;
const showGridCheckbox = document.getElementById("show-grid-checkbox") as HTMLInputElement;

function toggleUI(element: HTMLElement, toggleFlag: boolean, hidePosition: number) {
  element.style.transition = "1s";
  element.style.right = toggleFlag ? hidePosition.toString() : "10";
  return !toggleFlag;
}

function toggleDebugContainer() {
  debugContainer.style.display = debugContainer.style.display === "block" ? "none" : "block";
}

function handleStatsUI() {
  const isCurrentPlayerStats = statUI.getAttribute("data-id") === cachedPlayerId;
  if (statUI.style.left === "10px" && isCurrentPlayerStats) {
    statUI.style.transition = "1s";
    statUI.style.left = "-570";
  } else {
    sendRequest({ type: "INSPECTPLAYER", data: null });
  }
}

function createPartyUI(partyMembers: string[]) {
  const partyContainer = document.getElementById("party-container");
  if (!partyContainer) return;

  // If no party members, remove all current ones and exit
  if (partyMembers.length === 0) {
    const existingMembers = partyContainer.querySelectorAll(".party-member");
    existingMembers.forEach(member => partyContainer.removeChild(member));
    return;
  }

  const existingElements = Array.from(
    partyContainer.querySelectorAll(".party-member-username")
  );

  const existingNames = new Map<string, HTMLElement>();
  existingElements.forEach(el => {
    const name = el.textContent?.toLowerCase();
    if (name) {
      const container = el.closest(".party-member") as HTMLElement;
      if (container) {
        existingNames.set(name, container);
      }
    }
  });

  const desiredNames = new Set(partyMembers.map(name => name.toLowerCase()));

  // Remove members no longer in the list
  for (const [name, el] of existingNames.entries()) {
    if (!desiredNames.has(name)) {
      partyContainer.removeChild(el);
    }
  }

  // Sort alphabetically by username
  partyMembers.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  // Add new members
  for (const member of partyMembers) {
    const lowerName = member.toLowerCase();
    if (!existingNames.has(lowerName)) {
      const memberElement = document.createElement("div");
      memberElement.className = "party-member ui";
      memberElement.dataset.username = lowerName;

      const usernameElement = document.createElement("div");
      usernameElement.className = "party-member-username ui";
      usernameElement.innerText = member.charAt(0).toUpperCase() + member.slice(1);

      memberElement.appendChild(usernameElement);
      partyContainer.appendChild(memberElement);
    }
  }
}

function updateHealthBar(bar: HTMLDivElement, healthPercent: number) {
  const xscale = Math.max(0, Math.min(1, healthPercent / 100)) || 0;
  bar.animate([
    { transform: `scaleX(${xscale})` }
  ], {
    duration: 0,
    fill: 'forwards'
  });

  // Avoid clearing and re-adding class if unnecessary
  let colorClass = "green";
  if (healthPercent < 30) {
    colorClass = "red";
  } else if (healthPercent < 50) {
    colorClass = "orange";
  } else if (healthPercent < 80) {
    colorClass = "yellow";
  }

  const current = Array.from(bar.classList).find(c =>
    ["green", "yellow", "orange", "red"].includes(c)
  );

  if (current !== colorClass) {
    bar.classList.remove("green", "yellow", "orange", "red");
    bar.classList.add(colorClass);
  }

  // Ensure base class is set
  if (!bar.classList.contains("ui")) {
    bar.classList.add("ui");
  }
}

function updateStaminaBar(bar: HTMLDivElement, staminaPercent: number) {
  const xscale = Math.max(0, Math.min(1, staminaPercent / 100)) || 0;
  bar.animate([
    { transform: `scaleX(${xscale})` }
  ], {
    duration: 0,
    fill: 'forwards'
  });
}

export {
    toggleUI, toggleDebugContainer, handleStatsUI, createPartyUI, updateHealthBar, updateStaminaBar, positionText,
    friendsListUI, inventoryUI, spellBookUI, pauseMenu, menuElements, chatInput, canvas, ctx, fpsSlider, healthBar,
    staminaBar, targetHealthBar, targetStaminaBar, xpBar, musicSlider, effectsSlider, mutedCheckbox, statUI, overlay,
    packetsSentReceived, optionsMenu, friendsList, friendsListSearch, onlinecount, progressBar, progressBarContainer,
    inventoryGrid, chatMessages, loadingScreen, healthLabel, manaLabel, notificationContainer, notificationMessage,
    serverTime, ambience, weatherCanvas, weatherCtx, guildContainer, guildName, guildRank, guildMembersList,
    guildMemberCount, guildMemberInviteInput, guildMemberInviteButton, collisionDebugCheckbox, chunkOutlineDebugCheckbox,
    collisionTilesDebugCheckbox, noPvpDebugCheckbox, wireframeDebugCheckbox, showGridCheckbox
};