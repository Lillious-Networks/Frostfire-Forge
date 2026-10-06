import query, { type TransactionStatement } from "../controllers/sqldatabase";
import { rowCache, turns } from "../services/datacache";
import type { Batch } from "../services/batch";

const max_copper = 99;
const max_silver = 99;
const max_gold = 9999999;

/** The most of each coin a balance holds. */
export const CURRENCY_LIMITS: Currency = { copper: max_copper, silver: max_silver, gold: max_gold };

/** What coins come to, counted in copper. */
export const coinsWorth = ({ copper, silver, gold }: Currency) => (gold * (max_silver + 1) + silver) * (max_copper + 1) + copper;

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

/** The statement that makes a player's balance `currencyData`. */
const saving = (username: string, { copper, silver, gold }: Currency): TransactionStatement => ({
    sql: "INSERT INTO currency (username, copper, silver, gold) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE copper = ?, silver = ?, gold = ?",
    values: [username, copper, silver, gold, copper, silver, gold],
});

/** After a write: the row is now what was written, unless the database does not store that as given: then it is read again. */
async function hold(username: string, { copper, silver, gold }: Currency) {
    if ([copper, silver, gold].every(storedAsGiven)) await rows.set(username, { copper, silver, gold });
    else await rows.drop(username);
}

/** set, for a change already taking its turn. */
async function write(username: string, currencyData: Currency) {
    if (!username || !currencyData) return;
    const statement = saving(username, currencyData);
    try {
        await query(statement.sql, statement.values);
    } catch (error) {
        // A write that threw may still have been made (one that timed out, say): the balance held is forgotten
        // and the next read loads it.
        await rows.drop(username);
        throw error;
    }
    await hold(username, currencyData);
}

/** `balance` with `amount` put in: copper carries into silver and silver into gold, each up to its limit. */
function plus(balance: Currency, amount: Currency): Currency {
    const totalCopper = balance.copper + amount.copper;
    const copperOverflow = Math.floor(totalCopper / (max_copper + 1));
    const copper = totalCopper % (max_copper + 1);

    const totalSilver = balance.silver + copperOverflow + amount.silver;
    const silverOverflow = Math.floor(totalSilver / (max_silver + 1));
    const silver = Math.min(max_silver, totalSilver % (max_silver + 1));

    const gold = Math.min(max_gold, balance.gold + silverOverflow + amount.gold);
    return { copper, silver, gold };
}

/** `balance` with `amount` taken out: copper borrows from silver and silver from gold, and nothing goes below none. */
function minus(balance: Currency, amount: Currency): Currency {
    let { silver, gold } = balance;

    let totalCopper = balance.copper - amount.copper;
    if (totalCopper < 0) {
        const borrowFromSilver = Math.ceil(-totalCopper / (max_copper + 1));
        silver -= borrowFromSilver;
        totalCopper += borrowFromSilver * (max_copper + 1);
    }
    const copper = Math.max(0, totalCopper);

    let totalSilver = silver - amount.silver;
    if (totalSilver < 0) {
        const borrowFromGold = Math.ceil(-totalSilver / (max_silver + 1));
        gold -= borrowFromGold;
        totalSilver += borrowFromGold * (max_silver + 1);
    }
    silver = Math.max(0, totalSilver);

    gold = Math.max(0, gold - amount.gold);
    return { copper, silver, gold };
}

/** A player's balance as `batch` has it so far, the first time with this system's turn taken until the batch ends. */
async function pendingIn(batch: Batch, username: string): Promise<{ balance: Currency; written: boolean }> {
    await batch.hold(oneAtATime, username);
    return batch.pending(rows, username, async () => {
        const pending = { balance: await currency.get(username), written: false };
        // A batch that only looked at the balance leaves the one held as it is.
        batch.kept(() => (pending.written ? hold(username, pending.balance) : undefined));
        batch.undone(() => (pending.written ? rows.drop(username) : undefined));
        return pending;
    });
}

/**
 * A change to a player's balance as part of `batch` (see services/batch): worked from the balance
 * the batch has so far, with this system's turn taken until the batch ends. Its statement is added
 * to the batch; the balance becomes the one held once the batch is kept, and the one held is
 * forgotten if it is not.
 */
async function changeIn(batch: Batch, username: string, next: (balance: Currency) => Currency): Promise<Currency> {
    const state = await pendingIn(batch, username);
    state.balance = next(state.balance);
    batch.add(saving(username, state.balance));
    return { ...state.balance };
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
    /** The balance after. With a `batch`, the write is added to it instead of sent (see changeIn). */
    async add(username: string, amount: Currency, batch?: Batch) : Promise<Currency> {
        if (amount.copper < 0 || amount.silver < 0 || amount.gold < 0) return { copper: 0, silver: 0, gold: 0 };
        if (batch) return changeIn(batch, username, (balance) => plus(balance, amount));

        return oneAtATime(username, async () => {
            const currentCurrency = await this.get(username);
            if (!currentCurrency) return { copper: 0, silver: 0, gold: 0 };

            const next = plus(currentCurrency, amount);
            await write(username, next);
            return next;
        });
    },
    /** The balance after: a balance too small for `amount` is left with nothing. With a `batch`: as `add` is. */
    async remove(username: string, amount: Currency, batch?: Batch) : Promise<Currency> {
        if (amount.copper < 0 || amount.silver < 0 || amount.gold < 0) return { copper: 0, silver: 0, gold: 0 };
        if (batch) return changeIn(batch, username, (balance) => minus(balance, amount));

        return oneAtATime(username, async () => {
            const currentCurrency = await this.get(username);
            if (!currentCurrency) return { copper: 0, silver: 0, gold: 0 };

            const next = minus(currentCurrency, amount);
            await write(username, next);
            return next;
        });
    },
};

export default currency;