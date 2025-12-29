import { weatherCanvas, weatherCtx } from "./ui.ts";

// Set initial canvas size to viewport with buffer
const dpr = window.devicePixelRatio || 1;
const buffer = 200; // Extra pixels on each side
let width: number = window.innerWidth + buffer * 2;
let height: number = window.innerHeight + buffer * 2;
weatherCanvas.width = width * dpr;
weatherCanvas.height = height * dpr;
weatherCanvas.style.width = width + "px";
weatherCanvas.style.height = height + "px";
if (weatherCtx) {
  weatherCtx.scale(dpr, dpr);
}

// Track camera offset for rain movement
let cameraOffsetX = 0;
let cameraOffsetY = 0;

// Track time for frame-rate independent animation
let lastFrameTime = performance.now();
const TARGET_FPS = 60;
const FRAME_TIME = 1000 / TARGET_FPS;

// Handle window resize
window.addEventListener("resize", () => {
  const dpr = window.devicePixelRatio || 1;
  width = window.innerWidth + buffer * 2;
  height = window.innerHeight + buffer * 2;
  weatherCanvas.width = width * dpr;
  weatherCanvas.height = height * dpr;
  weatherCanvas.style.width = width + "px";
  weatherCanvas.style.height = height + "px";
  if (weatherCtx) {
    weatherCtx.setTransform(1, 0, 0, 1, 0, 0); // Reset transform
    weatherCtx.scale(dpr, dpr);
  }
});

// Splash particle
class SplashParticle {
  worldX = 0; // World X coordinate (relative to camera)
  worldY = 0; // World Y coordinate (relative to camera)
  alpha = 0;
  radius = 0;
  maxRadius = 0;
  growthRate = 0;
  active = false; // reuse flag

  init(x: number, y: number, depthFactor: number = 1) {
    // Store position in world space (with current camera offset)
    this.worldX = x + cameraOffsetX;
    this.worldY = y + cameraOffsetY;
    this.alpha = 0.8; // Moderate opacity
    this.radius = 1;
    // Moderate splash size - scale with depth
    this.maxRadius = (3 + Math.random() * 3) * depthFactor;
    this.growthRate = 0.5 * depthFactor;
    this.active = true;
  }

  update(deltaTime: number) {
    if (!this.active) return;
    this.alpha -= 0.05 * deltaTime;
    this.radius += this.growthRate * deltaTime;
    if (this.alpha <= 0 || this.radius >= this.maxRadius * 2) this.active = false;
  }

