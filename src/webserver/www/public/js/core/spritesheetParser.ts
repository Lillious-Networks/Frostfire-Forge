/**
 * Sprite Sheet Parser
 * Handles extraction of individual frames from sprite sheet grids
 * and building animation sequences
 */

/**
 * Extracts individual frames from a sprite sheet grid
 * @param image - Loaded sprite sheet image
 * @param template - Sprite sheet template with frame dimensions
 * @returns Map of frame index to extracted frame images
 */
export async function extractFramesFromSpriteSheet(
  image: HTMLImageElement,
  template: SpriteSheetTemplate
): Promise<Map<number, HTMLImageElement>> {
  const frames = new Map<number, HTMLImageElement>();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  if (!ctx) {
    console.error('Failed to get canvas context for sprite sheet extraction');
    return frames;
  }

  canvas.width = template.frameWidth;
  canvas.height = template.frameHeight;

  const totalFrames = template.columns * template.rows;
  const loadPromises: Promise<void>[] = [];

  for (let i = 0; i < totalFrames; i++) {
    const col = i % template.columns;
    const row = Math.floor(i / template.columns);

    const sourceX = col * template.frameWidth;
    const sourceY = row * template.frameHeight;

    // Clear canvas with transparent background
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Extract frame
    ctx.drawImage(
      image,
      sourceX, sourceY,
      template.frameWidth, template.frameHeight,
      0, 0,
      template.frameWidth, template.frameHeight
    );

    // Create new image from extracted frame
    const frameImage = new Image();
    const dataUrl = canvas.toDataURL('image/png');

    // Wait for this frame to load before continuing
    const loadPromise = new Promise<void>((resolve, reject) => {
      frameImage.onload = () => resolve();
      frameImage.onerror = () => {
        console.error(`Failed to load extracted frame ${i}`);
        reject(new Error(`Failed to load extracted frame ${i}`));
      };
    });

    loadPromises.push(loadPromise);
    frameImage.src = dataUrl;
    frames.set(i, frameImage);
  }

  // Wait for all frames to load
  await Promise.all(loadPromises);

  return frames;
}

/**
 * Builds animation frames for a specific animation from sprite sheet
 * @param spriteSheet - The sprite sheet template
 * @param animationName - Name of the animation to build
 * @param extractedFrames - Map of already extracted frame images
 * @returns Array of animation frames ready for rendering
 */
export async function buildAnimationFrames(
  spriteSheet: SpriteSheetTemplate,
  animationName: string,
  extractedFrames: Map<number, HTMLImageElement>
): Promise<AnimationFrame[]> {
  // Parse animation name to support directional animations: "idle_down", "walk_up", "mount_idle_down", etc.
  let animation: any;
  let animConfig: any;

  // Check if animationName contains a direction (e.g., "idle_down", "mount_idle_down")
  if (animationName.includes('_')) {
    // Split on LAST underscore to handle multi-part names like "mount_idle_down"
    const lastUnderscoreIndex = animationName.lastIndexOf('_');
    const baseName = animationName.substring(0, lastUnderscoreIndex);
    const direction = animationName.substring(lastUnderscoreIndex + 1);

    animation = spriteSheet.animations[baseName];

    if (animation?.directions) {
      animConfig = animation.directions[direction];
      if (!animConfig) {
        console.warn(`Direction "${direction}" not found for animation "${baseName}" in sprite sheet "${spriteSheet.name}"`);
        // Fallback to first available direction
        const firstDirection = Object.keys(animation.directions)[0];
        animConfig = animation.directions[firstDirection];
      }
    } else {
      animConfig = animation;
    }
  } else {
    // No direction specified
    animation = spriteSheet.animations[animationName];

    // If animation has directions, default to "down"
    if (animation?.directions) {
      animConfig = animation.directions['down'] || animation.directions[Object.keys(animation.directions)[0]];
    } else {
      // Old format without directions
      animConfig = animation;
    }
  }

  if (!animConfig || !animConfig.frames) {
    console.error(`Animation "${animationName}" not found or has no frames in sprite sheet "${spriteSheet.name}"`);
    console.log(`Available animations in "${spriteSheet.name}":`, Object.keys(spriteSheet.animations));
    return [];
  }

  // Create a defensive copy of the frames array to prevent mutations
  const frameIndices = Array.isArray(animConfig.frames) ? [...animConfig.frames] : [];

  if (frameIndices.length === 0) {
    console.error(`Animation "${animationName}" has empty frames array in sprite sheet "${spriteSheet.name}"`);
    return [];
  }

  const frames: AnimationFrame[] = [];

  for (const frameIndex of frameIndices) {
    const sourceFrameImage = extractedFrames.get(frameIndex);

    if (!sourceFrameImage) {
      console.error(`Frame ${frameIndex} not found in extracted frames for sprite sheet "${spriteSheet.name}"!`, `Available frames:`, Array.from(extractedFrames.keys()));
      continue;
    }

    if (!sourceFrameImage.complete) {
      console.warn(`Frame ${frameIndex} from "${spriteSheet.name}" is not fully loaded yet!`);
    }

    frames.push({
      imageElement: sourceFrameImage,
      width: spriteSheet.frameWidth,
      height: spriteSheet.frameHeight,
      delay: animConfig.frameDuration,
      offset: animConfig.offset || { x: 0, y: 0 }
    });
  }

  if (frames.length !== frameIndices.length) {
    console.error(`Built ${frames.length} frames for "${animationName}" but expected ${frameIndices.length}. Some frames are missing!`);
  }

  return frames;
}

