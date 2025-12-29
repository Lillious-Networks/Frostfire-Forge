import Cache from "./cache.js";
const cache = Cache.getInstance();
import { cachedPlayerId } from "./socket.js";
import { updateFriendOnlineStatus, updateFriendsList } from "./friends.js";
import { initializeAnimationWithWorker } from "./animation.js";
import { getCameraX, getCameraY, setCameraX, setCameraY } from "./renderer.js";
import { createPartyUI, positionText } from "./ui.js";
import { updateXp } from "./xp.js";
import  { typingImage } from "./images.js";
import { getLines } from "./chat.js";

async function createPlayer(data: any) {
  if (data.id === cachedPlayerId) {
    positionText.innerText = `Position: ${data.location.x}, ${data.location.y}`;
  }

  updateFriendOnlineStatus(data.username, true);
  const animationPromise = initializeAnimationWithWorker(data.animation);

  const player = {
    id: data.id,
    username: data.username,
    userid: data.userid,
    animation: null as null | Awaited<ReturnType<typeof initializeAnimationWithWorker>>,
    friends: data.friends || [],
    position: {
      x: data.location.x,
      y: data.location.y,
    },
    chat: "",
    isStealth: data.isStealth,
    isAdmin: data.isAdmin,
    isGuest: data.isGuest || false,
    _adminColorHue: Math.floor(Math.random() * 360),
    targeted: false,
    stats: data.stats,
    typing: false,
    typingTimeout: null as NodeJS.Timeout | null,
    typingImage: typingImage,
    party: data.party || null,
    mounted: data.mounted || false,
    moving: data.location.moving || false,
    damageNumbers: [] as Array<{
      value: number;
      x: number;
      y: number;
      startTime: number;
      isHealing: boolean;
      isCrit: boolean;
    }>,
    castingSpell: null as string | null,
    castingStartTime: 0,
    castingDuration: 0,
    castingInterrupted: false,
    castingInterruptedProgress: undefined as number | undefined,
    showChat: function (context: CanvasRenderingContext2D) {
      // Draw typing indicator first (below in z-order)
      if (this.typing && this.typingImage) {
        // Show typing image at top left, using image's natural dimensions
        // Update opacity to 0.5 if the player is in stealth mode
        if (this.isStealth) {
          context.globalAlpha = 0.8;
        }

        // Add a shadow to the typing image
        context.shadowColor = "black";
        context.shadowBlur = 2;
        context.shadowOffsetX = 0;
        context.shadowOffsetY = 0;
        // Shrink the image in half

        context.drawImage(
          this.typingImage,
          this.position.x - this.typingImage.width / 1.5,
          this.position.y - this.typingImage.height - 25,
          this.typingImage.width / 1.5,
          this.typingImage.height / 1.5
        );

        // Reset opacity
        context.globalAlpha = 1;
        context.shadowColor = "transparent";
        context.shadowBlur = 0;
      }

      // Draw chat bubbles on top
      if (this.chat) {
        if (this.chat.trim() !== "") {
          context.fillStyle = "black";
          context.fillStyle = "white";
          context.textAlign = "center";
          context.shadowBlur = 1;
          context.shadowColor = "black";
          context.shadowOffsetX = 1;
          context.shadowOffsetY = 1;
          context.font = "14px 'Comic Relief'";
          const lines = getLines(context, this.chat, 500).reverse();
          let startingPosition = this.position.y - 20;

          for (let i = 0; i < lines.length; i++) {
            startingPosition -= 20;
            const textWidth = context.measureText(lines[i]).width;
            context.fillStyle = "rgba(0, 0, 0, 0.2)";
            context.fillRect(
              this.position.x - textWidth/2 - 5,
              startingPosition - 17,
              textWidth + 10,
              20
            );
            context.fillStyle = "white";
            context.fillText(lines[i], this.position.x, startingPosition);
          }
        }
      }

      // Reset shadow settings
      context.shadowColor = "transparent";
      context.shadowBlur = 0;
      context.shadowOffsetX = 0;
      context.shadowOffsetY = 0;
    },
    showDamageNumbers: function (context: CanvasRenderingContext2D) {
      const now = performance.now();
      const duration = 1000; // 1 second as requested

      // Filter out expired damage numbers
      this.damageNumbers = this.damageNumbers.filter(
        (dmg) => now - dmg.startTime < duration
      );

      // Render each damage number
      for (const dmg of this.damageNumbers) {
        const elapsed = now - dmg.startTime;
        const progress = elapsed / duration;

        // Calculate position (float up)
        const yOffset = progress * 40; // Float up 40 pixels over 1 second
        const displayY = dmg.y - yOffset;

        // Calculate opacity (fade out)
        const opacity = 1 - progress;

        // Set text style - bigger for crits
        if (dmg.isCrit && !dmg.isHealing) {
          context.font = "bold 28px 'Comic Relief'";
        } else {
          context.font = "bold 20px 'Comic Relief'";
        }
        context.textAlign = "center";

        // Set color based on damage or healing
        if (dmg.isHealing) {
          context.fillStyle = `rgba(0, 255, 0, ${opacity})`;
          context.strokeStyle = `rgba(0, 100, 0, ${opacity})`;
        } else if (dmg.isCrit) {
          // Bright yellow/orange for crits
          context.fillStyle = `rgba(255, 215, 0, ${opacity})`;
          context.strokeStyle = `rgba(255, 140, 0, ${opacity})`;
        } else {
          context.fillStyle = `rgba(255, 0, 0, ${opacity})`;
          context.strokeStyle = `rgba(139, 0, 0, ${opacity})`;
        }

        // Draw text with outline - add ! for crits
        const displayText = dmg.isCrit && !dmg.isHealing
          ? `${dmg.value}!`
          : `${dmg.value}`;

        context.lineWidth = 3;
        context.strokeText(
          displayText,
          dmg.x,
          displayY
        );
        context.fillText(
          displayText,
          dmg.x,
          displayY
        );
      }

      // Reset context
      context.fillStyle = "white";
      context.strokeStyle = "black";
      context.lineWidth = 1;
    },
    showCastbar: function (context: CanvasRenderingContext2D) {
      if (!this.castingSpell) return;

      const now = performance.now();
      const elapsed = now - this.castingStartTime;

      // If interrupted/failed, freeze progress at the point of interruption
      let progress;
      if (this.castingInterrupted) {
        if (this.castingSpell === "Failed") {
          // Failed always shows at 100%
          progress = 1.0;
        } else {
          // Interrupted shows at current progress with minimum 15% visibility
          progress = Math.max(this.castingInterruptedProgress || 0, 0.15);
        }
      } else {
        progress = Math.min(elapsed / this.castingDuration, 1);
      }

      // Castbar dimensions - larger and more professional
      const barWidth = 120;
      const barHeight = 12;
      const barX = this.position.x - barWidth / 2;
      const barY = this.position.y - 45; // Above the player

      // Outer shadow for depth
      context.shadowColor = "rgba(0, 0, 0, 0.7)";
      context.shadowBlur = 8;
      context.shadowOffsetY = 3;

      // Background with border
      context.fillStyle = "rgba(15, 15, 25, 0.95)";
      context.fillRect(barX, barY, barWidth, barHeight);

      // Reset shadow for border
      context.shadowColor = "transparent";
      context.shadowBlur = 0;
      context.shadowOffsetY = 0;

      // Inner background (darker inset)
      context.fillStyle = "rgba(10, 10, 15, 0.8)";
      context.fillRect(barX + 1, barY + 1, barWidth - 2, barHeight - 2);

      // Progress bar with gradients
      if (this.castingInterrupted) {
        if (this.castingSpell === "Failed") {
          // Red gradient for failed
          const gradient = context.createLinearGradient(barX, barY, barX, barY + barHeight);
          gradient.addColorStop(0, "#ef4444");
          gradient.addColorStop(0.5, "#dc2626");
          gradient.addColorStop(1, "#b91c1c");
          context.fillStyle = gradient;

          // Failed glow
          context.shadowColor = "rgba(239, 68, 68, 0.8)";
          context.shadowBlur = 10;
        } else {
          // Grey gradient for interrupted
          const gradient = context.createLinearGradient(barX, barY, barX, barY + barHeight);
          gradient.addColorStop(0, "#9ca3af");
          gradient.addColorStop(0.5, "#6b7280");
          gradient.addColorStop(1, "#4b5563");
          context.fillStyle = gradient;

          // Subtle interrupted glow
          context.shadowColor = "rgba(107, 114, 128, 0.5)";
          context.shadowBlur = 6;
        }
      } else {
        // Purple gradient for casting
        const gradient = context.createLinearGradient(barX, barY, barX, barY + barHeight);
        gradient.addColorStop(0, "#a78bfa");
        gradient.addColorStop(0.5, "#8b5cf6");
        gradient.addColorStop(1, "#7c3aed");
        context.fillStyle = gradient;

        // Casting glow
        context.shadowColor = "rgba(139, 92, 246, 0.7)";
        context.shadowBlur = 12;
      }

      context.fillRect(barX + 2, barY + 2, (barWidth - 4) * progress, barHeight - 4);

      // Reset shadow
      context.shadowColor = "transparent";
      context.shadowBlur = 0;

      // Highlight overlay (top shine)
      const highlightGradient = context.createLinearGradient(barX, barY, barX, barY + barHeight / 2);
      highlightGradient.addColorStop(0, "rgba(255, 255, 255, 0.25)");
      highlightGradient.addColorStop(1, "rgba(255, 255, 255, 0)");
      context.fillStyle = highlightGradient;
      context.fillRect(barX + 2, barY + 2, (barWidth - 4) * progress, (barHeight - 4) / 2);

      // Border
      context.strokeStyle = "rgba(255, 255, 255, 0.15)";
      context.lineWidth = 1.5;
      context.strokeRect(barX + 0.5, barY + 0.5, barWidth - 1, barHeight - 1);

      // Spell name
      context.font = "bold 11px 'Comic Relief'";
      context.fillStyle = "white";
      context.textAlign = "center";
      context.shadowColor = "rgba(0, 0, 0, 0.9)";
      context.shadowBlur = 4;
      context.shadowOffsetY = 1;
      const spellText = this.castingInterrupted ? this.castingSpell : this.castingSpell;
      context.fillText(spellText, this.position.x, barY - 5);

      // Reset all shadow settings
      context.shadowColor = "transparent";
      context.shadowBlur = 0;
      context.shadowOffsetY = 0;

      // Auto-remove after cast completes or interrupt finishes
      if (this.castingInterrupted && elapsed >= 1500) {
        this.castingSpell = null;
        this.castingInterrupted = false;
        this.castingInterruptedProgress = undefined;
      } else if (!this.castingInterrupted && progress >= 1) {
        this.castingSpell = null;
      }
    },
    renderAnimation: function (context: CanvasRenderingContext2D) {
      if (!this.animation?.frames?.length) {
        return;
      }

      const now = performance.now();
      const frame = this.animation.frames[this.animation.currentFrame];

      if (now - this.animation.lastFrameTime > frame.delay) {
        this.animation.currentFrame = (this.animation.currentFrame + 1) % this.animation.frames.length;
        this.animation.lastFrameTime = now;
      }

      if (frame.imageElement?.complete) {
        // Only change alpha if needed
        if (this.isStealth) {
          context.globalAlpha = 0.5;
          context.drawImage(
            frame.imageElement,
            Math.round(this.position.x - frame.width/2),
            Math.round(this.position.y - frame.height/2),
            frame.width,
            frame.height
          );
          context.globalAlpha = 1;
        } else {
          context.drawImage(
            frame.imageElement,
            Math.round(this.position.x - frame.width/2),
            Math.round(this.position.y - frame.height/2),
            frame.width,
            frame.height
          );
        }
      }
    },
    show: function (context: CanvasRenderingContext2D, currentPlayer?: any) {
      // UI offset for all players
      const uiOffset = 10;

      let shadow: { width: number; height: number; fillStyle: string; borderColor: string } = { width: 0, height: 0, fillStyle: "black", borderColor: "black" };
      if (this.targeted) {
        shadow = {
          width: 18,
          height: 7,
          fillStyle: "rgba(255, 0, 0, 0.35)",
          borderColor: "rgba(255, 0, 0, 0.8)"
        };
      } else {
        shadow = {
          width: 15,
          height: 5,
          fillStyle: "rgba(0, 0, 0, 0.35)",
          borderColor: "transparent"
        };
      }

      // Outer ring (darker)
      context.save();
      context.beginPath();
      context.ellipse(
        this.position.x,
        this.position.y + 16,
        shadow.width,
        shadow.height,
        0,
        0,
        Math.PI * 2
      );
      context.strokeStyle = shadow.borderColor;
      context.lineWidth = 1;
      context.stroke();

      // Inner fill (lighter)
      context.beginPath();
      context.ellipse(
        this.position.x,
        this.position.y + 16,
        shadow.width,
        shadow.height,
        0,
        0,
        Math.PI * 2
      );
      context.fillStyle = shadow.fillStyle;
      context.fill();
      context.closePath();
      context.restore();

      context.globalAlpha = 1;
      context.font = "14px 'Comic Relief'";
      
      // Opacity for stealth mode
      if (this.isStealth) {
        context.fillStyle = "rgba(97, 168, 255, 1)";
      } else {
        context.fillStyle = "white";
      }

      // Draw the player's username
      context.textAlign = "center";

      if (!currentPlayer) return;
      
      // Determine color for player name
      let nameColor: string | undefined;

      const isCurrent = data.id === currentPlayer?.id;
      const isVisible = !this.isStealth;

      // Admin color animation (only when visible)
      if (this.isAdmin && isVisible) {
        // this._adminColorHue = (this._adminColorHue + 2) % 360;
        // nameColor = `hsl(${this._adminColorHue}, 100%, 50%)`;
        nameColor = "#ff2252ff";
      }

      if (isCurrent && isVisible && !this.isAdmin) {
        nameColor = "#ffe561";
      } else if (this.isStealth) {
        nameColor = "rgba(97, 168, 255, 1)";
      } else if (!nameColor) {
        if (currentPlayer.party?.includes(this.username)) {
          nameColor = "#00ff88ff";
        } else if (currentPlayer.friends.includes(this.username)) {
          nameColor = "#00b7ffff";
        } else {
          nameColor = "#FFFFFF";
        }
      }

      context.fillStyle = nameColor;


      context.shadowColor = "black";
      context.shadowBlur = 2;
      context.shadowOffsetX = 0;
      context.strokeStyle = "black";

      const isGuest = this?.isGuest;
      if (isGuest) {
        data.username = "Guest";
      } else {
        const u = data?.username;
        if (!u) {
          // Clear cookies and session storage, then reload the page because we have no username due to an error
          // Clear all cookies
          document.cookie.split(";").forEach(function(c) {
            document.cookie = c.trim().split("=")[0] + "=;expires=Thu, 01 Jan 1970 00:00:00 GMT";
          });
          // Clear session storage
          sessionStorage.clear();

          window.location.href = "/";
        } else {
          data.username = data.username.charAt(0).toUpperCase() + data.username.slice(1);
        }
      }

      context.strokeText(
        data.username,
        this.position.x,
        this.position.y + 40 + uiOffset
      );
      context.fillText(
        data.username,
        this.position.x,
        this.position.y + 40 + uiOffset
      );

      // Draw the player's health bar below the player's name with a width of 100px, centered below the player name
      if (!this.isStealth) {
        if (data.id === cachedPlayerId || this.targeted) {
          context.fillStyle = "rgba(0, 0, 0, 0.8)";
          context.fillRect(this.position.x - 50, this.position.y + 46 + uiOffset, 100, 3);

          // Update the shadowblur to 2
          context.shadowBlur = 2;

          // Set health bar color based on health percentage
          const healthPercent = this.stats.health / this.stats.max_health;
          if (healthPercent < 0.3) {
            context.fillStyle = "#C81D1D"; // red
          } else if (healthPercent < 0.5) {
            context.fillStyle = "#C87C1D"; // orange
          } else if (healthPercent < 0.8) {
            context.fillStyle = "#C8C520"; // yellow
          } else {
            context.fillStyle = "#519D41"; // green
          }

          context.fillRect(
            this.position.x - 50,
            this.position.y + 46 + uiOffset,
            healthPercent * 100,
            3
          );
        }

        // Draw the player's stamina bar below the player's health bar with a width of 75px, centered below the player's health bar
        // Check if current player is the same as the player we are drawing
        if (data.id === cachedPlayerId || this.targeted) {
        context.fillStyle = "rgba(0, 0, 0, 0.8)";
        context.fillRect(this.position.x - 50, this.position.y + 51 + uiOffset, 100, 3);
        context.fillStyle = "#469CD9";
        context.fillRect(
          this.position.x - 50,
            this.position.y + 51 + uiOffset,
            (this.stats.stamina / this.stats.max_stamina) * 100,
            3
          );
        }

        if (data.id === cachedPlayerId || this.targeted) {
          // Draw the player's level on the left side of the health bar
          context.textAlign = "left";
          context.font = "12px 'Comic Relief'";
          context.fillStyle = "white";
          // Text shadow for better visibility
          context.shadowColor = "black";
          context.shadowBlur = 2;
          context.fillText(`${this.stats.level}`, this.position.x - 66, this.position.y + 56 + uiOffset);
        }
      }

      // Reset shadow settings
      context.shadowColor = "transparent";
      context.shadowBlur = 0;

      this.renderAnimation(context);
    },
  };

  cache.players.add(player);

  player.animation = await animationPromise;

  if (data.id === cachedPlayerId) {
    setCameraX(player.position.x - window.innerWidth / 2 + 8);
    setCameraY(player.position.y - window.innerHeight / 2 + 48);
    window.scrollTo(getCameraX(), getCameraY());
    updateFriendsList({friends: data.friends || []});
    createPartyUI(data.party || []);
    updateXp(data.stats.xp, data.stats.level, data.stats.max_xp);
  }
}


export { createPlayer };