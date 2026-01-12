/**
 * Animation State Manager
 * Coordinates animation state changes across all players
 * Handles equipment changes and armor layer updates
 */

import {
  updateLayeredAnimation,
  changeLayeredAnimation,
  updateArmorLayer
} from './layeredAnimation.js';
import { loadSpriteSheetTemplate } from './spritesheetParser.js';

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

  /**
   * Changes animation state for a specific player
   * @param player - Player object to update
   * @param animationState - New animation state to transition to
   */
  async changePlayerAnimation(
    player: any,
    animationState: 'idle' | 'walk' | 'run' | 'attack' | 'cast' | 'death' | 'jump'
  ): Promise<void> {
    if (!player.layeredAnimation) {
      console.warn('Player has no layered animation system');
      return;
    }

    try {
      await changeLayeredAnimation(player.layeredAnimation, animationState);
    } catch (error) {
      console.error(`Failed to change animation to "${animationState}":`, error);
    }
  }

  /**
   * Updates player armor layers based on equipped items
   * @param player - Player object to update
   * @param equipment - Player's equipment data
   */
  async updatePlayerArmor(
    player: any,
    equipment: Equipment
  ): Promise<void> {
    if (!player.layeredAnimation) {
      console.warn('Player has no layered animation system');
      return;
    }

    try {
      // Update body armor layer (chest, legs, etc.)
      const bodyArmorSprite = this.getBodyArmorSprite(equipment);
      await updateArmorLayer(
        player.layeredAnimation,
        'body_armor',
        bodyArmorSprite
      );

      // Update head armor layer (helmet)
      const headArmorSprite = this.getHeadArmorSprite(equipment);
      await updateArmorLayer(
        player.layeredAnimation,
        'head_armor',
        headArmorSprite
      );
    } catch (error) {
      console.error('Failed to update player armor:', error);
    }
  }

  /**
   * Determines which body armor sprite sheet to use
   * Prioritizes chest armor, but can combine with legs/hands/feet
   * @param equipment - Player's equipment
   * @returns Body armor sprite sheet template or null
   */
  private getBodyArmorSprite(equipment: Equipment): Nullable<SpriteSheetTemplate> {
    // Priority: chest > legs > other body pieces
    // In a full implementation, you might combine multiple pieces

    if (equipment.chest_sprite) {
      try {
        return loadSpriteSheetTemplate(equipment.chest_sprite);
      } catch (error) {
        console.error('Failed to load chest armor sprite:', error);
      }
    }

    if (equipment.legs_sprite) {
      try {
        return loadSpriteSheetTemplate(equipment.legs_sprite);
      } catch (error) {
        console.error('Failed to load legs armor sprite:', error);
      }
    }

    return null;
  }

  /**
   * Determines which head armor sprite sheet to use
   * @param equipment - Player's equipment
   * @returns Head armor sprite sheet template or null
   */
  private getHeadArmorSprite(equipment: Equipment): Nullable<SpriteSheetTemplate> {
    if (equipment.head_sprite) {
      try {
        return loadSpriteSheetTemplate(equipment.head_sprite);
      } catch (error) {
        console.error('Failed to load head armor sprite:', error);
      }
    }

    return null;
  }

  /**
   * Handles movement state changes
   * @param player - Player object
   * @param isMoving - Whether player is currently moving
   * @param isRunning - Whether player is running (vs walking)
   */
  async handleMovementStateChange(
    player: any,
    isMoving: boolean,
    isRunning: boolean = false
  ): Promise<void> {
    if (isMoving) {
      const animationState = isRunning ? 'run' : 'walk';
      await this.changePlayerAnimation(player, animationState);
    } else {
      await this.changePlayerAnimation(player, 'idle');
    }
  }

  /**
   * Handles combat state changes
   * @param player - Player object
   * @param combatAction - Type of combat action
   */
  async handleCombatAction(
    player: any,
    combatAction: 'attack' | 'cast'
  ): Promise<void> {
    await this.changePlayerAnimation(player, combatAction);

    // Optionally return to idle or previous state after animation completes
    // This would require tracking animation completion events
  }

  /**
   * Handles death state
   * @param player - Player object
   */
  async handleDeath(player: any): Promise<void> {
    await this.changePlayerAnimation(player, 'death');
  }

  /**
   * Syncs animation state based on player movement data
   * @param player - Player object
   */
  async syncAnimationWithMovement(player: any): Promise<void> {
    if (!player.layeredAnimation) return;

    const currentAnimation = player.layeredAnimation.currentAnimationName;

    // Determine what animation should be playing based on player state
    let targetAnimation: string;

    if (player.castingSpell) {
      targetAnimation = 'cast';
    } else if (player.moving) {
      targetAnimation = 'walk';
    } else {
      targetAnimation = 'idle';
    }

    // Only change if different from current
    if (currentAnimation !== targetAnimation) {
      await this.changePlayerAnimation(player, targetAnimation as any);
    }
  }
}

/**
 * Singleton instance of the animation state manager
 */
export const animationManager = new AnimationStateManager();
