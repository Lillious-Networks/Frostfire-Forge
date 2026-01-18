/**
 * Layered Animation System
 * Manages multi-layer character animations: mount, body, head, and armor layers
 * Supports synchronized frame updates
 */

import {
  extractFramesFromSpriteSheet,
  buildAnimationFrames,
  preloadSpriteSheetImage,
  validateSpriteSheetTemplate
} from './spritesheetParser.js';

/**
 * Global sprite sheet cache to avoid re-extracting frames
 */
const spriteSheetCache: SpriteSheetCache = {};

/**
 * Initializes a layered animation system for a character
 * @param mountSprite - Optional mount sprite sheet
 * @param bodySprite - Base body sprite sheet template
 * @param headSprite - Base head sprite sheet template
 * @param armorHelmetSprite - Optional armor helmet sprite sheet template
 * @param armorShoulderguardsSprite - Optional armor shoulderguards sprite sheet template
 * @param armorNeckSprite - Optional armor neck sprite sheet template
 * @param armorHandsSprite - Optional armor hands sprite sheet template
 * @param armorChestSprite - Optional armor chest sprite sheet template
 * @param armorFeetSprite - Optional armor feet sprite sheet template
 * @param armorLegsSprite - Optional armor legs sprite sheet template
 * @param armorWeaponSprite - Optional armor weapon sprite sheet template
 * @param initialAnimation - Starting animation name (default: 'idle')
 * @returns Complete layered animation structure
 */
