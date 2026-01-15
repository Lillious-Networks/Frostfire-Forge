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
 * Maps old APNG animation names to new sprite sheet system
 * Format: "direction_state" or "mount_name_direction_state"
 * Examples: "down_idle", "horse_left_walking", "right_walking"
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

  // ALWAYS use base templates for body and head animation data
  // The image will be swapped based on equipment.body and equipment.head values
  let bodySprite: SpriteSheetTemplate | null = null;
  let headSprite: SpriteSheetTemplate | null = null;
  let bodyArmorSprite: SpriteSheetTemplate | null = null;
  let headArmorSprite: SpriteSheetTemplate | null = null;

  // Determine body image name (default to player_body_base if not specified)
  const bodyImageName = equipment?.body && equipment.body !== 'null' ? equipment.body : 'player_body_base';

  // Body: ALWAYS use player_body_base template with image from equipment
  bodySprite = await getSpriteSheetTemplate('player_body_base');
  if (bodySprite) {
    // Override the name to reference the custom image source
    bodySprite.name = bodyImageName;
    bodySprite.imageSource = `${bodyImageName}.png`;
  }

  // Determine head image name (default to player_head_base if not specified)
  const headImageName = equipment?.head && equipment.head !== 'null' ? equipment.head : 'player_head_base';

  // Head: ALWAYS use player_head_base template with image from equipment
  headSprite = await getSpriteSheetTemplate('player_head_base');
  if (headSprite) {
    // Override the name to reference the custom image source
    headSprite.name = headImageName;
    headSprite.imageSource = `${headImageName}.png`;
  }

  // Get body armor sprite from equipment.chest field (check for both null and string "null")
  if (equipment?.chest && equipment.chest !== 'null') {
    bodyArmorSprite = await getSpriteSheetTemplate(equipment.chest);
  }

  // Get head armor sprite from equipment.helmet field (check for both null and string "null")
  if (equipment && (equipment as any).helmet && (equipment as any).helmet !== 'null') {
    headArmorSprite = await getSpriteSheetTemplate((equipment as any).helmet);
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
 * Parses APNG animation name to determine sprite sheet animation state with direction
 * Examples:
 * - "player_idle_down.png" -> "idle_down"
 * - "player_walk_up.png" -> "walk_up"
 * - "mount_base_idle_left.png" -> "idle_left"
 * - "mount_base_walk_down.png" -> "walk_down"
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
 * Checks if sprite sheet system is available
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
