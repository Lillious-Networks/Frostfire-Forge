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
 * Gets sprite sheet template by name (case-insensitive)
 * @param name - Sprite sheet template name
 * @returns Decompressed sprite sheet template or null
 */
export async function getSpriteSheetTemplate(name: string): Promise<SpriteSheetTemplate | null> {
  // Normalize name to lowercase for case-insensitive lookup
  const normalizedName = name.toLowerCase();

  // Check memory cache first
  if (templateCache.has(normalizedName)) {
    // Return a deep clone to prevent mutations from affecting the cached version
    const cached = templateCache.get(normalizedName)!;
    return JSON.parse(JSON.stringify(cached)) as SpriteSheetTemplate;
  }

  // Get from asset cache
  const spriteSheetTemplates = await assetCache.get('spriteSheetTemplates') as any[];
  if (!spriteSheetTemplates) {
    log.error('Sprite sheet templates not loaded in asset cache');
    return null;
  }

  // Case-insensitive lookup
  const templateData = spriteSheetTemplates.find(t => t.name.toLowerCase() === normalizedName);
  if (!templateData) return null;

  try {
    // Decompress template
    const decompressed = zlib.inflateSync(templateData.template).toString();
    const template = JSON.parse(decompressed) as SpriteSheetTemplate;

    // Cache for future use with normalized name
    templateCache.set(normalizedName, template);

    // Return a deep clone to prevent mutations from affecting the cached version
    return JSON.parse(JSON.stringify(template)) as SpriteSheetTemplate;
  } catch (error) {
    log.error(`Failed to decompress sprite sheet template "${name}": ${error}`);
    return null;
  }
}

/**
 * Gets sprite sheet image data (base64) (case-insensitive)
 * @param name - Sprite sheet template name
 * @returns Base64 encoded image data or null
 */