  draw(ctx: CanvasRenderingContext2D) {
    if (!this.active) return;

    // Convert world position to screen position (compensate for camera movement)
    const screenX = this.worldX - cameraOffsetX;
    const screenY = this.worldY - cameraOffsetY;

    // Only draw if visible on screen
    if (screenX < -50 || screenX > width + 50 || screenY < -50 || screenY > height + 50) return;

    ctx.strokeStyle = `rgba(200,230,255,${this.alpha})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(screenX, screenY, this.radius, 0, Math.PI * 2);
    ctx.stroke();
  }
}

// Rain particle
class RainParticle {
  x = 0;
  y = 0;
  speed = 0;
  length = 0;
  tilt = 0;
  opacity = 0;
  trail: Array<{ x: number; y: number; alpha: number }> = [];
  splashHeight = 0; // Random height where this raindrop will splash

  constructor(spawnY?: number) {
    this.reset(spawnY);
  }

  reset(spawnY?: number) {
    this.x = Math.random() * width;
    this.y = spawnY ?? Math.random() * height;
    this.speed = 30 + Math.random() * 20; // Even faster
    // Adjust trail length inversely with speed to maintain consistent visual length
    const baseLength = 2; // Target visual length in pixels (shorter)
    this.length = baseLength;
    this.tilt = -0.5 + Math.random();
    this.opacity = 0.8 + Math.random() * 0.2; // Higher opacity for better visibility
    this.trail = [];

    // Set random splash height to create depth (anywhere from 40% to 100% down the screen)
    this.splashHeight = height * (0.4 + Math.random() * 0.6);
  }

  update(deltaTime: number) {
    this.y += this.speed * deltaTime;
    this.x += this.tilt * deltaTime;

    this.trail.push({ x: this.x, y: this.y, alpha: this.opacity });
    if (this.trail.length > this.length) this.trail.shift();

    // Create splash when raindrop reaches its splash height
    if (this.y >= this.splashHeight && this.trail.length > 0) {
      const splash = splashPool.find(s => !s.active);
      if (splash) {
        // Scale splash based on depth - closer to bottom = larger
        const depthFactor = this.splashHeight / height;
        splash.init(this.x, this.splashHeight, depthFactor);
      }
      // Reuse particle by resetting it to spawn at top
      this.reset(0);
    }
  }

  draw(ctx: CanvasRenderingContext2D) {
    if (this.trail.length < 2) return;

    // Brighter, more visible rain with white/light blue color
    ctx.strokeStyle = `rgba(200,230,255,${this.opacity})`;
    ctx.lineWidth = 1; // Skinnier lines
    ctx.lineCap = "round";

    ctx.beginPath();
    const first = this.trail[0];
    ctx.moveTo(first.x, first.y);
    for (const point of this.trail) {
      ctx.lineTo(point.x, point.y);
    }
    ctx.stroke();
  }
}

// Snow particle
class SnowParticle {
  x = 0;
  y = 0;
  speed = 0;
  size = 0;
  opacity = 0;
  windSpeed = 0;
  turbulence = 0;
  rotation = 0;
  rotationSpeed = 0;
  time = 0;
  depth = 0; // 0-1, closer to 1 is foreground
  meltHeight = 0; // Random height where snowflake melts

  constructor(spawnY?: number) {
    this.reset(spawnY);
  }

  reset(spawnY?: number) {
    this.x = Math.random() * width;
    this.y = spawnY ?? Math.random() * height;

    // Depth affects size, speed, and opacity
    this.depth = Math.random();
    const depthFactor = 0.3 + this.depth * 0.7;

    // Blizzard: much faster falling with wind
    this.speed = (4 + Math.random() * 8) * depthFactor;
    this.size = (1 + Math.random() * 1.5) * depthFactor; // Smaller particles
    this.opacity = (0.85 + Math.random() * 0.15); // Very opaque, don't scale with depth

    // Strong horizontal wind with turbulence
    this.windSpeed = (3 + Math.random() * 5) * depthFactor;
    this.turbulence = Math.random() * 2;

    this.rotation = Math.random() * Math.PI * 2;
    this.rotationSpeed = (Math.random() - 0.5) * 0.1 * depthFactor; // Faster rotation in blizzard
    this.time = Math.random() * 100;

    // Set random melt height for depth (anywhere from 40% to 100% down the screen)
    this.meltHeight = height * (0.4 + Math.random() * 0.6);
  }

  update(deltaTime: number) {
    // Vertical movement
    this.y += this.speed * deltaTime;

    // Strong horizontal wind movement (blizzard effect)
    this.x += this.windSpeed * deltaTime;

    // Add turbulence for chaotic movement
    this.time += 0.02 * deltaTime;
    this.x += Math.sin(this.time * this.turbulence) * 0.8 * deltaTime;
    this.y += Math.cos(this.time * this.turbulence * 0.7) * 0.3 * deltaTime;

    // Rotate faster in wind
    this.rotation += this.rotationSpeed * deltaTime;

    // Create melt when snowflake reaches its melt height
    if (this.y >= this.meltHeight) {
      const melt = meltPool.find(m => !m.active);
      if (melt) {
        melt.init(this.x, this.meltHeight, this.size);
      }
      // Respawn snowflake at top, across entire width
      this.reset(-20);
    }

    // Also reset when off screen horizontally
    if (this.x > width + 50 || this.x < -50) {
      this.reset(-20);
    }
  }

  draw(ctx: CanvasRenderingContext2D) {
    ctx.save();
    ctx.globalAlpha = this.opacity;
    ctx.translate(this.x, this.y);
    ctx.rotate(this.rotation);

    // Draw bright white snowflake
    ctx.fillStyle = 'rgba(255,255,255,1)';
    ctx.beginPath();
    ctx.arc(0, 0, this.size, 0, Math.PI * 2);
    ctx.fill();

    // Add outer glow for visibility
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.beginPath();
    ctx.arc(0, 0, this.size * 1.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }
}

// Create rain particles - reduce count on mobile devices
const rainParticles: RainParticle[] = [];
const isMobileDevice = window.matchMedia("(hover: none) and (pointer: coarse)").matches;
const rainCount = isMobileDevice ? 50 : 100; // 50% fewer particles on mobile
for (let i = 0; i < rainCount; i++) {
  rainParticles.push(new RainParticle(Math.random() * height));
}

// Melt particle (for snow hitting ground)
class MeltParticle {
  worldX = 0;
  worldY = 0;
  alpha = 0;
  size = 0;
  active = false;

  init(x: number, y: number, snowSize: number) {
    this.worldX = x + cameraOffsetX;
    this.worldY = y + cameraOffsetY;
    this.alpha = 0.6;
    this.size = snowSize * 1.5;
    this.active = true;
  }

  update(deltaTime: number) {
    if (!this.active) return;
    this.alpha -= 0.025 * deltaTime;
    this.size += 0.15 * deltaTime;
    if (this.alpha <= 0) this.active = false;
  }

  draw(ctx: CanvasRenderingContext2D) {
    if (!this.active) return;

    const screenX = this.worldX - cameraOffsetX;
    const screenY = this.worldY - cameraOffsetY;

    if (screenX < -50 || screenX > width + 50 || screenY < -50 || screenY > height + 50) return;

    // Draw melt spot with soft edges
    ctx.fillStyle = `rgba(210,230,250,${this.alpha * 0.4})`;
    ctx.beginPath();
    ctx.arc(screenX, screenY, this.size, 0, Math.PI * 2);
    ctx.fill();
  }
}

// Create snow particles - reduce count on mobile devices
const snowParticles: SnowParticle[] = [];
const snowCount = isMobileDevice ? 200 : 400; // 50% fewer particles on mobile
for (let i = 0; i < snowCount; i++) {
  snowParticles.push(new SnowParticle(Math.random() * height));
}

// Pre-create melt particle pool - reduce on mobile
const meltPoolSize = isMobileDevice ? 50 : 100;
const meltPool: MeltParticle[] = [];
for (let i = 0; i < meltPoolSize; i++) {
  meltPool.push(new MeltParticle());
}

// Pre-create splash particle pool - reduce on mobile
const splashPoolSize = isMobileDevice ? 50 : 100;
const splashPool: SplashParticle[] = [];
for (let i = 0; i < splashPoolSize; i++) {
  splashPool.push(new SplashParticle());
}

// Main animation function
function weather(type: string): void {
  if (!weatherCtx) return;

  // Calculate delta time for frame-rate independent animation
  const currentTime = performance.now();
  const deltaMs = currentTime - lastFrameTime;
  lastFrameTime = currentTime;

  // Normalize to 60fps (deltaTime = 1.0 at 60fps)
  const deltaTime = deltaMs / FRAME_TIME;

  weatherCtx.clearRect(0, 0, width, height);

  if (type === "rainy") {
    // Draw rain
    for (const p of rainParticles) {
      p.update(deltaTime);
      p.draw(weatherCtx);
    }

    // Draw splashes (they handle world-to-canvas conversion internally)
    for (const s of splashPool) {
      s.update(deltaTime);
      s.draw(weatherCtx);
    }
  } else if (type === "snowy") {
    // Draw snow
    for (const p of snowParticles) {
      p.update(deltaTime);
      p.draw(weatherCtx);
    }

    // Draw melt effects
    for (const m of meltPool) {
      m.update(deltaTime);
      m.draw(weatherCtx);
    }
  }
}


// Update camera offset for weather effects
function updateWeatherCanvas(cameraX: number, cameraY: number): void {
  // Store camera position for world-space calculations
  // Account for the buffer when calculating viewport center
  const halfViewportWidth = (window.innerWidth / 2);
  const halfViewportHeight = (window.innerHeight / 2);

  cameraOffsetX = cameraX - halfViewportWidth - buffer;
  cameraOffsetY = cameraY - halfViewportHeight - buffer;
}

export { weather, updateWeatherCanvas };
