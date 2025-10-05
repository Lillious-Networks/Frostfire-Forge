import { cachedPlayerId, sendRequest, getIsLoaded } from './socket.js';
import Cache from "./cache";
const cache = Cache.getInstance();
import { overlay } from './ui.js';

const partyContextActions: Record<string, { only_self: boolean, allowed_self: boolean, label: string, handler: (username: string) => void }> = {
  'kick-player': {
    label: 'Kick',
    allowed_self: false,
    only_self: false,
    handler: (username) => {
      sendRequest({
        type: "KICK_PARTY_MEMBER",
        data: { username: username },
      });
    }
  },
  'leave-party': {
    label: 'Leave Party',
    allowed_self: true,
    only_self: true,
    handler: (username) => {
      sendRequest({
        type: "LEAVE_PARTY",
        data: { username: username },
      });
    }
  },
}

const contextActions: Record<string, { allowed_self: boolean, label: string, handler: (id: string) => void }> = {
  'inspect-player': {
    label: 'Inspect',
    allowed_self: true,
    handler: (id) => {
      console.log(`Inspecting player ${id}`);
    }
  },
  'send-message': {
    label: 'Send Message',
    allowed_self: false,
    handler: (id) => {
      // Update the document to add /w and the player's username
      const chatInput = document.getElementById("chat-input") as HTMLInputElement;
      const username = Array.from(cache.players).find(player => player.id === id)?.username;
      if (!username) return;
      chatInput.value = `/w ${username} `;
      chatInput.focus();
    }
  },
  'invite-to-party': {
    label: 'Invite to Party',
    allowed_self: false,
    handler: (id) => {
      sendRequest({
        type: "INVITE_PARTY",
        data: { id: id },
      });
    }
  },
  'add-friend': {
    label: 'Add Friend',
    allowed_self: false,
    handler: (id) => {
      sendRequest({
        type: "ADD_FRIEND",
        data: { id: id },
      });
    }
  },
  'remove-friend': {
    label: 'Remove Friend',
    allowed_self: false,
    handler: (id) => {
      sendRequest({
        type: "REMOVE_FRIEND",
        data: { id: id },
      });
    }
  },
  'invite-to-guild': {
    label: 'Invite to Guild',
    allowed_self: false,
    handler: (id) => {
      console.log(`Inviting ${id} to guild`);
    }
  },
  'block-player': {
    label: 'Block Player',
    allowed_self: false,
    handler: (id) => {
      console.log(`Blocking player ${id}`);
    }
  },
  'report-player': {
    label: 'Report Player',
    allowed_self: false,
    handler: (id) => {
      console.log(`Reporting player ${id}`);
    }
  },
};

function createPartyContextMenu(event: MouseEvent, username: string) {
  if (!getIsLoaded()) return;
  document.getElementById("context-menu")?.remove();

  const contextMenu = document.createElement("div");
  contextMenu.id = 'context-menu';
  contextMenu.style.left = `${event.clientX}px`;
  contextMenu.style.top = `${event.clientY}px`;

  // If we are off the screen, adjust position
  if (event.clientX + 200 > window.innerWidth) {
    contextMenu.style.left = `${event.clientX - 200}px`;
  }

  if (event.clientX - 200 < 0) {
    contextMenu.style.left = `${event.clientX + 50}px`;
  }

  if (event.clientY + 150 > window.innerHeight) {
    contextMenu.style.top = `${event.clientY - 150}px`;
  }

  if (event.clientY - 150 < 0) {
    contextMenu.style.top = `${event.clientY + 50}px`;
  }

  contextMenu.dataset.username = username.toLowerCase();
  const ul = document.createElement("ul");
  const currentPlayer = Array.from(cache.players).find(player => player.id === cachedPlayerId);
  const isSelf = currentPlayer?.username.toLowerCase() === username.toLowerCase();
  Object.entries(partyContextActions).forEach(([action, { label, handler, only_self, allowed_self }]) => {
    if (only_self && !isSelf) return; // Skip actions that are only for self
    if (!allowed_self && isSelf) return; // Skip actions that are not allowed for self

    const li = document.createElement("li");
    li.id = `context-${action}`;
    li.innerText = label;

    li.onclick = (e) => {
      e.stopPropagation();
      handler(username);
      contextMenu.remove();
    };

    ul.appendChild(li);
  });

  contextMenu.appendChild(ul);
  overlay.appendChild(contextMenu);
  document.addEventListener("click", () => contextMenu.remove(), { once: true });
}

function createContextMenu(event: MouseEvent, id: string) {
  if (!getIsLoaded()) return;
  document.getElementById("context-menu")?.remove();

  const contextMenu = document.createElement("div");
  contextMenu.id = 'context-menu';
  contextMenu.style.left = `${event.clientX}px`;
  contextMenu.style.top = `${event.clientY}px`;
  // If we are off the screen, adjust position
  if (event.clientX + 200 > window.innerWidth) {
    contextMenu.style.left = `${event.clientX - 200}px`;
  }

  if (event.clientX - 200 < 0) {
    contextMenu.style.left = `${event.clientX + 50}px`;
  }

  if (event.clientY + 150 > window.innerHeight) {
    contextMenu.style.top = `${event.clientY - 150}px`;
  }

  if (event.clientY - 150 < 0) {
    contextMenu.style.top = `${event.clientY + 50}px`;
  }
  
  contextMenu.dataset.id = id;

  const ul = document.createElement("ul");
  const isSelf = id === cachedPlayerId;
  const currentPlayer = Array.from(cache.players).find(player => player.id === cachedPlayerId);
  const targetedPlayer = Array.from(cache.players).find(player => player.id === id);
  const isFriend = currentPlayer?.friends?.includes(targetedPlayer?.username?.toString()) || false;
  const isInParty = currentPlayer?.party?.includes(targetedPlayer?.username?.toString()) || false;

  Object.entries(contextActions).forEach(([action, { label, handler, allowed_self }]) => {
    if (!allowed_self && isSelf) return;

    // Skip "invite-to-party" if already in party
    if (action === 'invite-to-party' && isInParty) return;

    // Skip "add-friend" if already friends
    if (action === 'add-friend' && isFriend) return;

    // Skip "remove-friend" if not friends
    if (action === 'remove-friend' && !isFriend) return;

    const li = document.createElement("li");
    li.id = `context-${action}`;
    li.innerText = label;

    li.onclick = (e) => {
      e.stopPropagation();
      handler(id);
      contextMenu.remove();
    };

    ul.appendChild(li);
  });

  contextMenu.appendChild(ul);
  overlay.appendChild(contextMenu);

  document.addEventListener("click", () => contextMenu.remove(), { once: true });
}

export { partyContextActions, contextActions, createPartyContextMenu, createContextMenu };