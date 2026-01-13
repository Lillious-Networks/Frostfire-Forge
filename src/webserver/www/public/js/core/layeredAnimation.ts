/**
 * Layered Animation System
 * Manages 4-layer character animations: body, body_armor, head, head_armor
 * Supports synchronized frame updates and dynamic armor equipping
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
 * @param bodyArmorSprite - Optional body armor sprite sheet
 * @param headArmorSprite - Optional head armor sprite sheet
 * @param initialAnimation - Starting animation name (default: 'idle')
 * @returns Complete layered animation structure
 */
export async function initializeLayeredAnimation(
  mountSprite: Nullable<SpriteSheetTemplate>,
  bodySprite: Nullable<SpriteSheetTemplate>,
  headSprite: Nullable<SpriteSheetTemplate>,
  bodyArmorSprite: Nullable<SpriteSheetTemplate>,
  headArmorSprite: Nullable<SpriteSheetTemplate>,
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
  if (bodyArmorSprite && !validateSpriteSheetTemplate(bodyArmorSprite)) {
    throw new Error('Invalid body armor sprite sheet template');
  }
  if (headArmorSprite && !validateSpriteSheetTemplate(headArmorSprite)) {
    throw new Error('Invalid head armor sprite sheet template');
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

  // Load head layer if provided (zIndex: 2)
  const headLayer = headSprite
    ? await createAnimationLayer('head', headSprite, initialAnimation, 2, isMounted)
    : null;

  // Load body armor layer if equipped (zIndex: 1)
  const bodyArmorLayer = bodyArmorSprite
    ? await createAnimationLayer('body_armor', bodyArmorSprite, initialAnimation, 1, false)
    : null;

  // Load head armor layer if equipped (zIndex: 3)
  const headArmorLayer = headArmorSprite
    ? await createAnimationLayer('head_armor', headArmorSprite, initialAnimation, 3, false)
    : null;

  return {
    layers: {
      mount: mountLayer,
      body: bodyLayer,
      body_armor: bodyArmorLayer,
      head: headLayer,
      head_armor: headArmorLayer
    },
    currentAnimationName: initialAnimation,
    syncFrames: true
  };
}

/**
 * Creates a single animation layer
 * @param type - Layer type (mount, body, body_armor, head, head_armor)
 * @param spriteSheet - Sprite sheet template for this layer
 * @param animationName - Initial animation to load
 * @param zIndex - Render order (-1 = mount behind, 0 = back, higher = front)
 * @param isMounted - Whether the player is mounted (for body/head layers)
 * @returns Initialized animation layer
 */
async function createAnimationLayer(
  type: 'mount' | 'body' | 'body_armor' | 'head' | 'head_armor',
  spriteSheet: SpriteSheetTemplate,
  animationName: string,
  zIndex: number,
  isMounted: boolean = false
): Promise<AnimationLayer> {

  // Check if sprite sheet is already cached
  if (!spriteSheetCache[spriteSheet.name]) {
    // Load sprite sheet image - use imageData from server if available, otherwise imageSource
    const imageSource = (spriteSheet as any).imageData || spriteSheet.imageSource;
    const image = await preloadSpriteSheetImage(imageSource);

    // Extract all frames from the sprite sheet (now async - waits for all frames to load)
    const extractedFrames = await extractFramesFromSpriteSheet(image, spriteSheet);

    // Deep clone the sprite sheet template to prevent mutations to the original from affecting the cache
    const clonedTemplate = JSON.parse(JSON.stringify(spriteSheet));

    // Cache for reuse
    spriteSheetCache[spriteSheet.name] = {
      imageElement: image,
      template: clonedTemplate,
      extractedFrames
    };
  }

  const cached = spriteSheetCache[spriteSheet.name];

  // For body/head layers: if mounted, convert idle/walk animations to mount_idle/mount_walk
  let actualAnimationName = animationName;
  if (isMounted && (type === 'body' || type === 'head')) {
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

  if (layeredAnim.syncFrames) {
    // Synchronized mode: all layers advance frames together
    // Use body layer for timing if available, otherwise use first available layer
    const timingLayer = layeredAnim.layers.body || layers[0];

    if (!timingLayer || timingLayer.frames.length === 0) return;

    const currentFrame = timingLayer.frames[timingLayer.currentFrame];

    if (!currentFrame) return;

    if (now - timingLayer.lastFrameTime >= currentFrame.delay) {
      // Advance all layers simultaneously
      layers.forEach(layer => {
        if (layer.frames.length > 0) {
          layer.currentFrame = (layer.currentFrame + 1) % layer.frames.length;
          layer.lastFrameTime = now;
        }
      });
    }
  } else {
    // Independent mode: each layer advances at its own pace
    layers.forEach(layer => {
      if (layer.frames.length === 0) return;

      const currentFrame = layer.frames[layer.currentFrame];

      if (!currentFrame) return;

      if (now - layer.lastFrameTime >= currentFrame.delay) {
        layer.currentFrame = (layer.currentFrame + 1) % layer.frames.length;
        layer.lastFrameTime = now;
      }
    });
  }
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
        const cached = spriteSheetCache[layer.spriteSheet.name];

        if (!cached) {
          console.error(`Sprite sheet "${layer.spriteSheet.name}" not found in cache`);
          return;
        }

        // Determine the actual animation name for this layer
        let actualAnimationName = newAnimationName;

        // For body/head layers: if mounted, convert idle/walk animations to mount_idle/mount_walk
        if (isMounted && (layer.type === 'body' || layer.type === 'head')) {
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
 * Equips or unequips armor on a specific layer
 * @param layeredAnim - The layered animation to update
 * @param layerType - Which armor layer to update (body_armor or head_armor)
 * @param armorSprite - Sprite sheet for the armor (null to unequip)
 */
export async function updateArmorLayer(
  layeredAnim: LayeredAnimation,
  layerType: 'body_armor' | 'head_armor',
  armorSprite: Nullable<SpriteSheetTemplate>
): Promise<void> {
  if (armorSprite) {
    // Validate armor sprite
    if (!validateSpriteSheetTemplate(armorSprite)) {
      console.error(`Invalid ${layerType} sprite sheet template`);
      return;
    }

    // Equip armor
    const zIndex = layerType === 'body_armor' ? 1 : 3;
    layeredAnim.layers[layerType] = await createAnimationLayer(
      layerType,
      armorSprite,
      layeredAnim.currentAnimationName,
      zIndex,
      false
    );
  } else {
    // Unequip armor
    layeredAnim.layers[layerType] = null;
  }
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

    // Build new frames for body and head first (async operations)
    const frameUpdates: Array<{ layer: AnimationLayer, frames: AnimationFrame[] }> = [];

    for (const layer of [layeredAnim.layers.body, layeredAnim.layers.head]) {
      if (layer && layer.spriteSheet) {
        const cached = spriteSheetCache[layer.spriteSheet.name];
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
  layerType: 'mount' | 'body' | 'body_armor' | 'head' | 'head_armor'
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
  layerType: 'mount' | 'body' | 'body_armor' | 'head' | 'head_armor',
  visible: boolean
): void {
  const layer = layeredAnim.layers[layerType];
  if (layer) {
    layer.visible = visible;
  }
}
