import { sendRequest, cachedPlayerId } from "./socket.js";
import Cache from "./cache.js";
const debugContainer = document.getElementById("debug-container") as HTMLDivElement;
const statUI = document.getElementById("stat-screen") as HTMLDivElement;
const positionText = document.getElementById("position") as HTMLDivElement;
const friendsListUI = document.getElementById("friends-list-container") as HTMLDivElement;
const inventoryUI = document.getElementById("inventory") as HTMLDivElement;
const spellBookUI = document.getElementById("spell-book-container") as HTMLDivElement;
const collectablesUI = document.getElementById("collectables-container") as HTMLDivElement;
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
const loadedChunksText = document.getElementById("loaded-chunks") as HTMLDivElement;
const hotbar = document.getElementById("hotbar") as HTMLDivElement;
const hotbarGrid = hotbar.querySelector("#grid") as HTMLDivElement;
const hotbarSlots = hotbarGrid.querySelectorAll(".slot") as NodeListOf<HTMLDivElement>;
const castbar = document.getElementById("castbar") as HTMLDivElement;

// Track active castbar clone
let activeCastbarClone: HTMLDivElement | null = null;

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

function castSpell(id: string, spell: string, time: number) {
  spell = spell.toLowerCase();
  // Handle other players' casting (show castbar above their head)
  if (id !== cachedPlayerId) {
    const cache = Cache.getInstance();
    const player = Array.from(cache.players).find(p => p.id === id);

    if (player) {
      if (spell === 'interrupted' || spell === 'failed') {
        // Calculate current progress before interrupting
        if (player.castingSpell && !player.castingInterrupted) {
          const elapsed = performance.now() - player.castingStartTime;
          player.castingInterruptedProgress = Math.min(elapsed / player.castingDuration, 1);
        } else {
          player.castingInterruptedProgress = 0;
        }

        // Update spell name to show what failed/interrupted
        player.castingSpell = spell.charAt(0).toUpperCase() + spell.slice(1);
        player.castingInterrupted = true;
        player.castingStartTime = performance.now();
        player.castingDuration = 1500; // Show interrupted/failed for 1.5 seconds
      } else {
        // Format spell name (capitalize and remove underscores)
        const formattedSpell = spell.split('_').map(word =>
          word.charAt(0).toUpperCase() + word.slice(1)
        ).join(' ');

        player.castingSpell = formattedSpell;
        player.castingStartTime = performance.now();
        player.castingDuration = time * 1000;
        player.castingInterrupted = false;
        player.castingInterruptedProgress = undefined;
      }
    }
    return;
  }

  // Current player casting (DOM-based castbar at bottom of screen)
  let currentProgress = 0;
  if (activeCastbarClone && (spell == 'interrupted' || spell == 'failed')) {
    if (spell == 'failed') {
      // Failed always shows at 100%
      currentProgress = 1.0;
    } else {
      // Interrupted shows at current progress
      const cloneProgress = activeCastbarClone.querySelector("#castbar-progress") as HTMLDivElement;
      if (cloneProgress) {
        const animations = cloneProgress.getAnimations();
        for (const anim of animations) {
          if (anim.effect && (anim.effect as KeyframeEffect).getKeyframes().some((kf: any) => kf.transform)) {
            const currentTime = anim.currentTime as number;
            const duration = (anim.effect as AnimationEffect).getTiming().duration as number;
            if (currentTime && duration) {
              currentProgress = currentTime / duration;
            }
            break;
          }
        }
      }
    }
  }

  // Remove any existing active clone
  if (activeCastbarClone) {
    activeCastbarClone.remove();
    activeCastbarClone = null;
  }

  if (spell == 'interrupted' || spell == 'failed') {
    // Create interrupt clone
    const interruptClone = castbar.cloneNode(true) as HTMLDivElement;
    interruptClone.id = "castbar-active-clone";

    // Set display and positioning for the interrupt clone
    interruptClone.style.display = "block";
    interruptClone.style.position = "fixed";
    interruptClone.style.bottom = "100px";
    interruptClone.style.left = "50%";
    interruptClone.style.transform = "translateX(-50%)";
    interruptClone.style.width = "300px";
    interruptClone.style.height = "25px";
    interruptClone.style.zIndex = "100";

    // Get children directly (first child is progress, second is text based on HTML)
    const children = interruptClone.children;
    const clonedProgress = children[0] as HTMLDivElement;
    const clonedText = children[1] as HTMLDivElement;

    if (clonedProgress && clonedText) {
      // Set to current progress and color based on type
      clonedProgress.style.transform = `scaleX(${currentProgress})`;
      clonedProgress.style.transformOrigin = 'left';
      // Professional colors: red gradient for failed, grey gradient for interrupted
      if (spell === 'failed') {
        clonedProgress.style.background = 'linear-gradient(180deg, #ef4444 0%, #dc2626 50%, #b91c1c 100%)';
        clonedProgress.style.boxShadow = '0 0 20px rgba(239, 68, 68, 0.6), inset 0 2px 4px rgba(255, 255, 255, 0.2), inset 0 -2px 4px rgba(0, 0, 0, 0.3)';
      } else {
        clonedProgress.style.background = 'linear-gradient(180deg, #9ca3af 0%, #6b7280 50%, #4b5563 100%)';
        clonedProgress.style.boxShadow = '0 0 15px rgba(107, 114, 128, 0.4), inset 0 2px 4px rgba(255, 255, 255, 0.15), inset 0 -2px 4px rgba(0, 0, 0, 0.3)';
      }
      clonedText.innerText = spell;

      // Clear any animations
      clonedProgress.getAnimations().forEach(anim => anim.cancel());
    }

    // Insert the interrupt clone
    castbar.parentNode?.insertBefore(interruptClone, castbar.nextSibling);
    activeCastbarClone = interruptClone;

    // Remove after delay
    setTimeout(() => {
      if (activeCastbarClone === interruptClone) {
        interruptClone.remove();
        activeCastbarClone = null;
      }
    }, 1500);

    return;
  }

  // Normal spell cast - create a new clone for this cast
  const castClone = castbar.cloneNode(true) as HTMLDivElement;
  castClone.id = "castbar-active-clone";

  // Get children directly (first child is progress, second is text based on HTML)
  const children = castClone.children;
  const clonedProgress = children[0] as HTMLDivElement;
  const clonedText = children[1] as HTMLDivElement;


  if (clonedProgress && clonedText) {
    // Set display to block and copy essential positioning styles
    castClone.style.display = "block";
    castClone.style.position = "fixed";
    castClone.style.bottom = "100px";
    castClone.style.left = "50%";
    castClone.style.transform = "translateX(-50%)";
    castClone.style.width = "300px";
    castClone.style.height = "25px";
    castClone.style.zIndex = "100";

    // Reset progress to 0 and ensure gradient is used
    clonedProgress.style.transform = 'scaleX(0)';
    clonedProgress.style.transformOrigin = 'left';
    clonedProgress.style.background = '';

    // Format spell name
    const formattedSpell = spell.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
    clonedText.innerText = formattedSpell;

    const timeMs = time * 1000;

    // Animate the clone
    clonedProgress.animate([
      { transform: 'scaleX(0)' },
      { transform: 'scaleX(1)' }
    ], {
      duration: timeMs,
      fill: 'forwards'
    });

    castbar.parentNode?.insertBefore(castClone, castbar.nextSibling);
    activeCastbarClone = castClone;

    // Remove after cast completes
    setTimeout(() => {
      if (activeCastbarClone === castClone) {
        castClone.remove();
        activeCastbarClone = null;
      }
    }, timeMs + 100);
  }
}

export {
    toggleUI, toggleDebugContainer, handleStatsUI, createPartyUI, updateHealthBar, updateStaminaBar, castSpell, positionText,
    friendsListUI, inventoryUI, spellBookUI, pauseMenu, menuElements, chatInput, canvas, ctx, fpsSlider, healthBar,
    staminaBar, targetHealthBar, targetStaminaBar, xpBar, musicSlider, effectsSlider, mutedCheckbox, statUI, overlay,
    packetsSentReceived, optionsMenu, friendsList, friendsListSearch, onlinecount, progressBar, progressBarContainer,
    inventoryGrid, chatMessages, loadingScreen, healthLabel, manaLabel, notificationContainer, notificationMessage,
    serverTime, ambience, weatherCanvas, weatherCtx, guildContainer, guildName, guildRank, guildMembersList,
    guildMemberCount, guildMemberInviteInput, guildMemberInviteButton, collisionDebugCheckbox, chunkOutlineDebugCheckbox,
    collisionTilesDebugCheckbox, noPvpDebugCheckbox, wireframeDebugCheckbox, showGridCheckbox, loadedChunksText, collectablesUI,
    hotbarSlots,
};