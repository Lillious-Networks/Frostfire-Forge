import { sendRequest, cachedPlayerId } from "./socket.js";
import Cache from "./cache.js";
import { cast } from "./input.js";
import { hideItemTooltip, setupItemTooltip, removeItemTooltip } from "./tooltip.js";
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
const xpBar = document.getElementById("xp-bar") as HTMLDivElement;
const levelContainer = document.getElementById("level-container") as HTMLDivElement;
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
const usernameLabel = document.getElementById("stats-screen-username-label") as HTMLDivElement;
const levelLabel = document.getElementById("stats-screen-level-label") as HTMLDivElement;
const healthLabel = document.getElementById("stats-screen-health-label") as HTMLDivElement;
const manaLabel = document.getElementById("stats-screen-mana-label") as HTMLDivElement;
const damageLabel = document.getElementById("stats-screen-damage-label") as HTMLDivElement;
const armorLabel = document.getElementById("stats-screen-armor-label") as HTMLDivElement;
const critChanceLabel = document.getElementById("stats-screen-crit-chance-label") as HTMLDivElement;
const critDamageLabel = document.getElementById("stats-screen-crit-damage-label") as HTMLDivElement;
const avoidanceLabel = document.getElementById("stats-screen-avoidance-label") as HTMLDivElement;
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
const equipmentLeftColumn = document.getElementById("equipment-left-column") as HTMLDivElement;
const equipmentRightColumn = document.getElementById("equipment-right-column") as HTMLDivElement;
const equipmentBottomCenter = document.getElementById("equipment-bottom-center") as HTMLDivElement;
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

// Add click support to hotbar slots
hotbarSlots.forEach((slot, index) => {
  slot.addEventListener("click", (event) => {
    event.preventDefault();
    cast(index);
  });
});

// Function to build hotbar configuration and save to server
function saveHotbarConfiguration() {
  const hotbarConfig: { [key: string]: string | null } = {};

  hotbarSlots.forEach((slot, index) => {
    const spellName = slot.dataset.spellName;
    hotbarConfig[index.toString()] = spellName || null;
  });

  // Send configuration to server
  sendRequest({
    type: "SAVE_HOTBAR",
    data: hotbarConfig
  });
}

// Add drag-and-drop support to hotbar slots
// Track if a successful hotbar-to-hotbar drop occurred
let successfulHotbarDrop = false;

