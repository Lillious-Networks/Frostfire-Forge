import query from "../controllers/sqldatabase";

const max_copper = 99;
const max_silver = 99;
const max_gold = 9999999;

const currency = {
    async get(username: string): Promise<Currency> {
        if (!username) return { copper: 0, silver: 0, gold: 0 };
        const response = await query("SELECT copper, silver, gold FROM currency WHERE username = ?", [username]) as Currency[];
        if (response.length === 0) return { copper: 0, silver: 0, gold: 0 };
        return response[0] as Currency;
    },
    async set(username: string, currencyData: Currency) {
        if (!username || !currencyData) return;
        const { copper, silver, gold } = currencyData;
        await query(
            "INSERT INTO currency (username, copper, silver, gold) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE copper = ?, silver = ?, gold = ?",
            [username, copper, silver, gold, copper, silver, gold]
        );
    },
    async add(username: string, amount: Currency) : Promise<Currency> {
        if (amount.copper < 0 || amount.silver < 0 || amount.gold < 0) return { copper: 0, silver: 0, gold: 0 };

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

        await this.set(username, currentCurrency);
        return currentCurrency;
    },
    async remove(username: string, amount: Currency) : Promise<Currency> {
        if (amount.copper < 0 || amount.silver < 0 || amount.gold < 0) return { copper: 0, silver: 0, gold: 0 };

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

        await this.set(username, currentCurrency);
        return currentCurrency;
    },
};

export default currency;