import query from "../controllers/sqldatabase";

const collectables = {
    async list(username: string) {
        return await query("SELECT item, type FROM collectables WHERE username = ?", [username]) as any[];
    },
    async add(collectable: Collectable) {
        if (!collectable?.type || !collectable?.item || !collectable?.username) return;
        // Check if collectable already exists for user
        const existing = await query(
            "SELECT * FROM collectables WHERE type = ? AND item = ? AND username = ?",
            [collectable.type, collectable.item, collectable.username]
        ) as any[];

        if (existing.length > 0) return;

        return await query(
            "INSERT INTO collectables (type, item, username) VALUES (?, ?, ?)",
            [collectable.type, collectable.item, collectable.username]
        );
    },
    async remove(collectable: Collectable) {
        if (!collectable?.type || !collectable?.item || !collectable?.username) return;
        return await query(
            "DELETE FROM collectables WHERE type = ? AND item = ? AND username = ?",
            [collectable.type, collectable.item, collectable.username]
        );
    },
    async find(collectable: Collectable) {
        if (!collectable?.type || !collectable?.item || !collectable?.username) return;
        const response = await query(
            "SELECT item, type FROM collectables WHERE type = ? AND item = ? AND username = ?",
            [collectable.type, collectable.item, collectable.username]
        ) as any[];
        if (response.length === 0) return;
        return response;
    }
}

export default collectables;