hotbarSlots.forEach((slot, index) => {
  // Make hotbar slots draggable when shift is held
  slot.addEventListener("mousedown", (event: MouseEvent) => {
    if (event.shiftKey && slot.dataset.spellName) {
      slot.draggable = true;
    } else {
      slot.draggable = false;
    }
  });

  // Handle drag start from hotbar slot
  slot.addEventListener("dragstart", (event: DragEvent) => {
    if (!event.shiftKey || !slot.dataset.spellName) {
      event.preventDefault();
      return;
    }

    // Reset the flag at the start of each drag
    successfulHotbarDrop = false;

    if (event.dataTransfer) {
      // Mark this as a hotbar-to-hotbar drag
      event.dataTransfer.setData("hotbar-source-index", index.toString());
      event.dataTransfer.setData("text/plain", slot.dataset.spellName);

      const img = slot.querySelector("img") as HTMLImageElement;
      if (img) {
        event.dataTransfer.setData("image/src", img.src);
      }

      event.dataTransfer.effectAllowed = "move";
      slot.style.opacity = "0.5";
    }
  });

  // Handle drag end to detect if spell was dragged off hotbar
  slot.addEventListener("dragend", (event: DragEvent) => {
    slot.style.opacity = "1";
    slot.draggable = false;

    // Only clear if dropped outside hotbar and wasn't a successful hotbar-to-hotbar drop
    if (!successfulHotbarDrop && event.dataTransfer && event.dataTransfer.dropEffect === "none") {
      // Clear the slot since it was dragged off
      delete slot.dataset.spellName;
      slot.innerHTML = "";
      saveHotbarConfiguration();
    }

    // Reset the flag after handling dragend
    successfulHotbarDrop = false;
  });

  // Prevent default drag over behavior
  slot.addEventListener("dragover", (event: DragEvent) => {
    event.preventDefault();
    if (event.dataTransfer) {
      // Check if dragging from another hotbar slot
      const isHotbarDrag = event.dataTransfer.types.includes("hotbar-source-index");
      event.dataTransfer.dropEffect = isHotbarDrag ? "move" : "copy";
    }
    slot.style.backgroundColor = "rgba(255, 255, 255, 0.2)";
  });

  // Remove highlight when drag leaves
  slot.addEventListener("dragleave", () => {
    slot.style.backgroundColor = "";
  });

  // Handle drop
  slot.addEventListener("drop", (event: DragEvent) => {
    event.preventDefault();
    slot.style.backgroundColor = "";

    if (event.dataTransfer) {
      const sourceIndex = event.dataTransfer.getData("hotbar-source-index");
      const spellName = event.dataTransfer.getData("text/plain");
      const imageSrc = event.dataTransfer.getData("image/src");

      if (spellName) {
        // Check if this is a hotbar-to-hotbar drag (swap operation)
        if (sourceIndex !== "" && sourceIndex !== index.toString()) {
          const sourceSlot = hotbarSlots[parseInt(sourceIndex)];

          // Store target slot's current spell (if any)
          const targetSpellName = slot.dataset.spellName;
          const targetImg = slot.querySelector("img") as HTMLImageElement;
          const targetImageSrc = targetImg ? targetImg.src : null;

          // Move source spell to target slot
          slot.dataset.spellName = spellName;
          slot.innerHTML = "";

          if (imageSrc) {
            const iconImage = new Image();
            iconImage.src = imageSrc;
            iconImage.draggable = false;
            slot.appendChild(iconImage);
          } else {
            slot.innerText = spellName;
          }

          // Move target spell to source slot (or clear if empty)
          if (targetSpellName && targetSpellName !== "") {
            // Swap: move target spell to source slot
            sourceSlot.dataset.spellName = targetSpellName;
            sourceSlot.innerHTML = "";

            if (targetImageSrc) {
              const iconImage = new Image();
              iconImage.src = targetImageSrc;
              iconImage.draggable = false;
              sourceSlot.appendChild(iconImage);
            } else {
              sourceSlot.innerText = targetSpellName;
            }
          } else {
            // Target was empty, so clear source slot and mark it as empty
            delete sourceSlot.dataset.spellName;
            sourceSlot.innerHTML = "";
          }

          // Mark this as a successful hotbar-to-hotbar drop
          successfulHotbarDrop = true;
        } else {
          // Regular drag from spellbook to hotbar
          slot.dataset.spellName = spellName;
          slot.innerHTML = "";

          if (imageSrc) {
            const iconImage = new Image();
            iconImage.src = imageSrc;
            iconImage.draggable = false;
            slot.appendChild(iconImage);
          } else {
            slot.innerText = spellName;
          }
        }

        // Save hotbar configuration to server
        saveHotbarConfiguration();
      }
    }
  });

  // Right-click to clear hotbar slot
  slot.addEventListener("contextmenu", (event: MouseEvent) => {
    event.preventDefault();

    if (slot.dataset.spellName) {
      // Clear the slot
      delete slot.dataset.spellName;
      slot.innerHTML = "";

      // Save updated configuration
      saveHotbarConfiguration();
    }
  });
});

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

  // If stat sheet is open
  if (statUI.style.left === "10px") {
    // Close it (whether it's showing current player or inspected player)
    statUI.style.transition = "1s";
    statUI.style.left = "-570";
  } else {
    // If closed, open it with current player's stats
    sendRequest({ type: "INSPECTPLAYER", data: null });
  }
}

