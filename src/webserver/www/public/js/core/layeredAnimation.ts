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

  // Load head layer if provided (zIndex: 1)
  const headLayer = headSprite
    ? await createAnimationLayer('head', headSprite, initialAnimation, 1, isMounted)
    : null;

  // Load armor layers with ascending z-indexes (render order: helmet, neck, hands, chest, feet, legs, weapon)
  const armorHelmetLayer = armorHelmetSprite
    ? await createAnimationLayer('armor_helmet', armorHelmetSprite, initialAnimation, 2, isMounted)
    : null;

  const armorNeckLayer = armorNeckSprite
    ? await createAnimationLayer('armor_neck', armorNeckSprite, initialAnimation, 3, isMounted)
    : null;

  const armorHandsLayer = armorHandsSprite
    ? await createAnimationLayer('armor_hands', armorHandsSprite, initialAnimation, 4, isMounted)
    : null;

  const armorChestLayer = armorChestSprite
    ? await createAnimationLayer('armor_chest', armorChestSprite, initialAnimation, 5, isMounted)
    : null;

  const armorFeetLayer = armorFeetSprite
    ? await createAnimationLayer('armor_feet', armorFeetSprite, initialAnimation, 6, isMounted)
    : null;

  const armorLegsLayer = armorLegsSprite
    ? await createAnimationLayer('armor_legs', armorLegsSprite, initialAnimation, 7, isMounted)
    : null;

  const armorWeaponLayer = armorWeaponSprite
    ? await createAnimationLayer('armor_weapon', armorWeaponSprite, initialAnimation, 8, isMounted)
    : null;

  return {
    layers: {
      mount: mountLayer,
      body: bodyLayer,
      head: headLayer,
      armor_helmet: armorHelmetLayer,
      armor_neck: armorNeckLayer,
      armor_hands: armorHandsLayer,
      armor_chest: armorChestLayer,
      armor_feet: armorFeetLayer,
      armor_legs: armorLegsLayer,
      armor_weapon: armorWeaponLayer
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
  type: 'mount' | 'body' | 'head' | 'armor_helmet' | 'armor_neck' | 'armor_hands' | 'armor_chest' | 'armor_feet' | 'armor_legs' | 'armor_weapon',
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
    const extractedFrames = await extractFramesFromSpriteSheet(image, spriteSheet);

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
    cached.extractedFrames
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
          cached.extractedFrames
        );
        layer.currentFrame = 0;
        layer.lastFrameTime = performance.now();
      }
    });

  await Promise.all(layerUpdates);
}


/**
 * Mounts or unmounts a mount
 * @param layeredAnim - The layered animation to update
 * @param mountSprite - Sprite sheet for the mount (null to unmount)
 */
