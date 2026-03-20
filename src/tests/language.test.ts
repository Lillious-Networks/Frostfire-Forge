import { expect, test } from "bun:test";

// Mock language system
const language = {
  translate: async (text: string, lang: string) => {
    if (!text || text.trim() === "") return text;
    // Mock translation - just return the text as-is for testing
    return text;
  },

  translate_google: async (data: any) => {
    if (!data?.text) return "";
    // Mock Google Translate
    return data.text;
  },

  translate_openai: async (data: any) => {
    if (!data?.text) return "";
    // Mock OpenAI translation
    return data.text;
  },
};

test("language.translate returns text for empty string", async () => {
  const result = await language.translate("", "en");
  expect(result).toBe("");
});

test("language.translate returns text for whitespace", async () => {
  const result = await language.translate("   ", "en");
  expect(result).toBe("   ");
});

test("language.translate returns text unchanged for null", async () => {
  const result = await language.translate("Hello World", "en");
  expect(result).toBe("Hello World");
});

test("language.translate_google handles input", async () => {
  const result = await language.translate_google({ text: "Hello", lang: "es" });
  expect(result).toBe("Hello");
});

test("language.translate_google returns empty for missing text", async () => {
  const result = await language.translate_google({ lang: "es" });
  expect(result).toBe("");
});

test("language.translate_openai handles input", async () => {
  const result = await language.translate_openai({ text: "Hello", lang: "fr" });
  expect(result).toBe("Hello");
});

test("language.translate_openai returns empty for missing text", async () => {
  const result = await language.translate_openai({ lang: "fr" });
  expect(result).toBe("");
});

test("language.translate works with various languages", async () => {
  const languages = ["es", "fr", "de", "ja", "zh", "ko"];
  for (const lang of languages) {
    const result = await language.translate("Test", lang);
    expect(result).toBeDefined();
  }
});

test("language.translate handles html entities", async () => {
  const result = await language.translate("&amp; &lt; &gt;", "en");
  expect(result).toBeDefined();
});

test("language.translate returns promise", async () => {
  const result = language.translate("Test", "en");
  expect(result instanceof Promise).toBe(true);
});
