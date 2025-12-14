import Cache from "./cache.js";
const cache = Cache.getInstance();
import { cachedPlayerId } from "./socket.js";
import { updateFriendOnlineStatus, updateFriendsList } from "./friends.js";
import { initializeAnimationWithWorker } from "./animation.js";
import { canvas, getCameraX, getCameraY, setCameraX, setCameraY } from "./renderer.js";
import { createPartyUI, positionText } from "./ui.js";
import { updateXp } from "./xp.js";
import  { typingImage } from "./images.js";
import { getLines } from "./chat.js";

async function createPlayer(data: any) {
  console.log("Creating player:", data);
  if (data.id === cachedPlayerId) {
    positionText.innerText = `Position: ${data.location.x}, ${data.location.y}`;
  }

  updateFriendOnlineStatus(data.username, true);

  console.log(`
    Username: ${data.username}
    UserID: ${data.userid}
    WebSocket ID: ${data.id}
    Animation: ${data.animation ? "Loaded" : "None"}
    Friends: ${data.friends ? data.friends.join(", ") : "None"}
    Position: (${data.location.x}, ${data.location.y})
    Stealth: ${data.isStealth ? "Yes" : "No"}
    Admin: ${data.isAdmin ? "Yes" : "No"}
    Guest: ${data.isGuest ? "Yes" : "No"}
    Party: ${data.party ? data.party.join(", ") : "None"}
    Stats: ${JSON.stringify(data.stats, null, 2)}
  `);

  const animationPromise = initializeAnimationWithWorker(data.animation);

  const player = {
    id: data.id,
    username: data.username,
    userid: data.userid,
    animation: null as null | Awaited<ReturnType<typeof initializeAnimationWithWorker>>,
    friends: data.friends || [],
    position: {
      x: canvas.width / 2 + data.location.x,
      y: canvas.height / 2 + data.location.y,
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
    showChat: function (context: CanvasRenderingContext2D) {
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
          let startingPosition = this.position.y;

          for (let i = 0; i < lines.length; i++) {
            startingPosition -= 20;
            const textWidth = context.measureText(lines[i]).width;
            context.fillStyle = "rgba(0, 0, 0, 0.2)";
            context.fillRect(
              this.position.x + 16 - textWidth/2 - 5,
              startingPosition - 17,
              textWidth + 10,
              20
            );
            context.fillStyle = "white";
            context.fillText(lines[i], this.position.x + 16, startingPosition);
          }
        }
      }

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
          this.position.x - this.typingImage.width + 15, 
          this.position.y - this.typingImage.height + 15,
          this.typingImage.width / 1.5,
          this.typingImage.height / 1.5
        );
        
        // Reset opacity
        context.globalAlpha = 1;
        context.shadowColor = "transparent";
        context.shadowBlur = 0;
      }

      // Reset shadow settings
      context.shadowColor = "transparent";
      context.shadowBlur = 0;
      context.shadowOffsetX = 0;
      context.shadowOffsetY = 0;
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
            this.position.x + 16 - frame.width/2,
            this.position.y + 24 - frame.height/2,
            frame.width,
            frame.height
          );
          context.globalAlpha = 1;
        } else {
          context.drawImage(
            frame.imageElement,
            this.position.x + 16 - frame.width/2,
            this.position.y + 24 - frame.height/2,
            frame.width,
            frame.height
          );
        }
      }
    },
    show: function (context: CanvasRenderingContext2D, currentPlayer?: any) {
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
        this.position.x + 16,
        this.position.y + 40,
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
        this.position.x + 16,
        this.position.y + 40,
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
          console.error("No username found, logging out for safety.");
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
        this.position.x + 16,
        this.position.y + 65
      );
      context.fillText(
        data.username,
        this.position.x + 16,
        this.position.y + 65
      );

      // Draw the player's health bar below the player's name with a width of 100px, centered below the player name
      if (!this.isStealth) {
        if (data.id === cachedPlayerId || this.targeted) {
          context.fillStyle = "rgba(0, 0, 0, 0.8)";
          context.fillRect(this.position.x - 34, this.position.y + 71, 100, 3);

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
            this.position.x - 34,
            this.position.y + 71,
            healthPercent * 100,
            3
          );
        }

        // Draw the player's stamina bar below the player's health bar with a width of 75px, centered below the player's health bar
        // Check if current player is the same as the player we are drawing
        if (data.id === cachedPlayerId || this.targeted) {
        context.fillStyle = "rgba(0, 0, 0, 0.8)";
        context.fillRect(this.position.x - 34, this.position.y + 76, 100, 3);
        context.fillStyle = "#469CD9";
        context.fillRect(
          this.position.x - 34,
            this.position.y + 76,
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
          context.fillText(`${this.stats.level}`, this.position.x - 50, this.position.y + 81);
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