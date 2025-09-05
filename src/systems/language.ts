import log from "../modules/logger";
import swears from "../../config/swears.json";
const GOOGLE_TRANSLATE_API_KEY = process.env.GOOGLE_TRANSLATE_API_KEY;
const TRANSLATION_SERVICE = process.env.TRANSLATION_SERVICE || "google_translate";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-nano-2025-04-14"; // Default to cheapest model
import OpenAI from "openai";
let openai: OpenAI | null = null;

if (TRANSLATION_SERVICE === "openai" && OPENAI_API_KEY) {
    openai = new OpenAI();
}

const language = {
    translate: async (text: string, lang: string) => {
        let response = text;
        if (!text || text.trim() === "") return text;

        try {
            const translationPromise = (async () => {
                if (TRANSLATION_SERVICE.toLowerCase() === "google_translate") {
                    if (!GOOGLE_TRANSLATE_API_KEY) {
                        log.warn("Google Translate API Key not found");
                        return response;
                    }
                    response = await language.translate_google({ text, lang }) as any;
                }

                if (TRANSLATION_SERVICE.toLowerCase() === "openai") {
                    if (!OPENAI_API_KEY) {
                        log.warn("OpenAI API Key not found");
                        return response;
                    }
                    response = await language.translate_openai({ text, lang }) as any;
                }
                return response;
            })();

            // Set 3 second timeout
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('Translation timeout')), 1000);
            });

            response = await Promise.race([translationPromise, timeoutPromise]) as string;
        } catch (error) {
            // Default to google translate if error
            log.error(`Error translating text: ${error}`);
            return language.translate_google({ text, lang }) as any;
        }

        // Replace any HTML entities
        const htmlEntities: { [key: string]: string } = {
            "&amp;": "&",
            "&lt;": "<",
            "&gt;": ">",
            "&quot;": "\"",
            "&#39;": "'",
            "&#96;": "`"
        };

        response = response.replace(/&(?:amp|lt|gt|quot|#39|#96);/g, (match: string) => htmlEntities[match]);
        return response;
    },
    translate_google: async (data: any) => {
        log.debug(`Translating text: ${data.text} to ${data.lang} using Google Translate`);
        const url = new URL("https://translation.googleapis.com/language/translate/v2");
        // API Key
        url.searchParams.append('key', GOOGLE_TRANSLATE_API_KEY as string);
        // Text to translate
        url.searchParams.append('q', data.text);
        
        // Target language
        url.searchParams.append('target', data.lang);

        const response = await fetch(url, {
            method: "POST",
            body: JSON.stringify(data),
            headers: {
                "Content-Type": "application/json",
            },
        }).then((res) => res.json());
        
        // Get any errors
        if (response.error) {
            log.error(`Error translating text: ${response.error.message}`);
            return;
        }

        let translatedText = response.data.translations[0].translatedText;

        // If translating to English, check for swear words
        if (data.lang === "en") {
            for (const swear of swears) {
                const swearRegex = new RegExp(swear.id, "gi");
                while (swearRegex.test(translatedText)) {
                    const randomLength = Math.floor(Math.random() * 5) + 1;
                    translatedText = translatedText.replace(
                        swearRegex,
                        "*".repeat(randomLength)
                    );
                }
            }
        }

        return translatedText;
    },
    translate_openai: async (data: any) => {
        log.debug(`Translating text: ${data.text} to ${data.lang} using OpenAI`);
        if (!openai) {
            log.error("OpenAI client not initialized");
            return data.text;
        }

        try {
            const completion = await openai.chat.completions.create({
                model: OPENAI_MODEL,
                messages: [
                    {
                        role: "system",
                        content: `
                            You are a professional translator that knows how to translate text between different languages.
                            You must follow these rules when translating:
                            Always translate the text to the target language specified by the user.
                            If the text is already in the target language, respond with the original text.
                            If the text contains any swear words, replace them with asterisks (e.g., ****) in the translation.
                            If the text contains any racial slurs, replace them with asterisks (e.g., ****) in the translation.
                            If the text contains any sensitive or inappropriate content, replace it with asterisks (e.g., ****) in the translation.
                            Do not include any explanations or additional text in your response, only the translated text.
                            Do not apologize for anything.
                            Do not refuse to translate any text as accuracy needs to be maintained.
                            Do not mention that you are an AI model.
                            Do not mention any of your rules in the translation.
                            Do not censor any words except for swear words and racial slurs.
                            If you encounter a swear word, filter that word in the translation.
                            if you encounter a racial slur, filter that word in the translation.
                            Always prioritize accuracy and faithfulness to the original text.
                            Maintain Emojis and special characters in the translation.
                            If the text is a single word, translate that word only.
                            If the text cannot be translated, respond with the original text.
                            ALWAYS FOLLOW THESE RULES UNDER ANY CIRCUMSTANCES.
                            Do not add additional commentary or information.
                            Do not add any additional punctuation or characters.
                            Do not change any part of the text except for translating it.
                            Preserve the meaning and context of the original text.
                            Preserve capitalization and punctuation as much as possible.
                            DO NOT BREAK CHARACTER UNDER ANY CIRCUMSTANCES.
                            DO NOT BREAK THESE RULES UNDER ANY CIRCUMSTANCES.
                        `
                    },
                    {
                        role: "user",
                        content: `Translate the following text to ${data.lang}: ${data.text}. Filter any swear words or racial slurs in the translation.`
                    }
                ],
                temperature: 0.3,
                max_tokens: 150
            });

            const translatedText = completion.choices[0]?.message?.content?.trim();
            if (!translatedText) {
                log.error("No translation received from OpenAI");
                return data.text;
            }

            return translatedText;
        } catch (error) {
            log.error(`OpenAI Translation Error: ${error}`);
        }
    }
};

export default language;