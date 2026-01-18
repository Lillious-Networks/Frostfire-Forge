/**
 * Animation State Manager
 * Updates animation frame progression for all players each render frame
 * Animation state changes (idle/walk/etc) are handled via server packets in socket.ts
 */

import { updateLayeredAnimation } from './layeredAnimation.js';

export class AnimationStateManager {
  /**
   * Updates all player animations in the game
   * Should be called every frame
   * @param players - Map of all active players
   * @param deltaTime - Time elapsed since last frame
   */
  updateAllPlayers(players: Map<string, any>, deltaTime: number): void {
    players.forEach(player => {
      if (player.layeredAnimation) {
        updateLayeredAnimation(player.layeredAnimation, deltaTime);
      }
    });
  }

}

/**
 * Singleton instance of the animation state manager
 */
export const animationManager = new AnimationStateManager();