function createPartyUI(partyMembers: string[], players?: any[]) {
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

      // Create bars container
      const barsContainer = document.createElement("div");
      barsContainer.className = "party-member-bars ui";

      // Create health bar
      const healthBarContainer = document.createElement("div");
      healthBarContainer.className = "party-member-health-bar ui";
      const healthProgress = document.createElement("div");
      healthProgress.className = "party-member-health-progress ui green";
      healthProgress.style.setProperty("--health-scale", "1");
      healthBarContainer.appendChild(healthProgress);

      // Create stamina bar
      const staminaBarContainer = document.createElement("div");
      staminaBarContainer.className = "party-member-stamina-bar ui";
      const staminaProgress = document.createElement("div");
      staminaProgress.className = "party-member-stamina-progress ui";
      staminaProgress.style.setProperty("--stamina-scale", "1");
      staminaBarContainer.appendChild(staminaProgress);

      barsContainer.appendChild(healthBarContainer);
      barsContainer.appendChild(staminaBarContainer);

      memberElement.appendChild(usernameElement);
      memberElement.appendChild(barsContainer);
      partyContainer.appendChild(memberElement);

      // Initialize bars with current stats if player data is available
      if (players) {
        const playerData = players.find(p => p.username?.toLowerCase() === lowerName);
        if (playerData?.stats) {
          updatePartyMemberStats(
            member,
            playerData.stats.health,
            playerData.stats.total_max_health,
            playerData.stats.stamina,
            playerData.stats.total_max_stamina
          );
        }
      }
    }
  }
}