export async function initializeLayeredAnimation(
  mountSprite: Nullable<SpriteSheetTemplate>,
  bodySprite: Nullable<SpriteSheetTemplate>,
  headSprite: Nullable<SpriteSheetTemplate>,
  armorHelmetSprite: Nullable<SpriteSheetTemplate>,
  armorShoulderguardsSprite: Nullable<SpriteSheetTemplate>,
  armorNeckSprite: Nullable<SpriteSheetTemplate>,
  armorHandsSprite: Nullable<SpriteSheetTemplate>,
  armorChestSprite: Nullable<SpriteSheetTemplate>,
  armorFeetSprite: Nullable<SpriteSheetTemplate>,
  armorLegsSprite: Nullable<SpriteSheetTemplate>,
  armorWeaponSprite: Nullable<SpriteSheetTemplate>,
  initialAnimation: string = 'idle'
): Promise<LayeredAnimation> {

  // Validate templates (only if provided)
  if (mountSprite && !validateSpriteSheetTemplate(mountSprite)) {
    throw new Error('Invalid mount sprite sheet template');
  }
  if (bodySprite && !validateSpriteSheetTemplate(bodySprite)) {
    throw new Error('Invalid body sprite sheet template');
  }
  if (headSprite && !validateSpriteSheetTemplate(headSprite)) {
    throw new Error('Invalid head sprite sheet template');
  }
  if (armorHelmetSprite && !validateSpriteSheetTemplate(armorHelmetSprite)) {
    throw new Error('Invalid armor helmet sprite sheet template');
  }
  if (armorShoulderguardsSprite && !validateSpriteSheetTemplate(armorShoulderguardsSprite)) {
    throw new Error('Invalid armor shoulderguards sprite sheet template');
  }
  if (armorNeckSprite && !validateSpriteSheetTemplate(armorNeckSprite)) {
    throw new Error('Invalid armor neck sprite sheet template');
  }
  if (armorHandsSprite && !validateSpriteSheetTemplate(armorHandsSprite)) {
    throw new Error('Invalid armor hands sprite sheet template');
  }
  if (armorChestSprite && !validateSpriteSheetTemplate(armorChestSprite)) {
    throw new Error('Invalid armor chest sprite sheet template');
  }
  if (armorFeetSprite && !validateSpriteSheetTemplate(armorFeetSprite)) {
    throw new Error('Invalid armor feet sprite sheet template');
  }
  if (armorLegsSprite && !validateSpriteSheetTemplate(armorLegsSprite)) {
    throw new Error('Invalid armor legs sprite sheet template');
  }
  if (armorWeaponSprite && !validateSpriteSheetTemplate(armorWeaponSprite)) {
    throw new Error('Invalid armor weapon sprite sheet template');
  }

  const isMounted = mountSprite !== null;

  // Load mount layer if provided (zIndex: -1, renders behind everything)
  const mountLayer = mountSprite
    ? await createAnimationLayer('mount', mountSprite, initialAnimation, -1, false)
    : null;

  // Load body layer if provided (zIndex: 0)
  const bodyLayer = bodySprite
    ? await createAnimationLayer('body', bodySprite, initialAnimation, 0, isMounted)
    : null;

  // Load armor body layers (render order: neck, hands, chest, feet, legs, weapon - all below head)
  const armorNeckLayer = armorNeckSprite
    ? await createAnimationLayer('armor_neck', armorNeckSprite, initialAnimation, 1, isMounted)
    : null;

  const armorHandsLayer = armorHandsSprite
    ? await createAnimationLayer('armor_hands', armorHandsSprite, initialAnimation, 2, isMounted)
    : null;

  const armorChestLayer = armorChestSprite
    ? await createAnimationLayer('armor_chest', armorChestSprite, initialAnimation, 3, isMounted)
    : null;

  const armorFeetLayer = armorFeetSprite
    ? await createAnimationLayer('armor_feet', armorFeetSprite, initialAnimation, 4, isMounted)
    : null;

  const armorLegsLayer = armorLegsSprite
    ? await createAnimationLayer('armor_legs', armorLegsSprite, initialAnimation, 5, isMounted)
    : null;

  // Load head layer if provided (zIndex: 6, renders above body and body armor)
  const headLayer = headSprite
    ? await createAnimationLayer('head', headSprite, initialAnimation, 6, isMounted)
    : null;

  // Load helmet layer (zIndex: 7, renders above head)
  const armorHelmetLayer = armorHelmetSprite
    ? await createAnimationLayer('armor_helmet', armorHelmetSprite, initialAnimation, 7, isMounted)
    : null;

  // Load shoulderguards layer (zIndex: 8, renders above helmet)
  const armorShoulderguardsLayer = armorShoulderguardsSprite
    ? await createAnimationLayer('armor_shoulderguards', armorShoulderguardsSprite, initialAnimation, 8, isMounted)
    : null;

  // Load weapon layer (zIndex: 9, renders above shoulderguards when not facing up)
  const armorWeaponLayer = armorWeaponSprite
    ? await createAnimationLayer('armor_weapon', armorWeaponSprite, initialAnimation, 9, isMounted)
    : null;

  return {
    layers: {
      mount: mountLayer as AnimationLayer,
      body: bodyLayer as AnimationLayer,
      head: headLayer as AnimationLayer,
      armor_helmet: armorHelmetLayer as AnimationLayer,
      armor_shoulderguards: armorShoulderguardsLayer as AnimationLayer,
      armor_neck: armorNeckLayer as AnimationLayer,
      armor_hands: armorHandsLayer as AnimationLayer,
      armor_chest: armorChestLayer as AnimationLayer,
      armor_feet: armorFeetLayer as AnimationLayer,
      armor_legs: armorLegsLayer as AnimationLayer,
      armor_weapon: armorWeaponLayer as AnimationLayer
    },
    currentAnimationName: initialAnimation,
    syncFrames: true
  };
}

/**
 * Creates a single animation layer
 * @param type - Layer type
 * @param spriteSheet - Sprite sheet template for this layer
 * @param animationName - Initial animation to load
 * @param zIndex - Render order (-1 = mount behind, 0 = back, higher = front)
 * @param isMounted - Whether the player is mounted (for body/head/armor layers)
 * @returns Initialized animation layer
 */
