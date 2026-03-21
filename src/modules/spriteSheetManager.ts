

import assetCache from "../services/assetCache";
import zlib from "zlib";
import log from "./logger";

const templateCache = new Map<string, SpriteSheetTemplate>();

export async function getSpriteSheetTemplate(name: string): Promise<SpriteSheetTemplate | null> {

  const normalizedName = name.toLowerCase();

  if (templateCache.has(normalizedName)) {

    const cached = templateCache.get(normalizedName)!;
    return JSON.parse(JSON.stringify(cached)) as SpriteSheetTemplate;
  }

  const spriteSheetTemplates = await assetCache.get('spriteSheetTemplates') as any[];
  if (!spriteSheetTemplates) {
    log.error('Sprite sheet templates not loaded in asset cache');
    return null;
  }

  const templateData = spriteSheetTemplates.find(t => t.name.toLowerCase() === normalizedName);
  if (!templateData) return null;

  try {

    const decompressed = zlib.inflateSync(templateData.template).toString();
    const template = JSON.parse(decompressed) as SpriteSheetTemplate;

    templateCache.set(normalizedName, template);

    return JSON.parse(JSON.stringify(template)) as SpriteSheetTemplate;
  } catch (error) {
    log.error(`Failed to decompress sprite sheet template "${name}": ${error}`);
    return null;
  }
}

const spriteImageCache = new Map<string, string>();

export async function getSpriteSheetImage(name: string): Promise<string | null> {

  const normalizedName = name.toLowerCase();

  if (spriteImageCache.has(normalizedName)) {
    return spriteImageCache.get(normalizedName)!;
  }

  const spriteSheetTemplates = await assetCache.get('spriteSheetTemplates') as any[];
  if (!spriteSheetTemplates) {
    log.warn(`Sprite sheet templates not available in asset cache when trying to load image: ${name}`);
    return null;
  }

  const templateData = spriteSheetTemplates.find(t => t.name.toLowerCase() === normalizedName);
  if (!templateData) {
    return null;
  }

  try {

    const decompressed = zlib.inflateSync(templateData.image).toString();

    spriteImageCache.set(normalizedName, decompressed);

    return decompressed;
  } catch (error) {
    log.error(`Failed to decompress sprite sheet image "${name}": ${error}`);
    return null;
  }
}

export function clearSpriteImageCache() {
  spriteImageCache.clear();
}

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

  const animationState = parseAnimationState(animationName);

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

  const bodyImageName = equipment?.body && equipment.body !== 'null' ? equipment.body : 'player_body_default';

  bodySprite = await getSpriteSheetTemplate('player_body_base');
  if (!bodySprite) {
    log.warn(`Failed to load player_body_base template. Available templates might not be loaded.`);
  } else {

    bodySprite.name = bodyImageName;
    bodySprite.imageSource = `armor/player/bodies/${bodyImageName}.png`;
  }

  const headImageName = equipment?.head && equipment.head !== 'null' ? equipment.head : 'player_head_default';

  headSprite = await getSpriteSheetTemplate('player_head_base');
  if (!headSprite) {
    log.warn(`Failed to load player_head_base template. Available templates might not be loaded.`);
  } else {

    headSprite.name = headImageName;
    headSprite.imageSource = `armor/player/heads/${headImageName}.png`;
  }

  if (equipment?.helmet && equipment.helmet !== 'null') {
    armorHelmetSprite = await getSpriteSheetTemplate('armor_head_base');
    if (armorHelmetSprite) {

      armorHelmetSprite.name = `helmet_${equipment.helmet}`;
      armorHelmetSprite.imageSource = `armor/helmet/${equipment.helmet}.png`;
    }
  }

  if (equipment?.shoulderguards && equipment.shoulderguards !== 'null') {
    armorShoulderguardsSprite = await getSpriteSheetTemplate('armor_body_base');
    if (armorShoulderguardsSprite) {

      armorShoulderguardsSprite.name = `shoulderguards_${equipment.shoulderguards}`;
      armorShoulderguardsSprite.imageSource = `armor/shoulderguards/${equipment.shoulderguards}.png`;
    }
  }

  if (equipment?.necklace && equipment.necklace !== 'null') {
    armorNeckSprite = await getSpriteSheetTemplate('armor_body_base');
    if (armorNeckSprite) {

      armorNeckSprite.name = `neck_${equipment.necklace}`;
      armorNeckSprite.imageSource = `armor/neck/${equipment.necklace}.png`;
    }
  }

  if (equipment?.gloves && equipment.gloves !== 'null') {
    armorHandsSprite = await getSpriteSheetTemplate('armor_body_base');
    if (armorHandsSprite) {

      armorHandsSprite.name = `hands_${equipment.gloves}`;
      armorHandsSprite.imageSource = `armor/gloves/${equipment.gloves}.png`;
    }
  }

  if (equipment?.chestplate && equipment.chestplate !== 'null') {
    armorChestSprite = await getSpriteSheetTemplate('armor_body_base');
    if (armorChestSprite) {

      armorChestSprite.name = `chest_${equipment.chestplate}`;
      armorChestSprite.imageSource = `armor/chestplate/${equipment.chestplate}.png`;
    }
  }

  if (equipment?.boots && equipment.boots !== 'null') {
    armorFeetSprite = await getSpriteSheetTemplate('armor_body_base');
    if (armorFeetSprite) {

      armorFeetSprite.name = `feet_${equipment.boots}`;
      armorFeetSprite.imageSource = `armor/boots/${equipment.boots}.png`;
    }
  }

  if (equipment?.pants && equipment.pants !== 'null') {
    armorLegsSprite = await getSpriteSheetTemplate('armor_body_base');
    if (armorLegsSprite) {

      armorLegsSprite.name = `legs_${equipment.pants}`;
      armorLegsSprite.imageSource = `armor/pants/${equipment.pants}.png`;
    }
  }

  if (equipment?.weapon && equipment.weapon !== 'null') {
    armorWeaponSprite = await getSpriteSheetTemplate('armor_body_base');
    if (armorWeaponSprite) {

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

function parseAnimationState(animationName: string): string {
  const lower = animationName.toLowerCase();

  let cleaned = lower.replace(/\.png$/, '');

  cleaned = cleaned.replace(/^player_/, '');

  cleaned = cleaned.replace(/^mount_[a-z]+_/, '');

  return cleaned;
}

export async function isSpriteSheetSystemAvailable(): Promise<boolean> {
  const spriteSheetTemplates = await assetCache.get('spriteSheetTemplates') as any[];
  return spriteSheetTemplates && spriteSheetTemplates.length > 0;
}

export function clearSpriteSheetCache(): void {
  templateCache.clear();
}

export async function listSpriteSheetTemplates(): Promise<string[]> {
  const spriteSheetTemplates = await assetCache.get('spriteSheetTemplates') as any[];
  if (!spriteSheetTemplates) {
    return [];
  }
  return spriteSheetTemplates.map(t => t.name);
}