function updatePartyMemberStats(username: string, health: number, maxHealth: number, stamina: number, maxStamina: number) {
  const partyContainer = document.getElementById("party-container");
  if (!partyContainer) return;

  const lowerUsername = username.toLowerCase();
  const memberElement = partyContainer.querySelector(
    `.party-member[data-username="${lowerUsername}"]`
  ) as HTMLElement;

  if (!memberElement) return;

  const healthProgress = memberElement.querySelector(".party-member-health-progress") as HTMLElement;
  const staminaProgress = memberElement.querySelector(".party-member-stamina-progress") as HTMLElement;

  if (healthProgress && maxHealth > 0) {
    const healthPercent = (health / maxHealth) * 100;
    const healthScale = Math.max(0, Math.min(1, health / maxHealth));
    healthProgress.style.setProperty("--health-scale", healthScale.toString());

    // Update color based on health percentage
    let colorClass = "green";
    if (healthPercent < 30) {
      colorClass = "red";
    } else if (healthPercent < 50) {
      colorClass = "orange";
    } else if (healthPercent < 80) {
      colorClass = "yellow";
    }

    const current = Array.from(healthProgress.classList).find(c =>
      ["green", "yellow", "orange", "red"].includes(c)
    );

    if (current !== colorClass) {
      healthProgress.classList.remove("green", "yellow", "orange", "red");
      healthProgress.classList.add(colorClass);
    }
  }

  if (staminaProgress && maxStamina > 0) {
    const staminaScale = Math.max(0, Math.min(1, stamina / maxStamina));
    staminaProgress.style.setProperty("--stamina-scale", staminaScale.toString());
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
    interruptClone.style.bottom = "200px";
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
    castClone.style.bottom = "200px";
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

// Function to load hotbar configuration from server
function saveInventoryConfiguration() {
  const inventoryConfig: { [key: string]: string | null } = {};
  const inventorySlots = inventoryGrid.querySelectorAll(".slot");

  inventorySlots.forEach((slot, index) => {
    const itemName = (slot as HTMLElement).dataset.itemName;
    inventoryConfig[index.toString()] = itemName || null;
  });

  // Send configuration to server
  sendRequest({
    type: "SAVE_INVENTORY_CONFIG",
    data: inventoryConfig
  });
}

async function loadInventoryConfiguration(inventoryConfig: any, inventoryData: any[]) {
  // Create a map of items by name for quick lookup
  const itemMap: { [key: string]: any } = {};
  inventoryData.forEach(item => {
    itemMap[item.name] = item;
  });

  // Return sorted inventory data based on saved configuration
  const sortedInventory: any[] = [];
  const usedItems = new Set<string>();

  // First, add items in the configured order
  Object.keys(inventoryConfig).sort((a, b) => parseInt(a) - parseInt(b)).forEach(index => {
    const itemName = inventoryConfig[index];
    if (itemName && itemMap[itemName] && !usedItems.has(itemName)) {
      sortedInventory.push(itemMap[itemName]);
      usedItems.add(itemName);
    }
  });

  // Then add any items not in the configuration
  inventoryData.forEach(item => {
    if (!usedItems.has(item.name)) {
      sortedInventory.push(item);
    }
  });

  return sortedInventory;
}

async function loadHotbarConfiguration(hotbarConfig: any) {

  // Wait for spellbook images to be loaded
  const waitForSpellbookImages = async (maxAttempts = 50, delayMs = 100) => {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const spellbookSpells = document.querySelectorAll("#spell-book-container #grid .slot") as NodeListOf<HTMLDivElement>;
      const imagesExist = Array.from(spellbookSpells).some(slot => slot.querySelector("img"));

      if (imagesExist) {
        return true;
      }

      await new Promise(resolve => setTimeout(resolve, delayMs));
    }

    return false;
  };

  await waitForSpellbookImages();

  // Build spell image map from spellbook
  const spellbookSpells = document.querySelectorAll("#spell-book-container #grid .slot") as NodeListOf<HTMLDivElement>;
  const spellImageMap: { [key: string]: string } = {};

  spellbookSpells.forEach(slot => {
    const spellName = slot.dataset.spellName;
    const img = slot.querySelector("img") as HTMLImageElement;
    if (spellName && img) {
      spellImageMap[spellName] = img.src;
    }
  });

  // Load hotbar slots
  hotbarSlots.forEach((slot, index) => {
    const slotData = hotbarConfig[index.toString()];

    // Handle both string format "fireball" and object format { name: "fireball" }
    const spellName = typeof slotData === 'string' ? slotData : slotData?.name;

    if (spellName) {
      // Store spell name in data attribute
      slot.dataset.spellName = spellName;

      // Clear existing content
      slot.innerHTML = "";

      // Use image from spellbook if available
      const imageSrc = spellImageMap[spellName];
      if (imageSrc) {
        const iconImage = new Image();
        iconImage.src = imageSrc;
        iconImage.draggable = false;
        slot.appendChild(iconImage);
      } else {
        // Fallback to spell name text
        slot.innerText = spellName;
      }
    } else {
      // Clear the slot
      delete slot.dataset.spellName;
      slot.innerHTML = "";
    }
  });
}

export {
    toggleUI, toggleDebugContainer, handleStatsUI, createPartyUI, updatePartyMemberStats, updateHealthBar, updateStaminaBar, castSpell, positionText,
    friendsListUI, inventoryUI, spellBookUI, pauseMenu, menuElements, chatInput, canvas, ctx, fpsSlider, healthBar,
    staminaBar, xpBar, levelContainer, musicSlider, effectsSlider, mutedCheckbox, statUI, overlay,
    packetsSentReceived, optionsMenu, friendsList, friendsListSearch, onlinecount, progressBar, progressBarContainer,
    inventoryGrid, chatMessages, loadingScreen, usernameLabel, levelLabel, healthLabel, manaLabel, damageLabel, armorLabel, critChanceLabel, critDamageLabel, avoidanceLabel, notificationContainer, notificationMessage,
    serverTime, ambience, weatherCanvas, weatherCtx, guildContainer, guildName, guildRank, guildMembersList,
    guildMemberCount, guildMemberInviteInput, guildMemberInviteButton, collisionDebugCheckbox, chunkOutlineDebugCheckbox,
    collisionTilesDebugCheckbox, noPvpDebugCheckbox, wireframeDebugCheckbox, showGridCheckbox, loadedChunksText, collectablesUI,
    hotbarSlots, saveHotbarConfiguration, loadHotbarConfiguration, equipmentLeftColumn, equipmentRightColumn, equipmentBottomCenter,
    saveInventoryConfiguration, loadInventoryConfiguration, setupInventorySlotHandlers,
};

// Function to setup inventory slot drag and drop handlers
function setupInventorySlotHandlers() {
  const inventorySlots = inventoryGrid.querySelectorAll(".slot") as NodeListOf<HTMLDivElement>;

  inventorySlots.forEach((slot, index) => {
    // Double-click to equip (for equipment items)
    slot.addEventListener("dblclick", () => {
      if (slot.dataset.itemType === "equipment" && slot.dataset.itemName) {
        // Hide tooltip when equipping
        hideItemTooltip();

        sendRequest({
          type: "EQUIP_ITEM",
          data: { item: slot.dataset.itemName, slotIndex: index },
        });
      }
    });

    // Dragstart handler
    slot.addEventListener("dragstart", (event: DragEvent) => {
      if (!slot.draggable) {
        event.preventDefault();
        return;
      }

      // Hide tooltip when starting to drag
      hideItemTooltip();

      if (event.dataTransfer) {
        event.dataTransfer.setData("inventory-rearrange-index", index.toString());

        const itemName = slot.dataset.itemName;
        if (itemName) {
          event.dataTransfer.setData("inventory-item-name", itemName);
        }

        // If equipment type, also set equipment data
        if (slot.dataset.itemType === "equipment" && slot.dataset.equipmentSlot) {
          event.dataTransfer.setData("equipment-slot", slot.dataset.equipmentSlot);
        }

        event.dataTransfer.effectAllowed = "move";
        slot.style.opacity = "0.5";
      }
    });

    // Dragend handler
    slot.addEventListener("dragend", () => {
      slot.style.opacity = "1";
    });

    // Dragover handler
    slot.addEventListener("dragover", (event: DragEvent) => {
      event.preventDefault();
      if (event.dataTransfer) {
        if (event.dataTransfer.types.includes("inventory-rearrange-index") ||
            event.dataTransfer.types.includes("equipped-item-slot")) {
          event.dataTransfer.dropEffect = "move";
          slot.style.border = "2px solid white";
        }
      }
    });

    // Dragleave handler
    slot.addEventListener("dragleave", () => {
      slot.style.border = "";
    });

    // Drop handler
    slot.addEventListener("drop", (event: DragEvent) => {
      event.preventDefault();
      slot.style.border = "";

      if (event.dataTransfer) {
        // Check if dragging from equipment slot
        const equippedItemSlot = event.dataTransfer.getData("equipped-item-slot");
        const equippedItemName = event.dataTransfer.getData("equipped-item-name");

        if (equippedItemSlot && equippedItemName) {
          // Unequipping item to this inventory slot
          sendRequest({
            type: "UNEQUIP_ITEM",
            data: { slot: equippedItemSlot, targetSlotIndex: index },
          });
          return;
        }

        const sourceIndex = event.dataTransfer.getData("inventory-rearrange-index");
        const itemName = event.dataTransfer.getData("inventory-item-name");

        if (sourceIndex !== "" && sourceIndex !== index.toString()) {
          const sourceSlot = inventorySlots[parseInt(sourceIndex)];

          // Store target slot's current item data
          const targetItemName = slot.dataset.itemName;
          const targetItemType = slot.dataset.itemType;
          const targetEquipmentSlot = slot.dataset.equipmentSlot;
          const targetImg = slot.querySelector("img") as HTMLImageElement;
          const targetImgSrc = targetImg ? targetImg.src : null;
          const targetHTML = slot.innerHTML;
          const targetClasses = Array.from(slot.classList).filter(c => c !== "slot" && c !== "ui");

          // Move source item to target slot
          slot.innerHTML = "";
          slot.className = "slot ui";

          const sourceImg = sourceSlot.querySelector("img") as HTMLImageElement;
          if (sourceImg) {
            const newImg = new Image();
            newImg.src = sourceImg.src;
            newImg.draggable = false;
            newImg.width = 32;
            newImg.height = 32;
            newImg.style.pointerEvents = "none";
            slot.appendChild(newImg);
          }

          // Copy source item's quantity label if it exists
          const sourceQuantityLabel = sourceSlot.querySelector(".quantity-label");
          if (sourceQuantityLabel) {
            const newQuantityLabel = sourceQuantityLabel.cloneNode(true) as HTMLElement;
            newQuantityLabel.style.pointerEvents = "none";
            slot.appendChild(newQuantityLabel);
          }

          // Copy source item's datasets and classes
          if (sourceSlot.dataset.itemName) slot.dataset.itemName = sourceSlot.dataset.itemName;
          if (sourceSlot.dataset.itemType) slot.dataset.itemType = sourceSlot.dataset.itemType;
          if (sourceSlot.dataset.equipmentSlot) slot.dataset.equipmentSlot = sourceSlot.dataset.equipmentSlot;

          Array.from(sourceSlot.classList).forEach(cls => {
            if (cls !== "slot" && cls !== "ui") slot.classList.add(cls);
          });

          slot.draggable = true;

          // Re-attach tooltip to target slot with moved item
          const cache = Cache.getInstance();
          removeItemTooltip(slot);
          setupItemTooltip(slot, () => {
            const itemName = slot.dataset.itemName;
            if (!itemName || !cache.inventory) return null;
            return cache.inventory.find((invItem: any) => invItem.name === itemName);
          });

          // Move target item to source slot (or clear if empty)
          sourceSlot.innerHTML = "";
          sourceSlot.className = "slot ui";

          if (targetItemName) {
            // Swap: move target item to source slot
            if (targetImgSrc) {
              const newImg = new Image();
              newImg.src = targetImgSrc;
              newImg.draggable = false;
              newImg.width = 32;
              newImg.height = 32;
              newImg.style.pointerEvents = "none";
              sourceSlot.appendChild(newImg);

              // Copy quantity label if exists
              const targetQuantityLabel = document.createElement("div");
              const origQuantityLabel = targetHTML.match(/<div class="quantity-label">([^<]+)<\/div>/);
              if (origQuantityLabel) {
                targetQuantityLabel.classList.add("quantity-label");
                targetQuantityLabel.innerText = origQuantityLabel[1];
                targetQuantityLabel.style.pointerEvents = "none";
                sourceSlot.appendChild(targetQuantityLabel);
              }
            }

            if (targetItemName) sourceSlot.dataset.itemName = targetItemName;
            if (targetItemType) sourceSlot.dataset.itemType = targetItemType;
            if (targetEquipmentSlot) sourceSlot.dataset.equipmentSlot = targetEquipmentSlot;

            targetClasses.forEach(cls => sourceSlot.classList.add(cls));
            sourceSlot.draggable = true;

            // Re-attach tooltip to source slot with swapped item
            removeItemTooltip(sourceSlot);
            setupItemTooltip(sourceSlot, () => {
              const itemName = sourceSlot.dataset.itemName;
              if (!itemName || !cache.inventory) return null;
              return cache.inventory.find((invItem: any) => invItem.name === itemName);
            });
          } else {
            // Target was empty, so clear source slot
            delete sourceSlot.dataset.itemName;
            delete sourceSlot.dataset.itemType;
            delete sourceSlot.dataset.equipmentSlot;
            sourceSlot.classList.add("empty");
            sourceSlot.draggable = false;

            // Remove tooltip from now-empty source slot
            removeItemTooltip(sourceSlot);
          }

          // Save configuration
          saveInventoryConfiguration();
        }
      }
    });
  });
}