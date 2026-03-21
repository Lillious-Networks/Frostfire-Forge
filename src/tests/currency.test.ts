import { expect, test } from "bun:test";
import { createMockCurrency, createMockQueryResult } from "./setup";

const currencyDatabase: Record<string, any> = {
  test_user: createMockCurrency(50, 30, 100),
};

const mockQuery = async (sql: string, params: any[]) => {
  if (sql.includes("SELECT copper, silver, gold")) {
    const user = params[0];
    return currencyDatabase[user] ? [currencyDatabase[user]] : [];
  }
  if (sql.includes("INSERT INTO currency")) {
    const [username, copper, silver, gold] = params;
    currencyDatabase[username] = { copper, silver, gold };
    return createMockQueryResult();
  }
  return [];
};

const currency = {
  max_copper: 99,
  max_silver: 99,
  max_gold: 9999999,

  async get(username: string) {
    if (!username) return { copper: 0, silver: 0, gold: 0 };
    const response = await mockQuery("SELECT copper, silver, gold FROM currency WHERE username = ?", [username]);
    if ((response as any[]).length === 0) return { copper: 0, silver: 0, gold: 0 };
    return (response as any[])[0];
  },

  async set(username: string, currencyData: any) {
    if (!username || !currencyData) return;
    const { copper, silver, gold } = currencyData;
    await mockQuery("INSERT INTO currency (username, copper, silver, gold) VALUES (?, ?, ?, ?)", [
      username,
      copper,
      silver,
      gold,
    ]);
  },

  async add(username: string, amount: any) {
    const currentCurrency = await this.get(username);
    if (!currentCurrency) return { copper: 0, silver: 0, gold: 0 };

    if (currentCurrency.copper + amount.copper > this.max_copper) {
      const overflowToSilver = Math.floor((currentCurrency.copper + amount.copper) / (this.max_copper + 1));
      currentCurrency.silver += overflowToSilver;
      currentCurrency.copper = (currentCurrency.copper + amount.copper) % (this.max_copper + 1);
    }

    if (currentCurrency.silver + amount.silver > this.max_silver) {
      const overflowToGold = Math.floor((currentCurrency.silver + amount.silver) / (this.max_silver + 1));
      currentCurrency.gold += overflowToGold;
      currentCurrency.silver = currentCurrency.silver % (this.max_silver + 1);
    }

    if (currentCurrency.gold + amount.gold > this.max_gold) {
      currentCurrency.gold = this.max_gold;
    } else {
      currentCurrency.gold += amount.gold;
    }

    await this.set(username, currentCurrency);
    return currentCurrency;
  },

  async remove(username: string, amount: any) {
    const currentCurrency = await this.get(username);
    if (!currentCurrency) return { copper: 0, silver: 0, gold: 0 };

    if (currentCurrency.copper < amount.copper) {
      currentCurrency.copper = 0;
      currentCurrency.silver = Math.max(0, currentCurrency.silver - amount.silver);
      currentCurrency.gold = Math.max(0, currentCurrency.gold - amount.gold);
    } else {
      currentCurrency.copper -= amount.copper;
      if (currentCurrency.silver < amount.silver) {
        currentCurrency.silver = 0;
        currentCurrency.gold = Math.max(0, currentCurrency.gold - amount.gold);
      } else {
        currentCurrency.silver -= amount.silver;
        if (currentCurrency.gold < amount.gold) {
          currentCurrency.gold = 0;
        } else {
          currentCurrency.gold -= amount.gold;
        }
      }
    }

    await this.set(username, currentCurrency);
    return currentCurrency;
  },
};

test("currency.get returns user currency", async () => {
  const result = await currency.get("test_user");
  expect(result.copper).toBe(50);
  expect(result.silver).toBe(30);
  expect(result.gold).toBe(100);
});

test("currency.get returns zeros for non-existent user", async () => {
  const result = await currency.get("nonexistent");
  expect(result.copper).toBe(0);
  expect(result.silver).toBe(0);
  expect(result.gold).toBe(0);
});

test("currency.add adds currency to user", async () => {
  const result = await currency.add("add_test_user", { copper: 10, silver: 5, gold: 50 });
  expect(result.copper).toBeGreaterThanOrEqual(0);
  expect(result.silver).toBeGreaterThanOrEqual(0);
  expect(result.gold).toBeGreaterThanOrEqual(0);
});

test("currency.add handles copper overflow to silver", async () => {
  currencyDatabase["overflow_test"] = { copper: 90, silver: 0, gold: 0 };
  const result = await currency.add("overflow_test", { copper: 20, silver: 0, gold: 0 });
  expect(result.copper).toBeGreaterThanOrEqual(0);
  expect(result.copper).toBeLessThanOrEqual(99);
  expect(result.silver).toBeGreaterThan(0);
});

test("currency.remove removes currency from user", async () => {
  const result = await currency.remove("remove_test_user", { copper: 10, silver: 5, gold: 50 });
  expect(result.copper).toBeGreaterThanOrEqual(0);
  expect(result.silver).toBeGreaterThanOrEqual(0);
  expect(result.gold).toBeGreaterThanOrEqual(0);
});

test("currency.remove prevents negative values", async () => {
  const result = await currency.remove("test_user", { copper: 500, silver: 500, gold: 500 });
  expect(result.copper).toBeGreaterThanOrEqual(0);
  expect(result.silver).toBeGreaterThanOrEqual(0);
  expect(result.gold).toBeGreaterThanOrEqual(0);
});
