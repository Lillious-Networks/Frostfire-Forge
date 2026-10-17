/**
 * USER REQUEST 2026-10-17 ("Weather sounds are currently hard coded. I want to be able to browse sounds from the audio
 * folder and add them to specific weather types in the weather editor. Sounds for wind, thunder and rain and allow
 * adding multiple (for variant support) and allow choosing the intensity range they can happen at"): the sounds of a
 * weather, kept with its row (the weather table's `sounds` column, JSON) and sent to the client with the weather.
 *
 * Each kind is a list of sounds, each an audio file of the asset server (its name, without the extension) heard while
 * the weather's intensity for that kind is between `from` and `to`, at `volume` (0 to 1) of what the game makes of it:
 * - rain: while it rains, by the weather's precipitation (percent). Two sounds whose ranges overlap are crossed over
 *   the overlap, the quieter rain fading out as the harder one comes in.
 * - wind: while the wind blows (it has a direction), by its speed with its gusts (mph). Crossed the same way.
 * - thunder: one sound for each lightning strike, by the weather's precipitation (percent), picked at random among
 *   those whose range holds it.
 * Sounds of one kind with the same range are variants: a looping one (rain, wind) is picked at random each time the
 * weather is shown, a thunder at each strike.
 */

/** The kinds of sound a weather has, in the order the editor shows them. */
export const SOUND_KINDS = ["rain", "wind", "thunder"] as const;
export type SoundKind = (typeof SOUND_KINDS)[number];

/** What each kind is heard by, as the editor is sent it: its range is held to min and max. */
export interface SoundKindRule {
  label: string;
  /** What `from` and `to` measure, in words. */
  measure: string;
  unit: string;
  min: number;
  max: number;
}

export const SOUND_RULES: Record<SoundKind, SoundKindRule> = {
  rain: { label: "Rain", measure: "Precipitation", unit: "%", min: 0, max: 100 },
  // A gust adds up to half the wind speed again (the client's calculateWindSpeed): the top of the editor's 100 mph.
  wind: { label: "Wind", measure: "Wind speed", unit: "mph", min: 0, max: 150 },
  thunder: { label: "Thunder", measure: "Precipitation", unit: "%", min: 0, max: 100 },
};

/** How many sounds one kind may hold. */
export const SOUNDS_MAX = 12;
/** How long a sound's name may be. */
export const SOUND_NAME_MAX = 100;

const NONE = (): WeatherSounds => ({ rain: [], wind: [], thunder: [] });

/**
 * The sounds the seeded weathers are given (database_setup), the ones the game played before they could be chosen:
 * the soft rain crossed into the hard one from 35 to 75 percent, three winds crossed by speed, three thunders.
 */
const RAIN: WeatherSound[] = [
  { name: "soft rain", from: 0, to: 75, volume: 1 },
  { name: "hard rain", from: 35, to: 100, volume: 1 },
];
const WIND: WeatherSound[] = [
  { name: "gentle wind 2", from: 0, to: 12, volume: 1 },
  { name: "gentle wind", from: 6, to: 26, volume: 1 },
  { name: "regular wind", from: 18, to: 150, volume: 1 },
];
const THUNDER: WeatherSound[] = [
  { name: "thunder", from: 0, to: 100, volume: 1 },
  { name: "thunder 2", from: 0, to: 100, volume: 1 },
  { name: "thunder 3", from: 0, to: 100, volume: 1 },
];
export const DEFAULT_SOUNDS: Record<string, WeatherSounds> = {
  clear: { rain: [], wind: WIND, thunder: [] },
  darkness: { rain: [], wind: WIND, thunder: [] },
  rainy: { rain: RAIN, wind: WIND, thunder: [] },
  snowy: { rain: [], wind: WIND, thunder: [] },
  sandstorm: { rain: [], wind: WIND, thunder: [] },
  thunderstorm: { rain: RAIN, wind: WIND, thunder: THUNDER },
  tornado: { rain: RAIN, wind: WIND, thunder: THUNDER },
};

/**
 * A weather's sounds as the column holds them (JSON text, or already read), each kind a list of sounds; anything
 * that is not a sound is left out. Null and what cannot be read are no sounds at all.
 */
export function parseSounds(raw: unknown): WeatherSounds {
  let value: any = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return NONE();
    }
  }
  const sounds = NONE();
  if (!value || typeof value !== "object") return sounds;
  for (const kind of SOUND_KINDS) {
    const list = Array.isArray(value[kind]) ? value[kind] : [];
    for (const entry of list) {
      const name = typeof entry?.name === "string" ? entry.name.trim() : "";
      const from = Number(entry?.from), to = Number(entry?.to);
      if (!name || !Number.isFinite(from) || !Number.isFinite(to)) continue;
      const volume = Number(entry?.volume ?? 1);
      sounds[kind].push({ name, from, to, volume: Number.isFinite(volume) ? volume : 1 });
    }
  }
  return sounds;
}

/** The column's text for a weather's sounds. */
export function soundsText(sounds: WeatherSounds | null | undefined): string {
  return JSON.stringify(parseSounds(sounds ?? null));
}

/**
 * What is wrong with the sounds the editor sent, by field: "sounds.rain.0.name", "sounds.wind.2.to". Nothing when
 * they are fine (no sounds at all is fine: the weather is silent).
 */
export function validateSounds(data: any): Array<{ field: string; message: string }> {
  const errors: Array<{ field: string; message: string }> = [];
  if (data === undefined || data === null) return errors;
  if (typeof data !== "object" || Array.isArray(data)) return [{ field: "sounds", message: "Sounds must be a list for each of rain, wind and thunder." }];
  for (const kind of SOUND_KINDS) {
    const rule = SOUND_RULES[kind];
    const list = data[kind];
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list)) {
      errors.push({ field: `sounds.${kind}`, message: `${rule.label} sounds must be a list.` });
      continue;
    }
    if (list.length > SOUNDS_MAX) errors.push({ field: `sounds.${kind}`, message: `A weather can have at most ${SOUNDS_MAX} ${rule.label.toLowerCase()} sounds.` });
    list.forEach((entry: any, i: number) => {
      const at = `sounds.${kind}.${i}`;
      const name = typeof entry?.name === "string" ? entry.name.trim() : "";
      if (!name) errors.push({ field: `${at}.name`, message: "Pick an audio file." });
      else if (name.length > SOUND_NAME_MAX) errors.push({ field: `${at}.name`, message: `An audio name must be ${SOUND_NAME_MAX} characters or fewer.` });
      const ends: Array<["from" | "to", string]> = [["from", "From"], ["to", "To"]];
      for (const [key, label] of ends) {
        const value = entry?.[key];
        if (typeof value !== "number" || !Number.isFinite(value)) errors.push({ field: `${at}.${key}`, message: `${label} must be a number.` });
        else if (value < rule.min || value > rule.max) errors.push({ field: `${at}.${key}`, message: `${label} must be between ${rule.min} and ${rule.max}.` });
      }
      if (typeof entry?.from === "number" && typeof entry?.to === "number" && entry.from > entry.to) {
        errors.push({ field: `${at}.to`, message: "To must not be under From." });
      }
      const volume = entry?.volume;
      if (typeof volume !== "number" || !Number.isFinite(volume)) errors.push({ field: `${at}.volume`, message: "Volume must be a number." });
      else if (volume < 0 || volume > 1) errors.push({ field: `${at}.volume`, message: "Volume must be between 0 and 1." });
    });
  }
  return errors;
}
