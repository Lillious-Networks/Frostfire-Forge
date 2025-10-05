import Cache from "./cache";
const cache = Cache.getInstance();
import {cachedPlayerId, sendRequest} from "./socket.js";
import { friendsList, friendsListSearch } from "./ui.js";



function updateFriendsList(data: any) {
    const currentPlayer = Array.from(cache.players).find(player => player.id === cachedPlayerId);
    if (!currentPlayer || !data?.friends) return;

    const list = Array.from(friendsList.querySelectorAll('.friend-name')) as HTMLElement[];

    // Step 1: Remove friends from UI that are no longer in data.friends
    list.forEach((item: HTMLElement) => {
        const name = item.innerText.toLowerCase();
        if (!data.friends.map((f: string) => f.toLowerCase()).includes(name)) {
            item.parentElement?.remove(); // Remove the whole friend-item div
        }
    });

    // Step 2: Add new friends from data.friends if they don't exist in UI
    data.friends.forEach((friend: string) => {
        const exists = list.some(item => item.innerText.toLowerCase() === friend.toLowerCase());
        if (!exists) {
            const friendElement = document.createElement("div");
            friendElement.classList.add("friend-item", "ui");

            const friendName = document.createElement("div");
            friendName.classList.add("friend-name");
            friendName.classList.add("ui");
            friendName.innerText = friend.charAt(0).toUpperCase() + friend.slice(1);
            friendElement.appendChild(friendName);

            const friendStatus = document.createElement("div");
            const isOnline = Array.from(cache.players).some(player => player.username && player.username.toLowerCase() === friend.toLowerCase() && player.id !== cachedPlayerId);
            friendStatus.classList.add("friend-status", isOnline ? "online" : "offline");
            friendStatus.classList.add("ui");
            friendStatus.innerText = isOnline ? "Online" : "Offline";
            friendElement.appendChild(friendStatus);

            // Create the remove button ("X")
            const removeButton = document.createElement("button");
            removeButton.innerText = "X";
            removeButton.classList.add("remove-friend-button");
            removeButton.classList.add("ui");

            // Add the click event handler
            removeButton.onclick = () => {
                sendRequest({
                    type: "REMOVE_FRIEND",
                    data: { username: friend },
                });
            };

            friendElement.appendChild(removeButton);
            friendsList.appendChild(friendElement);
        }
    });
}

function updateFriendOnlineStatus(friendName: string, isOnline: boolean) {
  setTimeout(() => {
    const list = Array.from(friendsList.querySelectorAll('.friend-name')) as HTMLElement[];
    if (!list.length) {
      return;
    }
    list.forEach((item: HTMLElement) => {
      const name = item.innerText.toLowerCase();
      if (name === friendName.toLowerCase()) {
        const statusElement = item.nextElementSibling as HTMLElement;
        if (statusElement) {
          statusElement.classList.toggle("online", isOnline);
          statusElement.classList.toggle("offline", !isOnline);
          statusElement.innerText = isOnline ? "Online" : "Offline";
        }
      }
    });
    }, 2000); // Delay to ensure the friends list is fully loaded
}

export { updateFriendsList, updateFriendOnlineStatus, friendsListSearch };