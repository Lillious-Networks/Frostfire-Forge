import query from "../controllers/sqldatabase";
import log from "../modules/logger";
import { rowCache, turns } from "../services/datacache";
import player from "./player";

/** A row of the friendslist table: `friends` is the comma-separated list. */
type FriendsRow = { friends: string };

// Each player's rows of the friends list, as the table has them: one, or none
// for a player who has never added a friend. Reads are answered from these,
// and every change below is written to the database and then to them.
const rows = rowCache<FriendsRow[]>("friends", async (username) =>
  (await query("SELECT friends FROM friendslist WHERE username = ?", [username])) as FriendsRow[] || []
, { perPlayer: true });

// One write to a player's list at a time: statements sent side by side reach
// the database in no set order, so the rows held could end as one left them
// and the table as the other did.
const oneAtATime = turns();

/**
 * A write of a player's list: the statement, then what it left as the rows
 * held. A statement that fails may still have been written (one that timed
 * out, say), so the rows are forgotten and the next read asks the database.
 */
function write(username: string, sql: string, values: unknown[], left: (held: FriendsRow[]) => FriendsRow[]): Promise<any> {
  return oneAtATime(username, async () => {
    const held = (await rows.get(username)) ?? [];
    try {
      const result = await query(sql, values);
      await rows.set(username, left(held));
      return result;
    } catch (error) {
      await rows.drop(username);
      throw error;
    }
  });
}

const friends = {
  async list(username: string) {
    if (!username) return [];
    try {
      const response = (await rows.get(username)) ?? [];
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
      // Whether there is such an account is the player system's to say, from the accounts it holds.
      const account = (await player.findByUsername(friend_username)) as { username: string }[] | undefined;
      const user = account?.[0]?.username;
      if (!user) return await this.list(username);
      const currentFriends = await this.list(username);

      if (currentFriends.includes(user.toString())) {
        return currentFriends;
      }

      currentFriends.push(user.toString());
      const friendsString = currentFriends.join(",");

      const result = await write(
        username,
        "INSERT INTO friendslist (username, friends) VALUES (?, ?) ON DUPLICATE KEY UPDATE friends = ?",
        [username, friendsString, friendsString],
        () => [{ friends: friendsString }]
      );

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
    if (!username || !friend_username) return [];

    try {

      const account = (await player.findByUsername(friend_username)) as { username: string }[] | undefined;
      const user = account?.[0]?.username;
      if (!user) return [];

      const currentFriends = await this.list(username);

      const friendIndex = currentFriends.indexOf(friend_username.toString());
      if (friendIndex === -1) {
        return currentFriends;
      }

      currentFriends.splice(friendIndex, 1);
      const friendsString = currentFriends.join(",");

      const result = await write(
        username,
        "UPDATE friendslist SET friends = ? WHERE username = ?",
        [friendsString, username],
        (held) => held.map((row) => ({ ...row, friends: friendsString }))
      );

      if (result.affectedRows > 0) {
        return currentFriends;
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
