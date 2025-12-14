import { getLines } from "./chat.js";
import { npcImage } from "./images.js";
import Cache from "./cache.js";
const cache = Cache.getInstance();
import { getIsLoaded } from "./socket.js";

function createNPC(data: any) {
  const npc: {
    id: string;
    position: { x: number; y: number };
    dialog: string;
    particles?: Particle[];
    hidden?: boolean;
    quest: number | null;
    show: (context: CanvasRenderingContext2D) => void;
    updateParticle: (particle: Particle, npc: any, context: CanvasRenderingContext2D, deltaTime: number) => void;
    dialogue: (context: CanvasRenderingContext2D) => void;
  } = {
    id: data.id,
    dialog: data.dialog || "",
    position: {
      x: data.location.x,
      y: data.location.y,
    },
    particles: data.particles || [],
    quest: data.quest || null,
    dialogue: function (this: typeof npc, context: CanvasRenderingContext2D) {
      if (this.dialog) {
        if (this.dialog.trim() !== "") {
          context.fillStyle = "black";
          context.fillStyle = "white";
          context.font = "14px 'Comic Relief'";
          context.textAlign = "center";
          
          const lines = getLines(context, this.dialog, 500).reverse();
          let startingPosition = this.position.y;

          for (let i = 0; i < lines.length; i++) {
            startingPosition -= 15;
            context.fillText(lines[i], this.position.x + 16, startingPosition);
          }
        }
      }
    },
    show: function (this: typeof npc, context: CanvasRenderingContext2D) {
      if (!npcImage || !context) return;

      context.globalAlpha = 1;

      if (!data?.hidden) {
        context.drawImage(npcImage, this.position.x, this.position.y, npcImage.width, npcImage.height);
      }
    },
    updateParticle: async (particle: Particle, npc: any, context: CanvasRenderingContext2D, deltaTime: number) => {
      // Initialize particle arrays and timing for each type if they don't exist
      if (!npc.particleArrays) {
        npc.particleArrays = {};
        npc.lastEmitTime = {};
      }
      
      const currentTime = performance.now();
      const emitInterval = (particle.interval || 1) * 16.67; // Convert to milliseconds (60fps = 16.67ms)
      
      // Initialize or get the last emit time for this particle type
      if (!npc.lastEmitTime[particle.name || '']) {
        npc.lastEmitTime[particle.name || ''] = currentTime;
      }
      
      // Initialize particle array if it doesn't exist
      if (!npc.particleArrays[particle.name || '']) {
        npc.particleArrays[particle.name || ''] = [];
      }

      // Check if it's time to emit a new particle
      if (currentTime - npc.lastEmitTime[particle.name || ''] >= emitInterval) {
        const randomLifetimeExtension = Math.random() * (particle.staggertime || 0);
        const baseLifetime = particle.lifetime || 1000;
        const windDirection = typeof particle.weather === 'object' ? particle.weather.wind_direction : null;
        const windSpeed = typeof particle.weather === 'object' ? particle.weather.wind_speed || 0 : 0;

        // Default wind bias to 0
        const windBias = {
          x: 0,
          y: 0
        }

        if (windDirection !== null && (windDirection === 'left' || windDirection === 'right')) {
          // Apply wind direction bias to initial position
          const windDirectionRad = (windDirection === 'left' ? 180 : 
                                  windDirection === 'right' ? 0 : 180) * Math.PI / 180;
          windBias.x = Math.cos(windDirectionRad) * windSpeed * 0.5;
          windBias.y = Math.sin(windDirectionRad) * windSpeed * 0.5;
        }

        const newParticle: Particle = {
          ...particle,
          localposition: { 
            x: Number(particle.localposition?.x || 0) + (Math.random() < 0.5 ? -1 : 1) * Math.random() * Number(particle.spread.x),
            y: Number(particle.localposition?.y || 0) + (Math.random() < 0.5 ? -1 : 1) * Math.random() * Number(particle.spread.y)
          },
          velocity: { 
            x: Number(particle.velocity.x || 0) + windBias.x,
            y: Number(particle.velocity.y || 0) + windBias.y
          },
          lifetime: baseLifetime + randomLifetimeExtension,
          currentLife: baseLifetime + randomLifetimeExtension,
          opacity: particle.opacity || 1,
          visible: true,
          size: particle.size || 5,
          color: particle.color || 'white',
          gravity: { ...particle.gravity },
          weather: typeof particle.weather === 'object' ? { ...particle.weather } : 'none'
        };

        // Remove oldest particle if we exceed the maximum amount
        if (npc.particleArrays[particle.name || ''].length >= particle.amount) {
          npc.particleArrays[particle.name || ''].shift();
        }
        
        npc.particleArrays[particle.name || ''].push(newParticle);
        npc.lastEmitTime[particle.name || ''] = currentTime;
      }

      // Update and render existing particles for this type
      const particles = npc.particleArrays[particle.name || ''];
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        
        // Decrease lifetime
        p.currentLife -= deltaTime * 1000;

        // Remove dead particles
        if (p.currentLife <= 0) {
          particles.splice(i, 1);
          continue;
        }

        if (!p.localposition) {
          p.localposition = { x: 0, y: 0 };
        }

        // Apply gravity and wind effects
        if (p.velocity && p.gravity) {
          const windDirection = typeof p.weather === 'object' ? p.weather.wind_direction : null;
          const windSpeed = typeof p.weather === 'object' ? p.weather.wind_speed || 0 : 0;
          const windForce = {
            x: 0,
            y: 0
          };

          if (windDirection !== 'none' && (windDirection === 'left' || windDirection === 'right')) {
            const windDirectionRad = (windDirection === 'left' ? 180 : 0) * Math.PI / 180;
            windForce.x = Math.cos(windDirectionRad) * windSpeed * 0.01;
            windForce.y = Math.sin(windDirectionRad) * windSpeed * 0.01;
          }

          // Update velocity with gravity and wind
          p.velocity.x += p.gravity.x * deltaTime + windForce.x;
          p.velocity.y += p.gravity.y * deltaTime + windForce.y;
          
          // Cap velocity considering wind influence
          const maxVelocity = {
            x: particle.velocity.x + (windSpeed * 0.2),
            y: particle.velocity.y + (windSpeed * 0.2)
          };
          
          p.velocity.x = Math.min(Math.max(p.velocity.x, -maxVelocity.x), maxVelocity.x);
          p.velocity.y = Math.min(Math.max(p.velocity.y, -maxVelocity.y), maxVelocity.y);
          
          // Update position
          p.localposition.x += p.velocity.x * deltaTime;
          p.localposition.y += p.velocity.y * deltaTime;
        }

        // Calculate render position
        const centerX = npc.position.x + 16 - (p.size / 2);
        const centerY = npc.position.y + 24 - (p.size / 2);
        const renderX = centerX + p.localposition.x;
        const renderY = centerY + p.localposition.y;

        // Calculate fade in/out alpha
        const fadeInDuration = p.lifetime * 0.4;
        const fadeOutDuration = p.lifetime * 0.4;
        let alpha;

        if (p.lifetime - p.currentLife < fadeInDuration) {
          // Fade in
          alpha = ((p.lifetime - p.currentLife) / fadeInDuration) * p.opacity;
        } else if (p.currentLife < fadeOutDuration) {
          // Fade out
          alpha = (p.currentLife / fadeOutDuration) * p.opacity;
        } else {
          // Fully visible
          alpha = p.opacity;
        }
        
        context.globalAlpha = alpha;

        // Draw particle as a circle
        context.beginPath();
        context.arc(renderX + p.size/2, renderY + p.size/2, p.size/2, 0, Math.PI * 2);
        context.fillStyle = p.color || "white";
        context.fill();
      }

      // Reset global alpha for other rendering
      context.globalAlpha = 1;
    }
  };

  cache.npcs.push(npc);
  
  // Execute the npc script in a sandboxed environment where "this" refers to the npc object
  (async function () {
    try {
      getIsLoaded();
      new Function(
        "with(this) { " + decodeURIComponent(data.script) + " }"
      ).call(npc);
    } catch (e) {
      console.error(`NPC script error (ID: ${npc.id}):`, e);
    }
  }).call(npc);
}

export { createNPC };