import { weatherCanvas, weatherCtx, canvas } from "./ui.ts";

// Set initial canvas size with buffer and device pixel ratio
const dpr = window.devicePixelRatio || 1;
let width: number = window.innerWidth + 800;  // Logical width
let height: number = window.innerHeight + 800;  // Logical height
weatherCanvas.width = width * dpr;
weatherCanvas.height = height * dpr;
weatherCanvas.style.width = width + "px";
weatherCanvas.style.height = height + "px";
if (weatherCtx) {
  weatherCtx.scale(dpr, dpr);
}

// Handle window resize
window.addEventListener("resize", () => {
  const dpr = window.devicePixelRatio || 1;
  width = window.innerWidth + 800;
  height = window.innerHeight + 800;
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
  x = 0;
  y = 0;
  alpha = 0;
  radius = 0;
  active = false; // reuse flag

  init(x: number, y: number) {
    this.x = x;
    this.y = y;
    this.alpha = 1;
    this.radius = 1 + Math.random() * 2;
    this.active = true;
  }

  update() {
    if (!this.active) return;
    this.alpha -= 0.05;
    this.radius += 0.3;
    if (this.alpha <= 0) this.active = false;
  }

  draw(ctx: CanvasRenderingContext2D) {
    if (!this.active) return;
    ctx.strokeStyle = `rgba(0,200,255,${this.alpha})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
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

  constructor(spawnY?: number) {
    this.reset(spawnY);
  }

  reset(spawnY?: number) {
    this.x = Math.random() * width;
    this.y = spawnY ?? Math.random() * height;
    this.speed = 10 + Math.random() * 10;
    this.length = 2 + Math.random() * 2;
    this.tilt = -0.5 + Math.random();
    this.opacity = 0.6 + Math.random() * 0.4;
    this.trail = [];
  }

  update() {
    this.y += this.speed;
    this.x += this.tilt;

    this.trail.push({ x: this.x, y: this.y, alpha: this.opacity });
    if (this.trail.length > this.length) this.trail.shift();

    // Reuse a splash particle from the pool
    if (this.y >= height) {
      const splash = splashPool.find(s => !s.active);
      if (splash) splash.init(this.x, height);
      this.y = 0;
      this.x = Math.random() * width;
      this.trail = [];
    }
  }

  draw(ctx: CanvasRenderingContext2D) {
    if (this.trail.length < 2) return;

    ctx.strokeStyle = "rgba(0,200,255,0.8)";
    ctx.lineWidth = 1;
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

// Create rain particles
const particles: RainParticle[] = [];
const particleCount = 200;
for (let i = 0; i < particleCount; i++) {
  particles.push(new RainParticle(Math.random() * height));
}

// Pre-create splash particle pool
const splashPoolSize = 100;
const splashPool: SplashParticle[] = [];
for (let i = 0; i < splashPoolSize; i++) {
  splashPool.push(new SplashParticle());
}

// Main animation function
function weather(type: string): void {
  if (!weatherCtx) return;

  // Only render if type is "rainy"
  if (type !== "rainy") return;

  weatherCtx.clearRect(0, 0, width, height);

  // Draw rain
  for (const p of particles) {
    p.update();
    p.draw(weatherCtx);
  }

  // Draw splashes
  for (const s of splashPool) {
    s.update();
    s.draw(weatherCtx);
  }
}


// Adjust canvas position relative to camera
function updateWeatherCanvas(cameraX: number, cameraY: number): void {
  const buffer = 400;

  // Calculate desired weather canvas position (centered around viewport with buffer)
  let weatherLeft = cameraX - buffer;
  let weatherTop = cameraY - buffer;

  // Game canvas is at (0, 0) and represents the entire game world
  // Constrain weather canvas to not go beyond game canvas boundaries

  // Left boundary: weather canvas should not go below 0
  weatherLeft = Math.max(0, weatherLeft);

  // Top boundary: weather canvas should not go below 0
  weatherTop = Math.max(0, weatherTop);

  // Right boundary: weather canvas right edge should not exceed game canvas width
  const maxLeft = canvas.width - weatherCanvas.width;
  if (maxLeft >= 0) {
    weatherLeft = Math.min(weatherLeft, maxLeft);
  } else {
    // If weather canvas is larger than game canvas, center it
    weatherLeft = 0;
  }

  // Bottom boundary: weather canvas bottom edge should not exceed game canvas height
  const maxTop = canvas.height - weatherCanvas.height;
  if (maxTop >= 0) {
    weatherTop = Math.min(weatherTop, maxTop);
  } else {
    // If weather canvas is larger than game canvas, center it
    weatherTop = 0;
  }

  weatherCanvas.style.left = `${weatherLeft}px`;
  weatherCanvas.style.top = `${weatherTop}px`;
}

export { weather, updateWeatherCanvas };