async function createAnimationLayer(
  type: 'mount' | 'body' | 'head' | 'armor_helmet' | 'armor_shoulderguards' | 'armor_neck' | 'armor_hands' | 'armor_chest' | 'armor_feet' | 'armor_legs' | 'armor_weapon',
  spriteSheet: SpriteSheetTemplate,
  animationName: string,
  zIndex: number,
  isMounted: boolean = false
): Promise<AnimationLayer> {

  // Normalize sprite sheet name to lowercase for case-insensitive caching
  const normalizedName = spriteSheet.name.toLowerCase();

  // Check if sprite sheet is already cached
  if (!spriteSheetCache[normalizedName]) {
    // Load sprite sheet image - use imageData from server if available, otherwise imageSource
    const imageSource = (spriteSheet as any).imageData || spriteSheet.imageSource;
    const image = await preloadSpriteSheetImage(imageSource);

    // Extract all frames from the sprite sheet (now async - waits for all frames to load)
    const extractedFramesMap = await extractFramesFromSpriteSheet(image, spriteSheet);

    // Convert Map<number, HTMLImageElement> to { [frameIndex: number]: HTMLImageElement }
    const extractedFrames: { [frameIndex: number]: HTMLImageElement } = {};
    if (extractedFramesMap instanceof Map) {
      extractedFramesMap.forEach((value, key) => {
        extractedFrames[key] = value;
      });
    } else {
      Object.assign(extractedFrames, extractedFramesMap);
    }

    // Deep clone the sprite sheet template to prevent mutations to the original from affecting the cache
    const clonedTemplate = JSON.parse(JSON.stringify(spriteSheet));

    // Cache for reuse with normalized name
    spriteSheetCache[normalizedName] = {
      imageElement: image,
      template: clonedTemplate,
      extractedFrames
    };
  }

  const cached = spriteSheetCache[normalizedName];

  // For body/head/armor layers: if mounted, convert idle/walk animations to mount_idle/mount_walk
  let actualAnimationName = animationName;
  const isArmorLayer = type.startsWith('armor_');
  if (isMounted && (type === 'body' || type === 'head' || isArmorLayer)) {
    if (animationName.startsWith('idle_')) {
      // idle_down -> mount_idle_down
      actualAnimationName = animationName.replace('idle_', 'mount_idle_');
    } else if (animationName.startsWith('walk_')) {
      // walk_down -> mount_walk_down
      actualAnimationName = animationName.replace('walk_', 'mount_walk_');
    }
  }

  // Build animation frames for the initial animation
  const frames = await buildAnimationFrames(
    spriteSheet,
    actualAnimationName,
    new Map<number, HTMLImageElement>(Object.entries(cached.extractedFrames).map(([k, v]) => [Number(k), v]))
  );

  if (frames.length === 0) {
    console.warn(`No frames loaded for animation "${actualAnimationName}" in layer "${type}"`);
  }

  return {
    type,
    spriteSheet,
    frames,
    currentFrame: 0,
    lastFrameTime: performance.now(),
    zIndex,
    visible: true
  };
}

/**
 * Updates animation frames for all layers
 * Should be called every render frame
 * @param layeredAnim - The layered animation to update
 * @param deltaTime - Time since last update (not currently used, kept for future frame-independent timing)
 */
export function updateLayeredAnimation(
  layeredAnim: LayeredAnimation,
  deltaTime: number
): void {
  const now = performance.now();
  const layers = Object.values(layeredAnim.layers).filter(l => l !== null) as AnimationLayer[];

  if (layers.length === 0) return;

  // Each layer advances independently based on its own frame delays
  layers.forEach(layer => {
    if (layer.frames.length === 0) return;

    const currentFrame = layer.frames[layer.currentFrame];

    if (!currentFrame) return;

    if (now - layer.lastFrameTime >= currentFrame.delay) {
      layer.currentFrame = (layer.currentFrame + 1) % layer.frames.length;
      layer.lastFrameTime += currentFrame.delay;
    }
  });
}

/**
 * Changes the current animation for all layers
 * @param layeredAnim - The layered animation to update
 * @param newAnimationName - Name of the new animation
 */