export async function updateMountLayer(
  layeredAnim: LayeredAnimation,
  mountSprite: Nullable<SpriteSheetTemplate>
): Promise<void> {
  const wasMounted = layeredAnim.layers.mount !== null;

  if (mountSprite) {
    // Validate mount sprite
    if (!validateSpriteSheetTemplate(mountSprite)) {
      console.error('Invalid mount sprite sheet template');
      return;
    }

    // Mount
    layeredAnim.layers.mount = await createAnimationLayer(
      'mount',
      mountSprite,
      layeredAnim.currentAnimationName,
      -1,
      false
    );
  } else {
    // Unmount
    layeredAnim.layers.mount = null;
  }

  const isNowMounted = layeredAnim.layers.mount !== null;

  // If mount status changed, update body/head layers and reset all layers to sync
  if (wasMounted !== isNowMounted) {
    // Manually update body and head layers to switch animation
    const isMounted = isNowMounted;
    const currentAnim = layeredAnim.currentAnimationName;

    // Build new frames for body, head, and all armor layers (async operations)
    const frameUpdates: Array<{ layer: AnimationLayer, frames: AnimationFrame[] }> = [];

    const layersToUpdate = [
      layeredAnim.layers.body,
      layeredAnim.layers.head,
      layeredAnim.layers.armor_helmet,
      layeredAnim.layers.armor_neck,
      layeredAnim.layers.armor_hands,
      layeredAnim.layers.armor_chest,
      layeredAnim.layers.armor_feet,
      layeredAnim.layers.armor_legs,
      layeredAnim.layers.armor_weapon
    ];

    for (const layer of layersToUpdate) {
      if (layer && layer.spriteSheet) {
        // Normalize sprite sheet name to lowercase for case-insensitive lookup
        const normalizedName = layer.spriteSheet.name.toLowerCase();
        const cached = spriteSheetCache[normalizedName];
        if (!cached) continue;

        // Convert animation name based on mounted status
        let actualAnimationName = currentAnim;
        if (isMounted) {
          if (currentAnim.startsWith('idle_')) {
            // idle_down -> mount_idle_down
            actualAnimationName = currentAnim.replace('idle_', 'mount_idle_');
          } else if (currentAnim.startsWith('walk_')) {
            // walk_down -> mount_walk_down
            actualAnimationName = currentAnim.replace('walk_', 'mount_walk_');
          }
        }
        // When unmounting, just use the stored animation name (idle/walk)

        // Use the cached template instead of layer.spriteSheet to avoid mutations
        const newFrames = await buildAnimationFrames(
          cached.template,
          actualAnimationName,
          cached.extractedFrames
        );

        frameUpdates.push({ layer, frames: newFrames });
      }
    }

    // Now apply all updates atomically to avoid race conditions
    const now = performance.now();

    // Apply frame updates
    for (const update of frameUpdates) {
      update.layer.frames = update.frames;
      update.layer.currentFrame = 0;
      update.layer.lastFrameTime = now;
    }

    // Reset all layers to frame 0 to keep them in perfect sync
    const allLayers = Object.values(layeredAnim.layers).filter(l => l !== null) as AnimationLayer[];
    for (const layer of allLayers) {
      if (layer && layer.frames.length > 0) {
        layer.currentFrame = 0;
        layer.lastFrameTime = now;
      }
    }
  }
}

/**
 * Gets all visible layers sorted by z-index for rendering
 * @param layeredAnim - The layered animation
 * @returns Array of layers sorted by render order
 */
export function getVisibleLayersSorted(layeredAnim: LayeredAnimation): AnimationLayer[] {
  const layers = Object.values(layeredAnim.layers)
    .filter(l => l !== null && l.visible) as AnimationLayer[];

  return layers.sort((a, b) => a.zIndex - b.zIndex);
}

/**
 * Clears the sprite sheet cache (useful for memory management)
 */
export function clearSpriteSheetCache(): void {
  for (const key in spriteSheetCache) {
    delete spriteSheetCache[key];
  }
}

/**
 * Gets a specific layer from the layered animation
 * @param layeredAnim - The layered animation
 * @param layerType - Which layer to get
 * @returns The layer or null if not present
 */
export function getLayer(
  layeredAnim: LayeredAnimation,
  layerType: 'mount' | 'body' | 'head' | 'armor_helmet' | 'armor_neck' | 'armor_hands' | 'armor_chest' | 'armor_feet' | 'armor_legs' | 'armor_weapon'
): Nullable<AnimationLayer> {
  return layeredAnim.layers[layerType];
}

/**
 * Sets visibility of a specific layer
 * @param layeredAnim - The layered animation
 * @param layerType - Which layer to modify
 * @param visible - Whether the layer should be visible
 */
export function setLayerVisibility(
  layeredAnim: LayeredAnimation,
  layerType: 'mount' | 'body' | 'head' | 'armor_helmet' | 'armor_neck' | 'armor_hands' | 'armor_chest' | 'armor_feet' | 'armor_legs' | 'armor_weapon',
  visible: boolean
): void {
  const layer = layeredAnim.layers[layerType];
  if (layer) {
    layer.visible = visible;
  }
}