/**
 * Loads sprite sheet template from compressed data
 * @param templateData - Compressed or raw template data
 * @returns Parsed sprite sheet template
 */
/**
 * Validates a sprite sheet template structure
 * @param template - Template to validate
 * @returns True if valid, false otherwise
 */
export function validateSpriteSheetTemplate(template: any): boolean {
  if (!template) return false;

  const requiredFields = [
    'name',
    'imageSource',
    'frameWidth',
    'frameHeight',
    'columns',
    'rows',
    'animations'
  ];

  for (const field of requiredFields) {
    if (!(field in template)) {
      console.error(`Sprite sheet template missing required field: ${field}`);
      return false;
    }
  }

  // Validate dimensions
  if (template.frameWidth <= 0 || template.frameHeight <= 0) {
    console.error('Sprite sheet frame dimensions must be positive');
    return false;
  }

  if (template.columns <= 0 || template.rows <= 0) {
    console.error('Sprite sheet columns and rows must be positive');
    return false;
  }

  // Validate animations
  if (typeof template.animations !== 'object') {
    console.error('Sprite sheet animations must be an object');
    return false;
  }

  const totalFrames = template.columns * template.rows;

  for (const animName in template.animations) {
    const anim = template.animations[animName];

    // Check if this animation has directions (new format)
    if (anim.directions && typeof anim.directions === 'object') {
      // Validate each direction
      for (const directionName in anim.directions) {
        const direction = anim.directions[directionName];

        if (!Array.isArray(direction.frames) || direction.frames.length === 0) {
          console.error(`Animation "${animName}" direction "${directionName}" has no frames`);
          return false;
        }

        if (typeof direction.frameDuration !== 'number' || direction.frameDuration <= 0) {
          console.error(`Animation "${animName}" direction "${directionName}" has invalid frame duration`);
          return false;
        }

        if (typeof direction.loop !== 'boolean') {
          console.error(`Animation "${animName}" direction "${directionName}" has invalid loop property`);
          return false;
        }

        // Check frame indices are within bounds
        for (const frameIdx of direction.frames) {
          if (frameIdx < 0 || frameIdx >= totalFrames) {
            console.error(`Animation "${animName}" direction "${directionName}" frame index ${frameIdx} out of bounds (0-${totalFrames - 1})`);
            return false;
          }
        }
      }
    } else {
      // Old format without directions
      if (!Array.isArray(anim.frames) || anim.frames.length === 0) {
        console.error(`Animation "${animName}" has no frames`);
        return false;
      }

      if (typeof anim.frameDuration !== 'number' || anim.frameDuration <= 0) {
        console.error(`Animation "${animName}" has invalid frame duration`);
        return false;
      }

      if (typeof anim.loop !== 'boolean') {
        console.error(`Animation "${animName}" has invalid loop property`);
        return false;
      }

      // Check frame indices are within bounds
      for (const frameIdx of anim.frames) {
        if (frameIdx < 0 || frameIdx >= totalFrames) {
          console.error(`Animation "${animName}" frame index ${frameIdx} out of bounds (0-${totalFrames - 1})`);
          return false;
        }
      }
    }
  }

  return true;
}

/**
 * Preloads a sprite sheet image
 * @param imageSource - Path to the sprite sheet image
 * @returns Promise that resolves with the loaded image
 */
export async function preloadSpriteSheetImage(imageSource: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();

    image.onload = () => {
      resolve(image);
    };

    image.onerror = (error) => {
      console.error(`Failed to load sprite sheet image: ${imageSource}`, error);
      reject(new Error(`Failed to load sprite sheet image: ${imageSource}`));
    };

    // If imageSource is base64 data, use it directly as a data URL
    if (imageSource.startsWith('data:image/')) {
      image.src = imageSource;
    } else {
      // Otherwise assume it's base64 without the data URL prefix
      image.src = `data:image/png;base64,${imageSource}`;
    }
  });
}
