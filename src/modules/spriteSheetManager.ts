
import log from "./logger";

const assetServerUrl = process.env.ASSET_SERVER_URL || 'http://localhost:8000';

export interface SpriteUrl {
  name: string;
  templateUrl: string | null;
  imageUrl: string | null;
}

export async function getPlayerSpriteSheetData(
  animationName: string,
  equipment?: Equipment | null
): Promise<{
  bodySprite: SpriteUrl | null;
  headSprite: SpriteUrl | null;
  armorHelmetSprite: SpriteUrl | null;
  armorShoulderguardsSprite: SpriteUrl | null;
  armorNeckSprite: SpriteUrl | null;
  armorHandsSprite: SpriteUrl | null;
  armorChestSprite: SpriteUrl | null;
  armorFeetSprite: SpriteUrl | null;
  armorLegsSprite: SpriteUrl | null;
  armorWeaponSprite: SpriteUrl | null;
  animationState: string;
}> {

  const animationState = parseAnimationState(animationName);

  // Helper function to generate sprite URLs with animation templates
  function generateSpriteUrlWithTemplate(name: string): SpriteUrl {
    return {
      name,
      templateUrl: `${assetServerUrl}/sprite-sheet-template?name=${encodeURIComponent(name)}`,
      imageUrl: `${assetServerUrl}/sprite-sheet-image?name=${encodeURIComponent(name)}`
    };
  }

  // Helper function to generate sprite URLs for equipment (uses shared template)
  function generateEquipmentSpriteUrl(name: string): SpriteUrl {
    return {
      name,
      templateUrl: `${assetServerUrl}/sprite-sheet-template?name=${encodeURIComponent(name)}`,
      imageUrl: `${assetServerUrl}/sprite-sheet-image?name=${encodeURIComponent(name)}`
    };
  }

  const bodyImageName = equipment?.body && equipment.body !== 'null' ? equipment.body : 'player_body_default';
  const bodySprite = generateSpriteUrlWithTemplate('player_body_base');

  const headImageName = equipment?.head && equipment.head !== 'null' ? equipment.head : 'player_head_default';
  const headSprite = generateSpriteUrlWithTemplate('player_head_base');

  let armorHelmetSprite: SpriteUrl | null = null;
  if (equipment?.helmet && equipment.helmet !== 'null') {
    armorHelmetSprite = generateEquipmentSpriteUrl(equipment.helmet.toLowerCase());
  }

  let armorShoulderguardsSprite: SpriteUrl | null = null;
  if (equipment?.shoulderguards && equipment.shoulderguards !== 'null') {
    armorShoulderguardsSprite = generateEquipmentSpriteUrl(equipment.shoulderguards.toLowerCase());
  }

  let armorNeckSprite: SpriteUrl | null = null;
  if (equipment?.necklace && equipment.necklace !== 'null') {
    armorNeckSprite = generateEquipmentSpriteUrl(equipment.necklace.toLowerCase());
  }

  let armorHandsSprite: SpriteUrl | null = null;
  if (equipment?.gloves && equipment.gloves !== 'null') {
    armorHandsSprite = generateEquipmentSpriteUrl(equipment.gloves.toLowerCase());
  }

  let armorChestSprite: SpriteUrl | null = null;
  if (equipment?.chestplate && equipment.chestplate !== 'null') {
    armorChestSprite = generateEquipmentSpriteUrl(equipment.chestplate.toLowerCase());
  }

  let armorFeetSprite: SpriteUrl | null = null;
  if (equipment?.boots && equipment.boots !== 'null') {
    armorFeetSprite = generateEquipmentSpriteUrl(equipment.boots.toLowerCase());
  }

  let armorLegsSprite: SpriteUrl | null = null;
  if (equipment?.pants && equipment.pants !== 'null') {
    armorLegsSprite = generateEquipmentSpriteUrl(equipment.pants.toLowerCase());
  }

  let armorWeaponSprite: SpriteUrl | null = null;
  if (equipment?.weapon && equipment.weapon !== 'null') {
    armorWeaponSprite = generateEquipmentSpriteUrl(equipment.weapon.toLowerCase());
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

export interface Equipment {
  body?: string;
  head?: string;
  helmet?: string;
  shoulderguards?: string;
  necklace?: string;
  gloves?: string;
  chestplate?: string;
  boots?: string;
  pants?: string;
  weapon?: string;
}

// Generate icon URLs for items, spells, and other assets
export function getIconUrl(iconName: string | null): string | null {
  if (!iconName) return null;
  return `${assetServerUrl}/icon?name=${encodeURIComponent(iconName.replace(/\.(png|jpg|jpeg|gif)$/i, ''))}`;
}

// Generate mount sprite URLs
export function getMountSpriteUrl(mountType: string | null): SpriteUrl | null {
  if (!mountType) return null;

  // Mount sprites use shared template (player_mount_base) but mount-specific images
  const mountImageName = `mount_${mountType.toLowerCase()}`;

  return {
    name: mountImageName,
    templateUrl: `${assetServerUrl}/sprite-sheet-template?name=${encodeURIComponent('player_mount_base')}`,
    imageUrl: `${assetServerUrl}/sprite-sheet-image?name=${encodeURIComponent(mountImageName)}`
  };
}

// Check if sprite sheet system is available
// Since we're now generating URLs on-demand, this always returns true
export async function isSpriteSheetSystemAvailable(): Promise<boolean> {
  return true;
}
