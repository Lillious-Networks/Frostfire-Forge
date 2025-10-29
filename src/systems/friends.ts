import query from "../controllers/sqldatabase";
import log from "../modules/logger";

const friends = {
  async list(username: string) {
    if (!username) return [];
    try {
      const response = await query(
        "SELECT friends FROM friendslist WHERE username = ?",
        [username]
      ) as any[];
      if (response.length === 0 || !response[0].friends) {
        return [];
      }
      const friendsList = response[0].friends
        .split(",")
        .map((friend: string) => friend.trim());
      return friendsList.filter((friend: any) => friend !== "");
    } catch (error) {
      log.error(`Error listing friends for ${username}: ${error}`);
      return [];
    }
  },
  async add(username: string, friend_username: string) {
    if (!username || !friend_username) return [];

    try {
      const queryResult = (await query(
        "SELECT username FROM accounts WHERE username = ?",
        [friend_username]
      )) as any;
      console.log("Query Result:", queryResult);
      const user = queryResult[0]?.username;
      console.log("User:", user);
      if (!user) return await this.list(username);
      const currentFriends = await this.list(username);
      console.log("Current Friends:", currentFriends);

      if (currentFriends.includes(user.toString())) {
        return currentFriends; // Already a friend
      }

      currentFriends.push(user.toString());
      const friendsString = currentFriends.join(",");

      const result = (await query(
        "INSERT INTO friendslist (username, friends) VALUES (?, ?) ON DUPLICATE KEY UPDATE friends = ?",
        [username, friendsString, friendsString]
      )) as any;

      console.log(result);

      if (result.affectedRows > 0) {
        return currentFriends;
      } else {
        log.error(`Failed to add friend for ${username}`);
        return currentFriends;
      }
    } catch (error) {
      log.error(`Error adding friend for ${username}: ${error}`);
      return await this.list(username);
    }
  },
  async remove(username: string, friend_username: string) {
    console.log("Removing friend:", username, friend_username);
    if (!username || !friend_username) return [];

    try {
      // Check if the friend exists
      const queryResult = (await query(
        "SELECT username FROM accounts WHERE username = ?",
        [friend_username]
      )) as any;

      const user = queryResult[0]?.username;
      if (!user) return [];

      // Get current friends list
      const currentFriends = await this.list(username);

      // Find and remove the friend
      const friendIndex = currentFriends.indexOf(friend_username.toString());
      if (friendIndex === -1) {
        return currentFriends; // Friend not found, return current list
      }

      currentFriends.splice(friendIndex, 1); // Remove friend
      const friendsString = currentFriends.join(",");

      // Update the database
      const result = (await query(
        "UPDATE friendslist SET friends = ? WHERE username = ?",
        [friendsString, username]
      )) as any;

      console.log("Update result:", result);

      if (result.affectedRows > 0) {
        return currentFriends; // Return updated friends list
      } else {
        log.error(`Failed to remove friend for ${username}`);
        return currentFriends;
      }
    } catch (error) {
      log.error(`Error removing friend for ${username}: ${error}`);
      return [];
    }
  }
};

export default friends;