export async function changeLayeredAnimation(
  layeredAnim: LayeredAnimation,
  newAnimationName: string
): Promise<void> {
  if (layeredAnim.currentAnimationName === newAnimationName) return;

  layeredAnim.currentAnimationName = newAnimationName;

  const isMounted = layeredAnim.layers.mount !== null;

  // Update frames for each layer
  const layerUpdates = Object.values(layeredAnim.layers)
    .filter(l => l !== null)
    .map(async (layer) => {
      if (layer && layer.spriteSheet) {
        // Normalize sprite sheet name to lowercase for case-insensitive lookup
        const normalizedName = layer.spriteSheet.name.toLowerCase();
        const cached = spriteSheetCache[normalizedName];

        if (!cached) {
          console.error(`Sprite sheet "${layer.spriteSheet.name}" not found in cache`);
          return;
        }

        // Determine the actual animation name for this layer
        let actualAnimationName = newAnimationName;

        const isArmorLayer = layer.type.startsWith('armor_');
        // For body/head/armor layers: if mounted, convert idle/walk animations to mount_idle/mount_walk
        if (isMounted && (layer.type === 'body' || layer.type === 'head' || isArmorLayer)) {
          if (newAnimationName.startsWith('idle_')) {
            // idle_down -> mount_idle_down
            actualAnimationName = newAnimationName.replace('idle_', 'mount_idle_');
          } else if (newAnimationName.startsWith('walk_')) {
            // walk_down -> mount_walk_down
            actualAnimationName = newAnimationName.replace('walk_', 'mount_walk_');
          }
        }
        // For mount layer: always use the same animation name as player (mount follows player direction)
        else if (layer.type === 'mount') {
          // Mount uses the player's animation name as-is (idle_down, walk_left, etc.)
          actualAnimationName = newAnimationName;
        }

        // Check if animation exists (support both direct and directional formats)
        // Use cached template to check animations, not layer.spriteSheet which may be mutated
        let animationExists = false;

        // Check for direct animation
        if (cached.template.animations[actualAnimationName]) {
          animationExists = true;
        } else if (actualAnimationName.includes('_')) {
          // Check for directional animation (e.g., "idle_down", "mount_idle_down")
          // Split on LAST underscore to handle multi-part names
          const lastUnderscoreIndex = actualAnimationName.lastIndexOf('_');
          const baseName = actualAnimationName.substring(0, lastUnderscoreIndex);
          const direction = actualAnimationName.substring(lastUnderscoreIndex + 1);
          if (cached.template.animations[baseName]?.directions?.[direction]) {
            animationExists = true;
          }
        }

        if (!animationExists) {
          console.warn(`Animation "${actualAnimationName}" not found in sprite sheet "${cached.template.name}"`);
          return;
        }

        // Use the cached template instead of layer.spriteSheet to avoid mutations
        layer.frames = await buildAnimationFrames(
          cached.template,
          actualAnimationName,
          new Map<number, HTMLImageElement>(Object.entries(cached.extractedFrames).map(([k, v]) => [Number(k), v]))
        );
        layer.currentFrame = 0;
        layer.lastFrameTime = performance.now();
      }
    });

  await Promise.all(layerUpdates);
}


/**
 * Gets all visible layers sorted by z-index for rendering
 * @param layeredAnim - The layered animation
 * @returns Array of layers sorted by render order
 */
export function getVisibleLayersSorted(layeredAnim: LayeredAnimation): AnimationLayer[] {
  const layers = Object.values(layeredAnim.layers)
    .filter(l => l !== null && l.visible) as AnimationLayer[];

  // Determine current direction from animation name
  const animName = layeredAnim.currentAnimationName;
  const direction = animName.split('_').pop() || '';
  const isUpDirection = direction === 'up' || direction === 'upleft' || direction === 'upright';

  // Dynamically adjust layer zIndex based on direction
  return layers.map(layer => {
    // When facing up: shoulderguards and weapon should render behind everything
    if (isUpDirection) {
      if (layer.type === 'armor_shoulderguards') {
        // Shoulderguards render below head
        return { ...layer, zIndex: 5.3 }; // Between legs (5) and head (6)
      }
      if (layer.type === 'armor_weapon') {
        // Weapon renders behind everything (even behind mount)
        return { ...layer, zIndex: -2 }; // Behind mount (-1)
      }
    }
    return layer;
  }).sort((a, b) => a.zIndex - b.zIndex);
}

