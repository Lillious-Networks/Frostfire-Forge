import query from "../controllers/sqldatabase";
import { rowCache, turns } from "../services/datacache";

const max_copper = 99;
const max_silver = 99;
const max_gold = 9999999;

/** The most of each coin a balance holds. */
export const CURRENCY_LIMITS: Currency = { copper: max_copper, silver: max_silver, gold: max_gold };

// Each player's balance (null: they have no row).
const rows = rowCache<Currency>("currency", async (username) => {
    const response = await query("SELECT copper, silver, gold FROM currency WHERE username = ?", [username]) as Currency[];
    return response[0] ?? null;
}, { perPlayer: true });

// One change to a player's balance at a time. Adding and removing work from the balance held and write the new
// one, so two running side by side would both start from the same balance and one of them would be lost; and
// statements sent side by side reach the database in no set order.
const oneAtATime = turns();

/** Whether an INT column holds `value` as it was given. Any other number the database rounds or clips its own way. */
const storedAsGiven = (value: unknown) => Number.isInteger(value) && Math.abs(value as number) <= 2147483647;

/** set, for a change already taking its turn. */
async function write(username: string, currencyData: Currency) {
    if (!username || !currencyData) return;
    const { copper, silver, gold } = currencyData;
    try {
        await query(
            "INSERT INTO currency (username, copper, silver, gold) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE copper = ?, silver = ?, gold = ?",
            [username, copper, silver, gold, copper, silver, gold]
        );
    } catch (error) {
        // A write that threw may still have been made (one that timed out, say): the balance held is forgotten
        // and the next read loads it.
        await rows.drop(username);
        throw error;
    }
    // The row is now what was written, unless the database does not store that as given: then it is read again.
    if ([copper, silver, gold].every(storedAsGiven)) await rows.set(username, { copper, silver, gold });
    else await rows.drop(username);
}

const currency = {
    async get(username: string): Promise<Currency> {
        if (!username) return { copper: 0, silver: 0, gold: 0 };
        return (await rows.get(username)) ?? { copper: 0, silver: 0, gold: 0 };
    },
    async set(username: string, currencyData: Currency) {
        if (!username || !currencyData) return;
        await oneAtATime(username, () => write(username, currencyData));
    },
    async add(username: string, amount: Currency) : Promise<Currency> {
        if (amount.copper < 0 || amount.silver < 0 || amount.gold < 0) return { copper: 0, silver: 0, gold: 0 };

        return oneAtATime(username, async () => {
            const currentCurrency = await this.get(username);
            if (!currentCurrency) return { copper: 0, silver: 0, gold: 0 };

            const totalCopper = currentCurrency.copper + amount.copper;
            const copperOverflow = Math.floor(totalCopper / (max_copper + 1));
            currentCurrency.copper = totalCopper % (max_copper + 1);

            const totalSilver = currentCurrency.silver + copperOverflow + amount.silver;
            const silverOverflow = Math.floor(totalSilver / (max_silver + 1));
            currentCurrency.silver = Math.min(max_silver, totalSilver % (max_silver + 1));

            const totalGold = currentCurrency.gold + silverOverflow + amount.gold;
            currentCurrency.gold = Math.min(max_gold, totalGold);

            await write(username, currentCurrency);
            return currentCurrency;
        });
    },
    async remove(username: string, amount: Currency) : Promise<Currency> {
        if (amount.copper < 0 || amount.silver < 0 || amount.gold < 0) return { copper: 0, silver: 0, gold: 0 };

        return oneAtATime(username, async () => {
            const currentCurrency = await this.get(username);
            if (!currentCurrency) return { copper: 0, silver: 0, gold: 0 };

            let totalCopper = currentCurrency.copper - amount.copper;
            if (totalCopper < 0) {
                const borrowFromSilver = Math.ceil(-totalCopper / (max_copper + 1));
                currentCurrency.silver -= borrowFromSilver;
                totalCopper += borrowFromSilver * (max_copper + 1);
            }
            currentCurrency.copper = Math.max(0, totalCopper);

            let totalSilver = currentCurrency.silver - amount.silver;
            if (totalSilver < 0) {
                const borrowFromGold = Math.ceil(-totalSilver / (max_silver + 1));
                currentCurrency.gold -= borrowFromGold;
                totalSilver += borrowFromGold * (max_silver + 1);
            }
            currentCurrency.silver = Math.max(0, totalSilver);

            currentCurrency.gold = Math.max(0, currentCurrency.gold - amount.gold);

            await write(username, currentCurrency);
            return currentCurrency;
        });
    },
};

export default currency;