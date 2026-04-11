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

  const bodySprite = generateSpriteUrlWithTemplate('player_body_base');

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

export interface NpcSpriteLayers {
  body: SpriteUrl | null;
  head: SpriteUrl | null;
  helmet: SpriteUrl | null;
  shoulderguards: SpriteUrl | null;
  neck: SpriteUrl | null;
  hands: SpriteUrl | null;
  chest: SpriteUrl | null;
  feet: SpriteUrl | null;
  legs: SpriteUrl | null;
  weapon: SpriteUrl | null;
}

export function getNpcSpriteLayers(npc: {
  sprite_type: string;
  sprite_body?: string | null;
  sprite_head?: string | null;
  sprite_helmet?: string | null;
  sprite_shoulderguards?: string | null;
  sprite_neck?: string | null;
  sprite_hands?: string | null;
  sprite_chest?: string | null;
  sprite_feet?: string | null;
  sprite_legs?: string | null;
  sprite_weapon?: string | null;
}): NpcSpriteLayers | null {
  const spriteType = npc.sprite_type || 'animated';
  if (spriteType === 'static') {
    // Static: body is a plain icon, no template needed
    return {
      body: npc.sprite_body ? { name: npc.sprite_body, templateUrl: null, imageUrl: `${assetServerUrl}/icon?name=${encodeURIComponent(npc.sprite_body)}` } : null,
      head: null, helmet: null, shoulderguards: null, neck: null,
      hands: null, chest: null, feet: null, legs: null, weapon: null,
    };
  }

  // Animated: body and head use shared base templates (same as players),
  // equipment layers use their own name as both template and image.
  const bodyUrl = (name: string): SpriteUrl => ({
    name,
    templateUrl: `${assetServerUrl}/sprite-sheet-template?name=npc_body_base`,
    imageUrl: `${assetServerUrl}/sprite-sheet-image?name=${encodeURIComponent(name)}`,
  });
  const headUrl = (name: string): SpriteUrl => ({
    name,
    templateUrl: `${assetServerUrl}/sprite-sheet-template?name=npc_head_base`,
    imageUrl: `${assetServerUrl}/sprite-sheet-image?name=${encodeURIComponent(name)}`,
  });
  const equipUrl = (name: string): SpriteUrl => ({
    name,
    templateUrl: `${assetServerUrl}/sprite-sheet-template?name=${encodeURIComponent(name)}`,
    imageUrl: `${assetServerUrl}/sprite-sheet-image?name=${encodeURIComponent(name)}`,
  });

  return {
    body: npc.sprite_body ? bodyUrl(npc.sprite_body) : null,
    head: npc.sprite_head ? headUrl(npc.sprite_head) : null,
    helmet: npc.sprite_helmet ? equipUrl(npc.sprite_helmet) : null,
    shoulderguards: npc.sprite_shoulderguards ? equipUrl(npc.sprite_shoulderguards) : null,
    neck: npc.sprite_neck ? equipUrl(npc.sprite_neck) : null,
    hands: npc.sprite_hands ? equipUrl(npc.sprite_hands) : null,
    chest: npc.sprite_chest ? equipUrl(npc.sprite_chest) : null,
    feet: npc.sprite_feet ? equipUrl(npc.sprite_feet) : null,
    legs: npc.sprite_legs ? equipUrl(npc.sprite_legs) : null,
    weapon: npc.sprite_weapon ? equipUrl(npc.sprite_weapon) : null,
  };
}

// Entity sprite layers - uses player sprite templates like players, not NPC templates
export function getEntitySpriteLayers(entity: {
  sprite_type: string;
  sprite_body?: string | null;
  sprite_head?: string | null;
  sprite_helmet?: string | null;
  sprite_shoulderguards?: string | null;
  sprite_neck?: string | null;
  sprite_hands?: string | null;
  sprite_chest?: string | null;
  sprite_feet?: string | null;
  sprite_legs?: string | null;
  sprite_weapon?: string | null;
}): NpcSpriteLayers | null {
  const spriteType = entity.sprite_type || 'animated';
  if (spriteType === 'static') {
    return {
      body: entity.sprite_body ? { name: entity.sprite_body, templateUrl: null, imageUrl: `${assetServerUrl}/icon?name=${encodeURIComponent(entity.sprite_body)}` } : null,
      head: null, helmet: null, shoulderguards: null, neck: null,
      hands: null, chest: null, feet: null, legs: null, weapon: null,
    };
  }

  // Animated: use player sprite templates (not NPC templates)
  const bodyUrl = (name: string): SpriteUrl => ({
    name,
    templateUrl: `${assetServerUrl}/sprite-sheet-template?name=player_body_base`,
    imageUrl: `${assetServerUrl}/sprite-sheet-image?name=${encodeURIComponent(name)}`,
  });
  const headUrl = (name: string): SpriteUrl => ({
    name,
    templateUrl: `${assetServerUrl}/sprite-sheet-template?name=player_head_base`,
    imageUrl: `${assetServerUrl}/sprite-sheet-image?name=${encodeURIComponent(name)}`,
  });
  const equipUrl = (name: string): SpriteUrl => ({
    name,
    templateUrl: `${assetServerUrl}/sprite-sheet-template?name=${encodeURIComponent(name)}`,
    imageUrl: `${assetServerUrl}/sprite-sheet-image?name=${encodeURIComponent(name)}`,
  });

  return {
    body: entity.sprite_body ? bodyUrl(entity.sprite_body) : null,
    head: entity.sprite_head ? headUrl(entity.sprite_head) : null,
    helmet: entity.sprite_helmet ? equipUrl(entity.sprite_helmet) : null,
    shoulderguards: entity.sprite_shoulderguards ? equipUrl(entity.sprite_shoulderguards) : null,
    neck: entity.sprite_neck ? equipUrl(entity.sprite_neck) : null,
    hands: entity.sprite_hands ? equipUrl(entity.sprite_hands) : null,
    chest: entity.sprite_chest ? equipUrl(entity.sprite_chest) : null,
    feet: entity.sprite_feet ? equipUrl(entity.sprite_feet) : null,
    legs: entity.sprite_legs ? equipUrl(entity.sprite_legs) : null,
    weapon: entity.sprite_weapon ? equipUrl(entity.sprite_weapon) : null,
  };
}

// Check if sprite sheet system is available
// Since we're now generating URLs on-demand, this always returns true
export async function isSpriteSheetSystemAvailable(): Promise<boolean> {
  return true;
}
