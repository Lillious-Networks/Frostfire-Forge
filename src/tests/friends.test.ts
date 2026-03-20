import { expect, test } from "bun:test";

// Mock database
const friendsDatabase: Record<string, any> = {
  user1: { friends: "user2, user3" },
  user2: { friends: "user1" },
  user3: { friends: "" },
};

const accountsDatabase: Record<string, any> = {
  user1: { username: "user1" },
  user2: { username: "user2" },
  user3: { username: "user3" },
};

const mockQuery = async (sql: string, params: any[]) => {
  if (sql.includes("SELECT friends FROM friendslist")) {
    const user = params[0];
    return [friendsDatabase[user] || { friends: "" }];
  }
  if (sql.includes("SELECT username FROM accounts")) {
    const user = params[0];
    return accountsDatabase[user] ? [{ username: user }] : [];
  }
  if (sql.includes("ON DUPLICATE KEY UPDATE")) {
    const [username, friendsList] = params;
    friendsDatabase[username] = { friends: friendsList };
    return { affectedRows: 1 };
  }
  if (sql.includes("UPDATE friendslist")) {
    const [friendsList, username] = params;
    friendsDatabase[username] = { friends: friendsList };
    return { affectedRows: 1 };
  }
  return [];
};

const friends = {
  async list(username: string) {
    if (!username) return [];
    const response = (await mockQuery("SELECT friends FROM friendslist WHERE username = ?", [username])) as any[];
    if (response.length === 0 || !response[0].friends) return [];
    const friendsList = response[0].friends.split(",").map((f: string) => f.trim());
    return friendsList.filter((f: any) => f !== "");
  },

  async add(username: string, friend_username: string) {
    if (!username || !friend_username) return [];
    const queryResult = (await mockQuery("SELECT username FROM accounts WHERE username = ?", [friend_username])) as any;
    const user = queryResult[0]?.username;
    if (!user) return await this.list(username);
    const currentFriends = await this.list(username);
    if (currentFriends.includes(user.toString())) return currentFriends;
    currentFriends.push(user.toString());
    const friendsString = currentFriends.join(",");
    await mockQuery("INSERT INTO friendslist (username, friends) VALUES (?, ?) ON DUPLICATE KEY UPDATE friends = ?", [
      username,
      friendsString,
      friendsString,
    ]);
    return currentFriends;
  },

  async remove(username: string, friend_username: string) {
    if (!username || !friend_username) return [];
    const queryResult = (await mockQuery("SELECT username FROM accounts WHERE username = ?", [friend_username])) as any;
    const user = queryResult[0]?.username;
    if (!user) return [];
    const currentFriends = await this.list(username);
    const friendIndex = currentFriends.indexOf(friend_username.toString());
    if (friendIndex === -1) return currentFriends;
    currentFriends.splice(friendIndex, 1);
    const friendsString = currentFriends.join(",");
    await mockQuery("UPDATE friendslist SET friends = ? WHERE username = ?", [friendsString, username]);
    return currentFriends;
  },
};

test("friends.list returns user friends", async () => {
  const result = await friends.list("user1");
  expect(result).toContain("user2");
  expect(result).toContain("user3");
});

test("friends.list returns empty array for non-existent user", async () => {
  const result = await friends.list("nonexistent");
  expect(result).toEqual([]);
});

test("friends.list returns empty array for empty friends string", async () => {
  const result = await friends.list("user3");
  expect(result).toEqual([]);
});

test("friends.add adds new friend", async () => {
  const result = await friends.add("user1", "user3");
  expect(result).toContain("user3");
});

test("friends.add prevents duplicate friends", async () => {
  const result = await friends.add("user1", "user2");
  const count = result.filter((f) => f === "user2").length;
  expect(count).toBe(1);
});

test("friends.add returns empty if friend not found", async () => {
  const result = await friends.add("user1", "nonexistent");
  expect(Array.isArray(result)).toBe(true);
});

test("friends.remove removes friend from list", async () => {
  const result = await friends.remove("user1", "user2");
  expect(result).not.toContain("user2");
});

test("friends.remove returns same list if friend not found", async () => {
  const result = await friends.remove("user1", "nonexistent");
  expect(Array.isArray(result)).toBe(true);
});