export async function getSpriteSheetImage(name: string): Promise<string | null> {
  // Normalize name to lowercase for case-insensitive lookup
  const normalizedName = name.toLowerCase();

  const spriteSheetTemplates = await assetCache.get('spriteSheetTemplates') as any[];
  if (!spriteSheetTemplates) {
    return null;
  }

  // Case-insensitive lookup
  const templateData = spriteSheetTemplates.find(t => t.name.toLowerCase() === normalizedName);
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
  armorHelmetSprite: SpriteSheetTemplate | null;
  armorShoulderguardsSprite: SpriteSheetTemplate | null;
  armorNeckSprite: SpriteSheetTemplate | null;
  armorHandsSprite: SpriteSheetTemplate | null;
  armorChestSprite: SpriteSheetTemplate | null;
  armorFeetSprite: SpriteSheetTemplate | null;
  armorLegsSprite: SpriteSheetTemplate | null;
  armorWeaponSprite: SpriteSheetTemplate | null;
  animationState: string;
}> {
  // Parse animation name to determine state
  const animationState = parseAnimationState(animationName);

  // ALWAYS use base templates for body, head, and armor animation data
  // The image will be swapped based on equipment values
  let bodySprite: SpriteSheetTemplate | null = null;
  let headSprite: SpriteSheetTemplate | null = null;
  let armorHelmetSprite: SpriteSheetTemplate | null = null;
  let armorShoulderguardsSprite: SpriteSheetTemplate | null = null;
  let armorNeckSprite: SpriteSheetTemplate | null = null;
  let armorHandsSprite: SpriteSheetTemplate | null = null;
  let armorChestSprite: SpriteSheetTemplate | null = null;
  let armorFeetSprite: SpriteSheetTemplate | null = null;
  let armorLegsSprite: SpriteSheetTemplate | null = null;
  let armorWeaponSprite: SpriteSheetTemplate | null = null;

  // Determine body image name (default to player_body_default if not specified)
  const bodyImageName = equipment?.body && equipment.body !== 'null' ? equipment.body : 'player_body_default';

  // Body: ALWAYS use player_body_base template with image from equipment
  bodySprite = await getSpriteSheetTemplate('player_body_base');
  if (bodySprite) {
    // Override the name and path to reference armor directory structure
    bodySprite.name = bodyImageName;
    bodySprite.imageSource = `armor/player/bodies/${bodyImageName}.png`;
  }

  // Determine head image name (default to player_head_default if not specified)
  const headImageName = equipment?.head && equipment.head !== 'null' ? equipment.head : 'player_head_default';

  // Head: ALWAYS use player_head_base template with image from equipment
  headSprite = await getSpriteSheetTemplate('player_head_base');
  if (headSprite) {
    // Override the name and path to reference armor directory structure
    headSprite.name = headImageName;
    headSprite.imageSource = `armor/player/heads/${headImageName}.png`;
  }

  // Armor Helmet: Only load if equipment.helmet is set
  // Helmet uses armor_head_base template (follows head animations)
  if (equipment?.helmet && equipment.helmet !== 'null') {
    armorHelmetSprite = await getSpriteSheetTemplate('armor_head_base');
    if (armorHelmetSprite) {
      // Use unique name combining layer type and equipment value for client-side caching
      // This prevents conflicts when multiple layers use the same base template
      armorHelmetSprite.name = `helmet_${equipment.helmet}`;
      armorHelmetSprite.imageSource = `armor/helmet/${equipment.helmet}.png`;
    }
  }

  // Armor Shoulderguards: Only load if equipment.shoulderguards is set
  // Uses armor_body_base template (follows body animations)
  if (equipment?.shoulderguards && equipment.shoulderguards !== 'null') {
    armorShoulderguardsSprite = await getSpriteSheetTemplate('armor_body_base');
    if (armorShoulderguardsSprite) {
      // Use unique name combining layer type and equipment value
      armorShoulderguardsSprite.name = `shoulderguards_${equipment.shoulderguards}`;
      armorShoulderguardsSprite.imageSource = `armor/shoulderguards/${equipment.shoulderguards}.png`;
    }
  }

  // Armor Neck: Only load if equipment.necklace is set
  // Uses armor_body_base template (follows body animations)
  if (equipment?.necklace && equipment.necklace !== 'null') {
    armorNeckSprite = await getSpriteSheetTemplate('armor_body_base');
    if (armorNeckSprite) {
      // Use unique name combining layer type and equipment value
      armorNeckSprite.name = `neck_${equipment.necklace}`;
      armorNeckSprite.imageSource = `armor/neck/${equipment.necklace}.png`;
    }
  }

  // Armor Gloves: Only load if equipment.gloves is set
  // Uses armor_body_base template (follows body animations)
  if (equipment?.gloves && equipment.gloves !== 'null') {
    armorHandsSprite = await getSpriteSheetTemplate('armor_body_base');
    if (armorHandsSprite) {
      // Use unique name combining layer type and equipment value
      armorHandsSprite.name = `hands_${equipment.gloves}`;
      armorHandsSprite.imageSource = `armor/gloves/${equipment.gloves}.png`;
    }
  }

  // Armor Chestplate: Only load if equipment.chestplate is set
  // Uses armor_body_base template (follows body animations)
  if (equipment?.chestplate && equipment.chestplate !== 'null') {
    armorChestSprite = await getSpriteSheetTemplate('armor_body_base');
    if (armorChestSprite) {
      // Use unique name combining layer type and equipment value
      armorChestSprite.name = `chest_${equipment.chestplate}`;
      armorChestSprite.imageSource = `armor/chestplate/${equipment.chestplate}.png`;
    }
  }

  // Armor Boots: Only load if equipment.boots is set
  // Uses armor_body_base template (follows body animations)
  if (equipment?.boots && equipment.boots !== 'null') {
    armorFeetSprite = await getSpriteSheetTemplate('armor_body_base');
    if (armorFeetSprite) {
      // Use unique name combining layer type and equipment value
      armorFeetSprite.name = `feet_${equipment.boots}`;
      armorFeetSprite.imageSource = `armor/boots/${equipment.boots}.png`;
    }
  }

  // Armor Pants: Only load if equipment.pants is set
  // Uses armor_body_base template (follows body animations)
  if (equipment?.pants && equipment.pants !== 'null') {
    armorLegsSprite = await getSpriteSheetTemplate('armor_body_base');
    if (armorLegsSprite) {
      // Use unique name combining layer type and equipment value
      armorLegsSprite.name = `legs_${equipment.pants}`;
      armorLegsSprite.imageSource = `armor/pants/${equipment.pants}.png`;
    }
  }

  // Armor Weapon: Only load if equipment.weapon is set
  // Uses armor_body_base template (follows body animations)
  if (equipment?.weapon && equipment.weapon !== 'null') {
    armorWeaponSprite = await getSpriteSheetTemplate('armor_body_base');
    if (armorWeaponSprite) {
      // Use unique name combining layer type and equipment value
      armorWeaponSprite.name = `weapon_${equipment.weapon}`;
      armorWeaponSprite.imageSource = `armor/weapon/${equipment.weapon}.png`;
    }
  }

  return {
    bodySprite,
    headSprite,
    armorHelmetSprite,
    armorShoulderguardsSprite,
    armorNeckSprite,
    armorHandsSprite,
    armorChestSprite,
    armorFeetSprite,
    armorLegsSprite,
    armorWeaponSprite,
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
