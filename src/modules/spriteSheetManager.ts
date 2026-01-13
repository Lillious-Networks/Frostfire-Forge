/**
 * Sprite Sheet Manager
 * Server-side helper for managing sprite sheet data and player animations
 */

import assetCache from "../services/assetCache";
import zlib from "zlib";
import log from "./logger";

// Cache for decompressed sprite sheet templates
const templateCache = new Map<string, SpriteSheetTemplate>();

/**
 * Gets sprite sheet template by name
 * @param name - Sprite sheet template name
 * @returns Decompressed sprite sheet template or null
 */
export async function getSpriteSheetTemplate(name: string): Promise<SpriteSheetTemplate | null> {
  // Check memory cache first
  if (templateCache.has(name)) {
    // Return a deep clone to prevent mutations from affecting the cached version
    const cached = templateCache.get(name)!;
    return JSON.parse(JSON.stringify(cached)) as SpriteSheetTemplate;
  }

  // Get from asset cache
  const spriteSheetTemplates = await assetCache.get('spriteSheetTemplates') as any[];
  if (!spriteSheetTemplates) {
    log.error('Sprite sheet templates not loaded in asset cache');
    return null;
  }

  const templateData = spriteSheetTemplates.find(t => t.name === name);
  if (!templateData) return null;

  try {
    // Decompress template
    const decompressed = zlib.inflateSync(templateData.template).toString();
    const template = JSON.parse(decompressed) as SpriteSheetTemplate;

    // Cache for future use
    templateCache.set(name, template);

    // Return a deep clone to prevent mutations from affecting the cached version
    return JSON.parse(JSON.stringify(template)) as SpriteSheetTemplate;
  } catch (error) {
    log.error(`Failed to decompress sprite sheet template "${name}": ${error}`);
    return null;
  }
}

/**
 * Gets sprite sheet image data (base64)
 * @param name - Sprite sheet template name
 * @returns Base64 encoded image data or null
 */
export async function getSpriteSheetImage(name: string): Promise<string | null> {
  const spriteSheetTemplates = await assetCache.get('spriteSheetTemplates') as any[];
  if (!spriteSheetTemplates) {
    return null;
  }

  const templateData = spriteSheetTemplates.find(t => t.name === name);
  if (!templateData) {
    return null;
  }

  try {
    // Decompress image
    const decompressed = zlib.inflateSync(templateData.image).toString();
    return decompressed;
  } catch (error) {
    log.error(`Failed to decompress sprite sheet image "${name}": ${error}`);
    return null;
  }
}

/**
 * Resolve sprite sheet templates for a player from an APNG animation name and optional equipment, and derive the normalized animation state.
 *
 * @param equipment - Optional equipment object whose fields (e.g., `body`, `head`, `chest`, `helmet`) that are `null` or the string `"null"` are treated as absent and produce a `null` sprite layer.
 * @returns An object containing `bodySprite`, `headSprite`, `bodyArmorSprite`, and `headArmorSprite` (each a `SpriteSheetTemplate` or `null`) and `animationState`, a normalized `action_direction` string derived from `animationName`.
 */
export async function getPlayerSpriteSheetData(
  animationName: string,
  equipment?: Equipment | null
): Promise<{
  bodySprite: SpriteSheetTemplate | null;
  headSprite: SpriteSheetTemplate | null;
  bodyArmorSprite: SpriteSheetTemplate | null;
  headArmorSprite: SpriteSheetTemplate | null;
  animationState: string;
}> {
  // Parse animation name to determine state
  const animationState = parseAnimationState(animationName);

  // Get base character sprites from equipment.body and equipment.head
  // If not provided or null, return null for that layer (don't render)
  let bodySprite: SpriteSheetTemplate | null = null;
  let headSprite: SpriteSheetTemplate | null = null;
  let bodyArmorSprite: SpriteSheetTemplate | null = null;
  let headArmorSprite: SpriteSheetTemplate | null = null;

  if (equipment) {
    // Get body sprite from equipment.body field (check for both null and string "null")
    if (equipment.body && equipment.body !== 'null') {
      bodySprite = await getSpriteSheetTemplate(equipment.body);
    }

    // Get head sprite from equipment.head field (check for both null and string "null")
    if (equipment.head && equipment.head !== 'null') {
      headSprite = await getSpriteSheetTemplate(equipment.head);
    }

    // Get body armor sprite from equipment.chest field (check for both null and string "null")
    if (equipment.chest && equipment.chest !== 'null') {
      bodyArmorSprite = await getSpriteSheetTemplate(equipment.chest);
    }

    // Get head armor sprite from equipment.helmet field (check for both null and string "null")
    if ((equipment as any).helmet && (equipment as any).helmet !== 'null') {
      headArmorSprite = await getSpriteSheetTemplate((equipment as any).helmet);
    }
  }

  return {
    bodySprite,
    headSprite,
    bodyArmorSprite,
    headArmorSprite,
    animationState
  };
}

/**
 * Normalize an APNG animation filename into a direction-aware action state.
 *
 * @param animationName - The APNG animation filename or identifier (e.g., "player_idle_down.png").
 * @returns The normalized animation state in "action_direction" form (e.g., "idle_down").
 */
function parseAnimationState(animationName: string): string {
  const lower = animationName.toLowerCase();

  // Remove .png extension
  let cleaned = lower.replace(/\.png$/, '');

  // Remove player_ prefix
  cleaned = cleaned.replace(/^player_/, '');

  // Remove mount_[type]_ prefix but keep the rest
  cleaned = cleaned.replace(/^mount_[a-z]+_/, '');

  // Now cleaned should be in format "action_direction" (e.g., "idle_down", "walk_right")
  // Return as-is to preserve direction
  return cleaned;
}

/**
 * Determine whether the sprite sheet system has any templates available.
 *
 * @returns `true` if at least one sprite sheet template exists, `false` otherwise.
 */
export async function isSpriteSheetSystemAvailable(): Promise<boolean> {
  const spriteSheetTemplates = await assetCache.get('spriteSheetTemplates') as any[];
  return spriteSheetTemplates && spriteSheetTemplates.length > 0;
}

/**
 * Clears the sprite sheet template cache
 */
export function clearSpriteSheetCache(): void {
  templateCache.clear();
}

/**
 * Lists all available sprite sheet templates
 */
export async function listSpriteSheetTemplates(): Promise<string[]> {
  const spriteSheetTemplates = await assetCache.get('spriteSheetTemplates') as any[];
  if (!spriteSheetTemplates) {
    return [];
  }
  return spriteSheetTemplates.map(t => t.name);
}