import { ghosts } from "../../cluster/ghosts";
import { readHeldList } from "../../systems/npcStreaming";
import cooldownManager from "../../services/cooldownmanager";
import creatures from "../../systems/creatures";
import layerManager from "../../services/layermanager";
import log from "../../modules/logger";
import player, { hasLineOfSight } from "../../systems/player.ts";
import playerCache from "../../services/playermanager.ts";
import spellEffects, { spellHasHostileEffects, cancelEffect } from "../../systems/spelleffects";
import spells from "../../systems/spells";
import { Events, setPlayerPvp } from "../../systems/events";
import { areaCastRefusal, areaSpellHarms, PVP_BODY, type PvpAllowed } from "../../systems/pvpzone";
import { entityById } from "../../cluster/mirrors";
import { getIconUrl } from "../../modules/spriteSheetManager";
import { listener } from "../../modules/event_bus";
import { packetManager } from "../packet_manager";
import { rollHeal, spellManaCost } from "../../systems/spellmath";
import { spawnZone } from "../../systems/groundaoe";
import { forgetLook } from "../looks";
import { updatePlayerAOI, shouldUpdateAOI, broadcastToAOI, broadcastToAOIBestEffort, broadcastStatsUpdateToAOI, broadcastCastToAOI, broadcastGroundPreviewToAOI, clearGroundPreviewForAOI, findPlayersWithTargetInAOI } from "../aoi";
import { bumpStateRevision, castSpellOnCreature, despawnBatchQueue, directionToward, faceToward, filterPlayersByMap, handlePlayerDeath, hitRemotePlayer, playersAndMirrorsNear, remoteHit, resolveSpellParticles, resumeWalkingFacing, routeSplashToMirror, sendPacket, sendPositionAnimation, sendStatsToPartyMembers, spawnBatchQueue, splashCreatures, stateRevision, subscriptionLocked, withMirrors } from "../receiver";
import type { PacketContext } from "./context";

// Packet handlers moved from receiver.ts's packetReceiver switch (phase 6, Task 1). The case bodies are unchanged.

export const handles: ReadonlySet<string> = new Set(["CREATURE_ATTACK", "HOTBAR", "CANCEL_SPELL", "CANCEL_EFFECT"]);

export async function handle(ctx: PacketContext): Promise<unknown> {
  const { currentPlayer, data, type, wt } = ctx;
  switch (type) {

      case "CREATURE_ATTACK": {
        if (!currentPlayer) return;
        const creatureId = (data as any)?.id;
        if (creatureId === null || creatureId === undefined) {
          creatures.stopAutoAttack(currentPlayer);
          break;
        }
        if (currentPlayer.isDead || currentPlayer.isGhost || currentPlayer.isGuest) return;
        if (subscriptionLocked(wt, currentPlayer, "combat")) {
          creatures.stopAutoAttack(currentPlayer);
          return;
        }
        const creature = creatures.getCreature(Number(creatureId));
        if (!creature || !creatures.isTargetableBy(currentPlayer, creature)) {
          sendPacket(wt, packetManager.creatureAttackStopped(Number(creatureId)));
          break;
        }
        if (creatures.startAutoAttack(currentPlayer, creature.id)) {
          sendPacket(wt, packetManager.creatureAttackStopped(creature.id));
        }
        break;
      }

      case "HOTBAR": {
        if (!currentPlayer) return;
        // Corpses and ghosts cannot cast.
        if (currentPlayer.isDead || currentPlayer.isGhost) return;
        // GM stealth is non-interactive: an invisible admin casting would hit
        // things (AoE, ground zones, projectiles) while nothing can see or fight
        // back, and the visuals would give the admin away anyway.
        if (currentPlayer.isStealth) return;
        if (currentPlayer.isGuest) {
          sendPacket(
            wt,
            packetManager.notify({
              message: "Please create an account to use that feature.",
            })
          );
          return;
        }
        if (subscriptionLocked(wt, currentPlayer, "combat")) return;


        const casting = playerCache.get(currentPlayer.id)?.casting;
        if (casting) {
          return;
        }

        const freshPlayerForDelay = playerCache.get(currentPlayer.id);
        const lastCastTime = freshPlayerForDelay?.lastCastTime || 0;
        const timeSinceLastCast = performance.now() - lastCastTime;
        const globalCastDelay = 500;
        if (timeSinceLastCast < globalCastDelay) {
          return;
        }

        // Spell lockout (e.g. from an interrupt): all casting is blocked until it expires
        const spellLockoutUntil = freshPlayerForDelay?.spellLockoutUntil || 0;
        if (spellLockoutUntil > performance.now()) {
          return;
        }

        // Stunned players cannot cast. stunnedUntil is an epoch timestamp
        // (Date.now()-based), so it must be compared against Date.now().
        if (freshPlayerForDelay?.stunnedUntil && freshPlayerForDelay.stunnedUntil > Date.now()) {
          return;
        }

        const spell_identifier = (data as any).spell;
        let targetId = (data as any).target?.id;
        log.debug(`[ATTACK] Spell cast request - spell=${spell_identifier}, targetId=${targetId}`);

        const spell = await spells.find(spell_identifier);
        const spell_id = spell?.id;
        if (!spell || !spell_id) {
          sendPacket(
            wt,
            packetManager.notify({ message: "Invalid spell selected." })
          );
          break;
        }

        if (!spell_identifier) {
          sendPacket(
            wt,
            packetManager.notify({ message: "No spell selected." })
          );
          break;
        }

        if (!currentPlayer.learnedSpells?.[spell.name]) {
          sendPacket(wt, packetManager.notify({ message: "You have not learned this spell." }));
          return;
        }

        if ((data as any).creature === true) {
          // As in WoW: a friendly spell (a heal, or harmless effects only) cast
          // with an enemy selected lands on the caster instead of failing.
          const creatureSpellValue = Number(spell.damage) || 0;
          const friendlySpell = creatureSpellValue < 0 ||
            (creatureSpellValue === 0 && Array.isArray(spell.effects) && spell.effects.length > 0 && !spellHasHostileEffects(spell));
          // An AoE centred on the caster (Flamestrike-style) ignores the
          // selection: the normal cast hits every player and creature around
          // the caster, so the selected creature is not needed.
          const casterCentredAoe = (Number(spell.aoe_radius) || 0) > 0 && spell.ground_aoe !== 1;
          if (!friendlySpell && !casterCentredAoe) {
            await castSpellOnCreature(wt, currentPlayer, spell, Number(targetId));
            return;
          }
          targetId = currentPlayer.id;
        }

        log.debug(`[ATTACK] Looking for target ID: ${targetId}`);
        let target = null;

        // A mirror (a player of a neighbouring node) is found too; what a spell does to it goes to its owner.
        target = targetId ? entityById(targetId) : undefined;
        if (target) {
          log.debug(`[ATTACK] Found target as player: ${target.username}`);
        } else if (targetId) {
          log.debug(`[ATTACK] Player target not found in cache: ${targetId}`);
        }

        if (!target && !targetId) {
          // Only default to self if no target was specified
          target = currentPlayer;
          log.debug(`[ATTACK] No target specified, defaulting to self`);
        }

        // Ghosts cannot be targeted or damaged.
        if (target && target.isGhost) {
          sendPacket(
            wt,
            packetManager.notify({ message: "You cannot attack ghosts." })
          );
          return;
        }

        // AoE spells don't need a valid target - they hit everything around the caster
        const isAoeSpell = spell?.aoe_radius && spell.aoe_radius > 0;
        const isGroundAoe = spell?.ground_aoe === 1 && (data as any).groundX !== undefined && (data as any).groundY !== undefined;

        if (!isAoeSpell && !isGroundAoe && !target?.id) {
          log.debug(`[ATTACK] Player ${currentPlayer.username} attempted attack with invalid target: ${targetId}`);
          sendPacket(
            wt,
            packetManager.notify({ message: "Target not found." })
          );
          return;
        }

        // Only guests check applies to players, not entities
        if (target.isGuest) {
          sendPacket(
            wt,
            packetManager.notify({ message: "You cannot attack guests." })
          );
          return;
        }

        // A harmful spell with no target (an area around the caster, or one
        // placed on the ground) answers to the no-PvP zones as a targeted one
        // does through player.canAttack. Asked here, before the cooldown is
        // read: nothing may wait between that read and the cooldown being set.
        const pvpAllowed: PvpAllowed = (position) => player.isInPvPZone(currentPlayer.location.map, position as PositionData, PVP_BODY);
        if ((isAoeSpell || isGroundAoe) && ((spell?.damage ?? 0) > 0 || spellHasHostileEffects(spell))) {
          const aim = isGroundAoe ? { x: Number((data as any).groundX), y: Number((data as any).groundY) } : null;
          const refused = await areaCastRefusal(currentPlayer.location.position, aim, pvpAllowed);
          if (refused) {
            // Told only when it is where they aimed that is wrong. A cast refused because the caster stands in a
            // no-PvP area says nothing (USER REQUEST 2026-10-06: "Remove the 'you are not in a pvp area' notification").
            if (refused === "aim") sendPacket(wt, packetManager.notify({ message: "You cannot cast that into a no-PvP area" }));
            listener.emit(Events.SPELL_FAILED, { player: currentPlayer, target, spellName: spell.name, reason: "nopvp" } as any);
            return;
          }
        }

        // These are re-evaluated later if the target changes (auto-self-cast)
        let isSelf = (target.id === currentPlayer.id) || (currentPlayer.username === target.username);

        const freshPlayerForCooldown = playerCache.get(currentPlayer.id);
        if (!freshPlayerForCooldown) return;
        freshPlayerForCooldown.spellCooldowns = freshPlayerForCooldown.spellCooldowns || {};
        const spellCooldownEnd = freshPlayerForCooldown.spellCooldowns[spell_id] || 0;
        if (spellCooldownEnd > performance?.now()) {
          listener.emit(Events.SPELL_FAILED, { player: currentPlayer, target, spellName: spell.name, reason: "cooldown" } as any);
          return;
        }

        const spell_range = spell.range || 100;
        const spell_damage = spell?.damage;
        const spell_mana = spell?.mana || 0;
        const hasEffects = Array.isArray(spell?.effects) && spell.effects.length > 0;
        const spellIsHostileEffect = spellHasHostileEffects(spell);
        const playerLevel = currentPlayer.stats.level || 1;

        if (currentPlayer.isVanished && spell_damage <= 0 && !spellIsHostileEffect) {
          const hasVanishEffect = Array.isArray(spell?.effects) && spell.effects.some((e: SpellEffect) => e.type === "vanish");
          if (!hasVanishEffect) {
            sendPacket(wt, packetManager.notify({ message: "You cannot cast beneficial spells while vanished." }));
            listener.emit(Events.SPELL_FAILED, { player: currentPlayer, target, spellName: spell.name, reason: "vanished" } as any);
            return;
          }
        }

        currentPlayer.interruptableSpell = !spell?.can_move || false;

        // A stand-still spell pressed while moving simply does nothing: it
        // never started, so there is no cast to interrupt and nothing to show.
        if (!spell?.can_move && currentPlayer.moving) {

          listener.emit(Events.SPELL_FAILED, { player: currentPlayer, target, spellName: spell.name, reason: "moving" } as any);
          return;
        }

        const freshPlayerForMana = playerCache.get(currentPlayer.id);
        if (!freshPlayerForMana) return;

        // WoW-style: a percentage of base stamina (level only, not gear).
        const actualManaCost = spellManaCost(spell_mana, freshPlayerForMana.stats);
        if ((freshPlayerForMana.stats.stamina || 0) < actualManaCost) {
          listener.emit(Events.SPELL_FAILED, { player: currentPlayer, target, spellName: spell.name, reason: "mana" } as any);
          return;
        }

        if (!spell_damage && !hasEffects) {
          listener.emit(Events.SPELL_FAILED, { player: currentPlayer, target, spellName: spell.name, reason: "no_effects" } as any);
          return;
        }

        // ATOMIC: Set cooldown immediately to prevent race condition with mana deduction
        // This must happen before any other async operations
        // Only apply spell cooldown (not cast_time) for faster feel
        freshPlayerForMana.spellCooldowns = freshPlayerForMana.spellCooldowns || {};
        const spellCooldownTime = spell.cooldown * 1000;
        freshPlayerForMana.spellCooldowns[spell_id] = performance.now() + spellCooldownTime;
        cooldownManager.setCooldown(freshPlayerForMana.username, spell_id, performance.now() + spellCooldownTime);
        freshPlayerForMana.lastCastTime = performance.now();
        freshPlayerForMana.castingSpellId = spell_id;

        playerCache.set(freshPlayerForMana.id, freshPlayerForMana);

        currentPlayer.stats = freshPlayerForMana.stats;
        currentPlayer.lastCastTime = freshPlayerForMana.lastCastTime;
        currentPlayer.spellCooldowns = freshPlayerForMana.spellCooldowns;

        if (currentPlayer.isVanished && (spell_damage > 0 || spellIsHostileEffect)) {
          const vanishId = spellEffects.getVanishedEffectId(currentPlayer);
          if (vanishId) {
            cancelEffect(currentPlayer, vanishId);
            spellEffects.broadcastEffectsUpdate(currentPlayer);
          }
        }
        currentPlayer.lastCastTime = freshPlayerForMana.lastCastTime;
        currentPlayer.spellCooldowns = freshPlayerForMana.spellCooldowns;

        // --- AoE branch: cast on self, hit everything around the caster ---
        if (isAoeSpell && !isGroundAoe) {
          currentPlayer.casting = true;
          currentPlayer.castOnSelf = true;
          currentPlayer.castId = (currentPlayer.castId || 0) + 1;
          playerCache.set(currentPlayer.id, currentPlayer);
          const thisAoeCastId = currentPlayer.castId;
          const aoeSpellStartTime = performance.now();

          if (currentPlayer.mounted) {
            currentPlayer.mounted = false;
            playerCache.set(currentPlayer.id, currentPlayer);
          }

          bumpStateRevision();
          await sendPositionAnimation(wt, currentPlayer.location.position?.direction || "down", currentPlayer.moving || false, false, currentPlayer.mount_type || "unicorn", undefined, stateRevision(), true);

          broadcastCastToAOI(
            currentPlayer,
            packetManager.castSpell({ id: currentPlayer.id, spell: spell.name, time: spell.cast_time })
          );

          await new Promise((resolve) => setTimeout(resolve, spell.cast_time * 1000));

          const aoeCheckPlayer = playerCache.get(currentPlayer.id);
          if (aoeCheckPlayer && aoeCheckPlayer.castId !== thisAoeCastId) return;

          const aoeUpdatedPlayer = playerCache.get(currentPlayer.id);
          if (aoeUpdatedPlayer && aoeUpdatedPlayer.manualSpellCancel && aoeUpdatedPlayer.manualSpellCancel >= aoeSpellStartTime) {
            if (aoeUpdatedPlayer.spellCooldowns) {
              delete aoeUpdatedPlayer.spellCooldowns[spell_id];
              cooldownManager.deleteCooldown(aoeUpdatedPlayer.username, spell_id);
            }
            delete aoeUpdatedPlayer.manualSpellCancel;
            aoeUpdatedPlayer.casting = false;
            playerCache.set(aoeUpdatedPlayer.id, aoeUpdatedPlayer);
            currentPlayer.spellCooldowns = aoeUpdatedPlayer.spellCooldowns;
            currentPlayer.manualSpellCancel = undefined;
            currentPlayer.casting = false;
            return;
          }

          if (!spell.can_move && !playerCache.get(currentPlayer.id)?.casting) {
            const resetPlayer = playerCache.get(currentPlayer.id);
            if (resetPlayer && resetPlayer.spellCooldowns) {
              delete resetPlayer.spellCooldowns[spell_id];
              playerCache.set(resetPlayer.id, resetPlayer);
            }
            return;
          }

          currentPlayer.casting = false;
          currentPlayer.mounted = false;
          playerCache.set(currentPlayer.id, currentPlayer);

          bumpStateRevision();
          await sendPositionAnimation(wt, currentPlayer.location.position?.direction || "down", currentPlayer.moving || false, false, currentPlayer.mount_type || "unicorn", undefined, stateRevision(), false);

          // Mana deduction
          const aoeManaCheck = playerCache.get(currentPlayer.id);
          if (!aoeManaCheck || (aoeManaCheck.stats.stamina || 0) < actualManaCost) {
            if (aoeManaCheck && aoeManaCheck.spellCooldowns) {
              delete aoeManaCheck.spellCooldowns[spell_id];
              cooldownManager.deleteCooldown(aoeManaCheck.username, spell_id);
              playerCache.set(aoeManaCheck.id, aoeManaCheck);
            }
            return;
          }
          currentPlayer.stats.stamina = aoeManaCheck.stats.stamina;
          currentPlayer.stats.stamina -= actualManaCost;
          if (currentPlayer.stats.stamina < 0) currentPlayer.stats.stamina = 0;

          // AoE splash from caster position
          const aoeX = currentPlayer.location.position.x;
          const aoeY = currentPlayer.location.position.y;
          const aoeRadius = spell.aoe_radius!;

          // Send a projectile packet from caster to self as a visual indicator
          broadcastToAOIBestEffort(currentPlayer, packetManager.projectile({
            id: currentPlayer.id, time: 0.3, target_id: currentPlayer.id,
            spell: spell.name, icon: getIconUrl(spell.icon), entity: false
          }));

          const splashTargets: Array<{ target: any }> = [];
          const aoeIsHeal = spell_damage < 0;
          // Only this layer's players within the radius can be hit; the grid
          // keeps the scan to the crowd round the caster, not the whole map.
          for (const p of playersAndMirrorsNear(aoeX, aoeY, currentPlayer.location.map, aoeRadius, layerManager.getPlayerLayer(currentPlayer.id))) {
            // A mirror (another node's player) passes the same checks; its hit goes to its owner below.
            if (p.id === currentPlayer.id && !aoeIsHeal) continue;
            if (p.isGuest) continue;
            // Ghosts cannot be damaged or healed.
            if (p.isGhost) continue;
            // An admin in stealth is out of the game for everyone else: no spell touches them
            // (player.canAttack refuses one as a target).
            if (p.isStealth) continue;
            const inParty = currentPlayer?.party?.includes(p?.username) || false;
            if (aoeIsHeal) {
              // Healing AoE: only hit self and party members
              if (p.id !== currentPlayer.id && !inParty) continue;
            } else {
              // Damage AoE: skip self and party members
              if (p.id === currentPlayer.id || inParty) continue;
            }
            const pPos = p.location?.position;
            if (!pPos) continue;
            const dist = Math.sqrt((pPos.x - aoeX) ** 2 + (pPos.y - aoeY) ** 2);
            if (dist > aoeRadius) continue;
            // Nobody in a no-PvP zone is harmed, nor anyone when the caster walked into one during the cast.
            if (!aoeIsHeal && !(await areaSpellHarms(currentPlayer.location.position, pPos, pvpAllowed))) continue;
            splashTargets.push({ target: p });
          }

          // Creatures don't receive healing AoE
          if (!aoeIsHeal) splashCreatures(currentPlayer, spell, aoeX, aoeY, aoeRadius, null);

          const attackerDamageBonus = currentPlayer.stats.stat_damage || 0;
          // Hits on mirrors, sent to their owners after the local victims are done.
          const remoteHits: Promise<boolean>[] = [];
          for (const splash of splashTargets) {
            const st = splash.target;
            // Heals: WoW-style roll (negative = healing); damage: level roll + damage stat.
            let splashDmg = spell_damage < 0
              ? -rollHeal(spell_damage, currentPlayer.stats, spell.cast_time).amount
              : Math.floor(Math.random() * ((playerLevel - 1) * 3 + 1)) + spell_damage + (playerLevel - 1) * 2 + attackerDamageBonus;
            if (spell_damage === 0) splashDmg = 0;

            if (splashDmg > 0) {
              const av = st.stats?.stat_avoidance || 0;
              if (Math.random() * 100 < av) splashDmg = 0;
              if (splashDmg > 0) {
                const ar = st.stats?.stat_armor || 0;
                splashDmg = Math.floor(splashDmg * (1 - Math.min(ar, 75) / 100));
              }
            }

            // A player of a neighbouring node: its owner checks no-PvP and immunity, and applies the hit (spec §4).
            if (routeSplashToMirror(remoteHits, currentPlayer, st, spell, splashDmg, { skipEffects: spell_damage > 0 && splashDmg === 0, showsDamage: spell_damage !== 0, harmful: !aoeIsHeal })) continue;

            {
              let toHealth = splashDmg;
              if (splashDmg > 0) {
                const ab = spellEffects.consumeBarrier(st, splashDmg);
                toHealth = splashDmg - ab;
                if (ab > 0) spellEffects.broadcastEffectsUpdate(st);
              }
              st.stats.health = Math.round(st.stats.health - toHealth);
              if (st.stats.health > st.stats.total_max_health) {
                st.stats.health = st.stats.total_max_health;
              }
              listener.emit(Events.PLAYER_DAMAGED, { attacker: currentPlayer, target: st, damage: splashDmg, isCrit: false });

              if (st.stats.health <= 0) {
                await handlePlayerDeath(st, currentPlayer, { damage: splashDmg, isCrit: false });
              } else {
                if (!(spell_damage > 0 && splashDmg === 0)) {
                await spellEffects.applySpellEffects(spell, currentPlayer, st,
                  (pp: any) => broadcastStatsUpdateToAOI(pp, currentPlayer, packetManager.updateStats({ id: pp.id, target: pp.id, stats: pp.stats })),
                  (pp: any) => spellEffects.broadcastEffectsUpdate(pp)
                );
                }
                if (spell_damage !== 0) {
                broadcastStatsUpdateToAOI(
                  st,
                  currentPlayer,
                  packetManager.updateStats({ id: wt.data.id, target: st.id, stats: st.stats, isCrit: false, damage: splashDmg })
                );
                }
              }

              setPlayerPvp(currentPlayer, true);
              setPlayerPvp(st, true);
              st.last_attack = performance.now();

              if (spell_damage > 0 && st.isVanished) {
                const vId = spellEffects.getVanishedEffectId(st);
                if (vId) {
                  cancelEffect(st, vId);
                  spellEffects.broadcastEffectsUpdate(st);
                }
              }
            }
          }

          // The hits on mirrors go to their owners together, so one dead link delays none of the others.
          if (remoteHits.length) await Promise.allSettled(remoteHits);

          if (currentPlayer.isVanished) {
            const cvId = spellEffects.getVanishedEffectId(currentPlayer);
            if (cvId) {
              cancelEffect(currentPlayer, cvId);
              spellEffects.broadcastEffectsUpdate(currentPlayer);
            }
          }

          // Sync caster stats
          const syncedStats = await player.synchronizeStats(currentPlayer.username);
          if (syncedStats) currentPlayer.stats = syncedStats;
          playerCache.set(currentPlayer.id, currentPlayer);
          broadcastToAOIBestEffort(currentPlayer, packetManager.updateStats({ id: currentPlayer.id, target: currentPlayer.id, stats: currentPlayer.stats }));

          currentPlayer.last_attack = performance.now();
          listener.emit(Events.SPELL_CAST, { player: currentPlayer, spellName: spell.name, target: currentPlayer, isEntityTarget: false });
          break;
        }

        // --- Ground-targeted AoE branch: click-to-place, with optional lingering zone ---
        if (isGroundAoe) {
          const groundX = Number((data as any).groundX);
          const groundY = Number((data as any).groundY);

          // Validate range
          const casterPos = currentPlayer.location.position;
          const casterX = typeof casterPos === 'string' ? Number(casterPos.split(',')[0]) : casterPos.x;
          const casterY = typeof casterPos === 'string' ? Number(casterPos.split(',')[1]) : casterPos.y;
          const distToTarget = Math.sqrt((groundX - casterX) ** 2 + (groundY - casterY) ** 2);
          const maxRange = spell.range || 100;
          if (distToTarget > maxRange) {
            if (freshPlayerForMana.spellCooldowns) {
              delete freshPlayerForMana.spellCooldowns[spell_id];
              cooldownManager.deleteCooldown(freshPlayerForMana.username, spell_id);
            }
            playerCache.set(freshPlayerForMana.id, freshPlayerForMana);
            currentPlayer.spellCooldowns = freshPlayerForMana.spellCooldowns;
            return;
          }

          currentPlayer.casting = true;
          currentPlayer.castOnSelf = false;
          currentPlayer.castId = (currentPlayer.castId || 0) + 1;
          playerCache.set(currentPlayer.id, currentPlayer);
          const thisGroundCastId = currentPlayer.castId;
          const groundCastStartTime = performance.now();

          if (currentPlayer.mounted) {
            currentPlayer.mounted = false;
            playerCache.set(currentPlayer.id, currentPlayer);
          }

          const groundAoERadius = spell.aoe_radius || 0;
          const groundDuration = spell.ground_duration || 0;

          bumpStateRevision();
          await sendPositionAnimation(wt, currentPlayer.location.position?.direction || "down", currentPlayer.moving || false, false, currentPlayer.mount_type || "unicorn", undefined, stateRevision(), true);

          broadcastCastToAOI(
            currentPlayer,
            packetManager.castSpell({ id: currentPlayer.id, spell: spell.name, time: spell.cast_time, groundX, groundY, groundRadius: groundAoERadius })
          );
          // The preview's despawn reaches the same viewers, so none keeps a stale one.
          broadcastGroundPreviewToAOI(
            currentPlayer,
            packetManager.groundAoeCasting({ id: currentPlayer.id, spell: spell.name, casterId: currentPlayer.id, x: groundX, y: groundY, radius: groundAoERadius, castTime: spell.cast_time })
          );

          await new Promise((resolve) => setTimeout(resolve, spell.cast_time * 1000));

          const groundCheckPlayer = playerCache.get(currentPlayer.id);
          if (groundCheckPlayer && groundCheckPlayer.castId !== thisGroundCastId) return;

          const groundUpdatedPlayer = playerCache.get(currentPlayer.id);
          if (groundUpdatedPlayer && groundUpdatedPlayer.manualSpellCancel && groundUpdatedPlayer.manualSpellCancel >= groundCastStartTime) {
            // Cancel: clear preview
            clearGroundPreviewForAOI(currentPlayer, packetManager.groundAoeDespawn({ id: currentPlayer.id + "_casting" }));
            if (groundUpdatedPlayer.spellCooldowns) {
              delete groundUpdatedPlayer.spellCooldowns[spell_id];
              cooldownManager.deleteCooldown(groundUpdatedPlayer.username, spell_id);
            }
            delete groundUpdatedPlayer.manualSpellCancel;
            groundUpdatedPlayer.casting = false;
            playerCache.set(groundUpdatedPlayer.id, groundUpdatedPlayer);
            currentPlayer.spellCooldowns = groundUpdatedPlayer.spellCooldowns;
            currentPlayer.manualSpellCancel = undefined;
            currentPlayer.casting = false;
            return;
          }

          if (!spell.can_move && !playerCache.get(currentPlayer.id)?.casting) {
            clearGroundPreviewForAOI(currentPlayer, packetManager.groundAoeDespawn({ id: currentPlayer.id + "_casting" }));
            const resetPlayer = playerCache.get(currentPlayer.id);
            if (resetPlayer && resetPlayer.spellCooldowns) {
              delete resetPlayer.spellCooldowns[spell_id];
              playerCache.set(resetPlayer.id, resetPlayer);
            }
            return;
          }

          // Clear casting preview
          clearGroundPreviewForAOI(currentPlayer, packetManager.groundAoeDespawn({ id: currentPlayer.id + "_casting" }));

          currentPlayer.casting = false;
          currentPlayer.mounted = false;
          playerCache.set(currentPlayer.id, currentPlayer);

          bumpStateRevision();
          await sendPositionAnimation(wt, currentPlayer.location.position?.direction || "down", currentPlayer.moving || false, false, currentPlayer.mount_type || "unicorn", undefined, stateRevision(), false);

          // Mana deduction
          const groundManaCheck = playerCache.get(currentPlayer.id);
          if (!groundManaCheck || (groundManaCheck.stats.stamina || 0) < actualManaCost) {
            if (groundManaCheck && groundManaCheck.spellCooldowns) {
              delete groundManaCheck.spellCooldowns[spell_id];
              cooldownManager.deleteCooldown(groundManaCheck.username, spell_id);
              playerCache.set(groundManaCheck.id, groundManaCheck);
            }
            return;
          }
          currentPlayer.stats.stamina = groundManaCheck.stats.stamina;
          currentPlayer.stats.stamina -= actualManaCost;
          if (currentPlayer.stats.stamina < 0) currentPlayer.stats.stamina = 0;

          const isHeal = spell_damage < 0;
          const isThrown = spell?.is_thrown === 1;
          const resolvedParticles = spell.particles
            ? (typeof spell.particles === 'string'
              ? spell.particles.split(',').map((s: string) => s.trim()).filter(Boolean)
              : [])
            : [];

          if (isThrown) {
            const casterPos = currentPlayer.location.position;
            const cx = typeof casterPos === 'string' ? Number(casterPos.split(',')[0]) : casterPos.x;
            const cy = typeof casterPos === 'string' ? Number(casterPos.split(',')[1]) : casterPos.y;
            const throwDist = Math.sqrt((groundX - cx) ** 2 + (groundY - cy) ** 2);
            const throwSpeed = 350;
            const travelTime = Math.max(0.4, Math.min(throwDist / throwSpeed, 2.5));

            broadcastToAOIBestEffort(currentPlayer, packetManager.projectile({
              id: currentPlayer.id,
              time: travelTime,
              target_id: currentPlayer.id,
              spell: spell.name,
              icon: getIconUrl(spell.icon),
              entity: false,
              isThrown: true,
              targetX: groundX,
              targetY: groundY,
              particles: resolvedParticles.length > 0 ? resolvedParticles : undefined,
            }));

            await new Promise((resolve) => setTimeout(resolve, travelTime * 1000));

            const thrownCheckPlayer = playerCache.get(currentPlayer.id);
            if (thrownCheckPlayer && thrownCheckPlayer.castId !== thisGroundCastId) return;
          }

          if (groundDuration > 0) {
            // Lingering zone
            try {
              spawnZone({
                spellId: spell_id,
                spellName: spell.name,
                casterId: currentPlayer.id,
                casterUsername: currentPlayer.username,
                mapName: currentPlayer.location.map,
                position: { x: groundX, y: groundY },
                radius: groundAoERadius,
                duration: groundDuration,
                tickInterval: 1,
                damagePerTick: spell_damage,
                damageType: isHeal ? "heal" : "damage",
                particles: resolvedParticles.length > 0 ? resolvedParticles : null,
                effects: Array.isArray(spell.effects) ? spell.effects : null,
                spell,
              });
            } catch (error) {
              // No zone was made (the world has no id to give it): the cast did not happen, so the mana and cooldown are given back.
              log.error(`Ground AoE ${spell.name} of ${currentPlayer.username} was not spawned: ${error}`);
              currentPlayer.stats.stamina = Math.min((currentPlayer.stats.stamina || 0) + actualManaCost, currentPlayer.stats.total_max_stamina ?? Infinity);
              const failedCaster = playerCache.get(currentPlayer.id);
              if (failedCaster?.spellCooldowns) {
                delete failedCaster.spellCooldowns[spell_id];
                cooldownManager.deleteCooldown(failedCaster.username, spell_id);
                currentPlayer.spellCooldowns = failedCaster.spellCooldowns;
              }
              playerCache.set(currentPlayer.id, currentPlayer);
              broadcastToAOIBestEffort(currentPlayer, packetManager.updateStats({ id: currentPlayer.id, target: currentPlayer.id, stats: currentPlayer.stats }));
              sendPacket(wt, packetManager.notify({ message: `${spell.name} failed. Try again.` }));
              break;
            }
          } else {
            // Instant burst at ground position (no lingering)
            const splashTargets: Array<{ target: any }> = [];
            // Only this layer's players within the radius can be hit.
            for (const p of playersAndMirrorsNear(groundX, groundY, currentPlayer.location.map, groundAoERadius, layerManager.getPlayerLayer(currentPlayer.id))) {
              // A mirror (another node's player) passes the same checks; its hit goes to its owner below.
              if (p.isGuest) continue;
              // An admin in stealth is out of the game for everyone else: no spell touches them.
              if (p.isStealth) continue;
              const inParty = currentPlayer?.party?.includes(p.username) || false;
              if (isHeal) {
                if (p.id !== currentPlayer.id && !inParty) continue;
              } else {
                if (p.id === currentPlayer.id || inParty) continue;
              }
              const pPos = p.location?.position;
              if (!pPos) continue;
              const dist = Math.sqrt((pPos.x - groundX) ** 2 + (pPos.y - groundY) ** 2);
              if (dist > groundAoERadius) continue;
              // Nobody in a no-PvP zone is harmed, nor anyone when the caster walked into one during the cast.
              if (!isHeal && !(await areaSpellHarms(currentPlayer.location.position, pPos, pvpAllowed))) continue;
              splashTargets.push({ target: p });
            }

            if (!isHeal) splashCreatures(currentPlayer, spell, groundX, groundY, groundAoERadius, null);

            const attackerDamageBonus = currentPlayer.stats.stat_damage || 0;
            // Hits on mirrors, sent to their owners after the local victims are done.
            const remoteHits: Promise<boolean>[] = [];
            for (const splash of splashTargets) {
              const st = splash.target;
              // Heals: WoW-style roll (negative = healing); damage: level roll + damage stat.
              let splashDmg = spell_damage < 0
                ? -rollHeal(spell_damage, currentPlayer.stats, spell.cast_time).amount
                : Math.floor(Math.random() * ((playerLevel - 1) * 3 + 1)) + spell_damage + (playerLevel - 1) * 2 + attackerDamageBonus;
              if (spell_damage === 0) splashDmg = 0;

              if (splashDmg > 0) {
                const av = st.stats?.stat_avoidance || 0;
                if (Math.random() * 100 < av) splashDmg = 0;
                if (splashDmg > 0) {
                  const ar = st.stats?.stat_armor || 0;
                  splashDmg = Math.floor(splashDmg * (1 - Math.min(ar, 75) / 100));
                }
              }

              // A player of a neighbouring node: its owner checks no-PvP and immunity, and applies the hit (spec §4).
              if (routeSplashToMirror(remoteHits, currentPlayer, st, spell, splashDmg, { skipEffects: spell_damage > 0 && splashDmg === 0, showsDamage: spell_damage !== 0, harmful: !isHeal })) continue;

              {
                let toHealth = splashDmg;
                if (splashDmg > 0) {
                  const ab = spellEffects.consumeBarrier(st, splashDmg);
                  toHealth = splashDmg - ab;
                  if (ab > 0) spellEffects.broadcastEffectsUpdate(st);
                }
                st.stats.health = Math.round(st.stats.health - toHealth);
                if (st.stats.health > st.stats.total_max_health) {
                  st.stats.health = st.stats.total_max_health;
                }
                listener.emit(Events.PLAYER_DAMAGED, { attacker: currentPlayer, target: st, damage: splashDmg, isCrit: false });

                if (st.stats.health <= 0) {
                  await handlePlayerDeath(st, currentPlayer, { damage: splashDmg, isCrit: false });
                } else {
                  if (!(spell_damage > 0 && splashDmg === 0)) {
                    await spellEffects.applySpellEffects(spell, currentPlayer, st,
                      (pp: any) => broadcastStatsUpdateToAOI(pp, currentPlayer, packetManager.updateStats({ id: pp.id, target: pp.id, stats: pp.stats })),
                      (pp: any) => spellEffects.broadcastEffectsUpdate(pp)
                    );
                  }
                  if (spell_damage !== 0) {
                    broadcastStatsUpdateToAOI(
                      st,
                      currentPlayer,
                      packetManager.updateStats({ id: wt.data.id, target: st.id, stats: st.stats, isCrit: false, damage: splashDmg })
                    );
                  }
                }

                setPlayerPvp(currentPlayer, true);
                setPlayerPvp(st, true);
                st.last_attack = performance.now();

                if (splashDmg > 0 && st.isVanished) {
                  const vId = spellEffects.getVanishedEffectId(st);
                  if (vId) {
                    cancelEffect(st, vId);
                    spellEffects.broadcastEffectsUpdate(st);
                  }
                }
              }
            }

            // The hits on mirrors go to their owners together, so one dead link delays none of the others.
            if (remoteHits.length) await Promise.allSettled(remoteHits);

            if (currentPlayer.isVanished) {
              const cvId = spellEffects.getVanishedEffectId(currentPlayer);
              if (cvId) {
                cancelEffect(currentPlayer, cvId);
                spellEffects.broadcastEffectsUpdate(currentPlayer);
              }
            }

            // Visual projectile from caster to ground position
            broadcastToAOIBestEffort(currentPlayer, packetManager.projectile({
              id: currentPlayer.id, time: 0.3, target_id: currentPlayer.id,
              spell: spell.name, icon: getIconUrl(spell.icon), entity: false
            }));
          }

          // Sync caster stats
          const syncedStats = await player.synchronizeStats(currentPlayer.username);
          if (syncedStats) currentPlayer.stats = syncedStats;
          playerCache.set(currentPlayer.id, currentPlayer);
          broadcastToAOIBestEffort(currentPlayer, packetManager.updateStats({ id: currentPlayer.id, target: currentPlayer.id, stats: currentPlayer.stats }));

          currentPlayer.last_attack = performance.now();
          listener.emit(Events.SPELL_CAST, { player: currentPlayer, spellName: spell.name, target: currentPlayer, isEntityTarget: false });
          break;
        }

        const isInParty = currentPlayer?.party?.includes(target?.username) || null;

        if (isInParty && (spell_damage > 0 || spellIsHostileEffect)) {
          if (isSelf) return;
          sendPacket(
            wt,
            packetManager.notify({
              message: "You cannot attack your party members",
            })
          );
          return;
        }

        if ((spell_damage < 0 || (spell_damage === 0 && hasEffects && !spellIsHostileEffect)) && target.id !== currentPlayer.id && !isInParty) {
          target = currentPlayer;
          isSelf = true;
        }

        const playersInAttackRange = withMirrors(
          wt,
          spell_range,
          currentPlayer.location.map
        );

        log.debug(`[ATTACK] Identified target as player. username=${target.username}`);

        // Casting at someone behind you turns you to face them (WoW) rather
        // than failing the facing check below.
        if (target.id !== currentPlayer.id && target.location?.position) {
          faceToward(currentPlayer, Number(target.location.position.x), Number(target.location.position.y));
        }

        const canAttack: any = await player.canAttack(currentPlayer, target,
          {
            width: 24,
            height: 40,
          },
          spell_range,
          spell_damage > 0 || spellIsHostileEffect
        );
        log.debug(`[ATTACK] canAttack result: ${JSON.stringify(canAttack)}`);

        const targetX = target.location?.position?.x || 0;
        const targetY = target.location?.position?.y || 0;

        const distance = Math.sqrt(
          Math.pow(currentPlayer.location.position.x - targetX, 2) +
          Math.pow(currentPlayer.location.position.y - targetY, 2)
        );

        isSelf = (target.id === currentPlayer.id) || (currentPlayer.username === target.username);
        
        // Prevent self-targeting for damaging/hostile spells, but allow self-targeting for healing/buff spells and AoE
        if (isSelf && (spell_damage > 0 || spellIsHostileEffect) && !isAoeSpell) return;

        if (!canAttack?.value) {
          // (a cast refused for a no-PvP area says nothing: see the area casts above)
          if (canAttack?.reason == "path_blocked") {
            sendPacket(
              wt,
              packetManager.notify({ message: "Target is not in line of sight" })
            );
          }
          if (canAttack?.reason == "range") {
            sendPacket(
              wt,
              packetManager.notify({ message: "Target is out of range" })
            );
          }
          listener.emit(Events.SPELL_FAILED, { player: currentPlayer, target, spellName: spell.name, reason: canAttack?.reason || "unknown" } as any);
          return;
        } else if (!playersInAttackRange.includes(target)) {
          return;
        }

        const isChargeSpell = spell?.charge_distance && spell.charge_distance > 0;
        const isTeleportBehind = spell?.teleport_behind === 1;
        if (isChargeSpell && !isSelf) {
          const cPos = currentPlayer.location.position;
          const cx = typeof cPos === 'string' ? Number(cPos.split(',')[0]) : cPos.x;
          const cy = typeof cPos === 'string' ? Number(cPos.split(',')[1]) : cPos.y;
          const tPos = target.location.position;
          const tx = typeof tPos === 'string' ? Number(tPos.split(',')[0]) : tPos.x;
          const ty = typeof tPos === 'string' ? Number(tPos.split(',')[1]) : tPos.y;
          const dist = Math.sqrt((tx - cx) ** 2 + (ty - cy) ** 2);
          const chargeDist = Math.min(spell.charge_distance ?? 0, Math.max(0, dist - 40));
          const ratio = dist > 0 ? chargeDist / dist : 0;
          const landX = Math.round(cx + (tx - cx) * ratio);
          const landY = Math.round(cy + (ty - cy) * ratio);

          const losCharge = await hasLineOfSight(cx, cy, landX, landY, currentPlayer.location.map, (spell.charge_distance ?? 0) + 50);
          if (!losCharge) {
            sendPacket(wt, packetManager.notify({ message: "Cannot charge - path blocked." }));
            if (currentPlayer.spellCooldowns) {
              delete currentPlayer.spellCooldowns[spell_id];
            }
            return;
          }

          const newDir = directionToward(landX, landY, tx, ty);

          currentPlayer.location.position.x = landX;
          currentPlayer.location.position.y = landY;
          currentPlayer.location.position.direction = newDir;
          currentPlayer.moving = false;
          ghosts.touch("player", currentPlayer.id);
          playerCache.set(currentPlayer.id, currentPlayer);

          bumpStateRevision();
          if (shouldUpdateAOI(currentPlayer)) {
            await updatePlayerAOI(currentPlayer, spawnBatchQueue, despawnBatchQueue);
          }
          const chargeMoveData = {
            i: wt.data.id,
            d: { x: landX, y: landY, dr: newDir },
            r: stateRevision(),
            s: currentPlayer.isStealth ? 1 : 0,
          };
          broadcastToAOI(currentPlayer, packetManager.moveXY(chargeMoveData), true);

          await sendPositionAnimation(wt, newDir, false, false, "", undefined, stateRevision(), false);

          broadcastCastToAOI(
            currentPlayer,
            packetManager.castSpell({ id: currentPlayer.id, spell: spell.name, time: 0 })
          );

          currentPlayer.last_attack = performance.now();
          if (currentPlayer.isVanished) {
            const vId = spellEffects.getVanishedEffectId(currentPlayer);
            if (vId) {
              cancelEffect(currentPlayer, vId);
              spellEffects.broadcastEffectsUpdate(currentPlayer);
            }
          }
          listener.emit(Events.SPELL_CAST, { player: currentPlayer, spellName: spell.name, target, isEntityTarget: false });

          if (target.remote) {
            // A player of a neighbouring node: its owner checks and applies the effects, and flags the target
            // as a local hit does, also when the spell has no effects (spec §4). The caster's flag is set
            // by hitRemotePlayer once the hit landed.
            await hitRemotePlayer(currentPlayer, target, remoteHit(currentPlayer, spell, 0, false, { skipEffects: !hasEffects, showsDamage: false, harmful: true }));
          } else {
            if (Array.isArray(spell.effects) && spell.effects.length > 0) {
              await spellEffects.applySpellEffects(spell, currentPlayer, target,
                (pp: any) => broadcastStatsUpdateToAOI(pp, currentPlayer, packetManager.updateStats({ id: pp.id, target: pp.id, stats: pp.stats })),
                (pp: any) => spellEffects.broadcastEffectsUpdate(pp)
              );
            }

            setPlayerPvp(currentPlayer, true);
            setPlayerPvp(target, true);
            target.last_attack = performance.now();
          }
          break;
        }

        if (isTeleportBehind && !isSelf) {
          const tPos = target.location.position;
          const tx = typeof tPos === 'string' ? Number(tPos.split(',')[0]) : tPos.x;
          const ty = typeof tPos === 'string' ? Number(tPos.split(',')[1]) : tPos.y;
          const tDir = typeof tPos === 'string' ? 'down' : (tPos.direction || 'down');

          const dirOffsets: Record<string, { dx: number; dy: number; face: string }> = {
            right:     { dx: -40, dy: 0,   face: 'right' },
            downright: { dx: -28, dy: -28, face: 'downright' },
            down:      { dx: 0,   dy: -40, face: 'down' },
            downleft:  { dx: 28,  dy: -28, face: 'downleft' },
            left:      { dx: 40,  dy: 0,   face: 'left' },
            upleft:    { dx: 28,  dy: 28,  face: 'upleft' },
            up:        { dx: 0,   dy: 40,  face: 'up' },
            upright:   { dx: -28, dy: 28,  face: 'upright' },
          };
          const offset = dirOffsets[tDir] || dirOffsets['down'];
          const landX = Math.round(tx + offset.dx);
          const landY = Math.round(ty + offset.dy);

          const losBehind = await hasLineOfSight(tx, ty, landX, landY, currentPlayer.location.map, 60);
          if (!losBehind) {
            sendPacket(wt, packetManager.notify({ message: "Cannot teleport behind target - path blocked." }));
            if (currentPlayer.spellCooldowns) {
              delete currentPlayer.spellCooldowns[spell_id];
            }
            return;
          }

          currentPlayer.location.position.x = landX;
          currentPlayer.location.position.y = landY;
          currentPlayer.location.position.direction = offset.face;
          currentPlayer.moving = false;
          ghosts.touch("player", currentPlayer.id);
          playerCache.set(currentPlayer.id, currentPlayer);

          bumpStateRevision();
          if (shouldUpdateAOI(currentPlayer)) {
            await updatePlayerAOI(currentPlayer, spawnBatchQueue, despawnBatchQueue);
          }
          const tpMoveData = {
            i: wt.data.id,
            d: { x: landX, y: landY, dr: offset.face },
            r: stateRevision(),
            s: currentPlayer.isStealth ? 1 : 0,
          };
          broadcastToAOI(currentPlayer, packetManager.moveXY(tpMoveData), true);

          await sendPositionAnimation(wt, offset.face, false, false, "", undefined, stateRevision(), false);

          broadcastCastToAOI(
            currentPlayer,
            packetManager.castSpell({ id: currentPlayer.id, spell: spell.name, time: 0 })
          );

          currentPlayer.last_attack = performance.now();
          if (currentPlayer.isVanished) {
            const vId = spellEffects.getVanishedEffectId(currentPlayer);
            if (vId) {
              cancelEffect(currentPlayer, vId);
              spellEffects.broadcastEffectsUpdate(currentPlayer);
            }
          }
          listener.emit(Events.SPELL_CAST, { player: currentPlayer, spellName: spell.name, target, isEntityTarget: false });

          if (target.remote) {
            // A player of a neighbouring node: its owner checks and applies the effects, and flags the target
            // as a local hit does, also when the spell has no effects (spec §4). The caster's flag is set
            // by hitRemotePlayer once the hit landed.
            await hitRemotePlayer(currentPlayer, target, remoteHit(currentPlayer, spell, 0, false, { skipEffects: !hasEffects, showsDamage: false, harmful: true }));
          } else {
            if (Array.isArray(spell.effects) && spell.effects.length > 0) {
              await spellEffects.applySpellEffects(spell, currentPlayer, target,
                (pp: any) => broadcastStatsUpdateToAOI(pp, currentPlayer, packetManager.updateStats({ id: pp.id, target: pp.id, stats: pp.stats })),
                (pp: any) => spellEffects.broadcastEffectsUpdate(pp)
              );
            }

            setPlayerPvp(currentPlayer, true);
            setPlayerPvp(target, true);
            target.last_attack = performance.now();
          }
          break;
        }

        let delay = 0;
        if (target.id !== currentPlayer.id && spell_damage >= 0) {
          const maxTravelTime = 500;
          const speedMultiplier = 1000;

          const calculatedDelay = (distance / speedMultiplier) * 1000;

          delay = Math.min(calculatedDelay, maxTravelTime);
        }

        currentPlayer.casting = true;
        currentPlayer.castOnSelf = isSelf;
        currentPlayer.castId = (currentPlayer.castId || 0) + 1;
        playerCache.set(currentPlayer.id, currentPlayer);
        const thisCastId = currentPlayer.castId;
        const spellStartTime = performance.now();

        // Dismount player if they're mounted
        if (currentPlayer.mounted) {
          currentPlayer.mounted = false;
          playerCache.set(currentPlayer.id, currentPlayer);
        }

        bumpStateRevision();
        await sendPositionAnimation(
          wt,
          currentPlayer.location.position?.direction || "down",
          currentPlayer.moving || false,
          false,
          currentPlayer.mount_type || "unicorn",
          undefined,
          stateRevision(),
          true
        );

        broadcastCastToAOI(
          currentPlayer,
          packetManager.castSpell({ id: currentPlayer.id, spell: spell.name, time: spell.cast_time })
        );
        await new Promise((resolve) => setTimeout(resolve, spell.cast_time * 1000));

        // Abort if this cast was superseded by a new cast (e.g. interrupted then recast)
        const castCheckPlayer = playerCache.get(currentPlayer.id);
        if (castCheckPlayer && castCheckPlayer.castId !== thisCastId) {
          return;
        }

        // Check if spell was manually cancelled via ESC during cast time
        const updatedPlayer = playerCache.get(currentPlayer.id);
        if (updatedPlayer && updatedPlayer.manualSpellCancel && updatedPlayer.manualSpellCancel >= spellStartTime) {
          // Spell was cancelled during cast time, abort execution
          // Clear the manual cancel flag so next cast is allowed
          if (updatedPlayer.spellCooldowns) {
            delete updatedPlayer.spellCooldowns[spell_id];
            cooldownManager.deleteCooldown(updatedPlayer.username, spell_id);
          }
          delete updatedPlayer.manualSpellCancel;
          updatedPlayer.casting = false;
          playerCache.set(updatedPlayer.id, updatedPlayer);
          // Sync back to currentPlayer so wt.data stays current
          currentPlayer.spellCooldowns = updatedPlayer.spellCooldowns;
          currentPlayer.manualSpellCancel = undefined;
          currentPlayer.casting = false;
          await resumeWalkingFacing(wt, updatedPlayer);
          return;
        }

        if (!spell.can_move && !playerCache.get(currentPlayer.id)?.casting) {

          const resetPlayer = playerCache.get(currentPlayer.id);
          if (resetPlayer && resetPlayer.spellCooldowns) {
            delete resetPlayer.spellCooldowns[spell_id];
            cooldownManager.deleteCooldown(resetPlayer.username, spell_id);
            playerCache.set(resetPlayer.id, resetPlayer);
          }
          return;
        }
        currentPlayer.casting = false;
        // After cast, mounted should always be false (player was dismounted at start of cast)
        currentPlayer.mounted = false;
        playerCache.set(currentPlayer.id, currentPlayer);

        // The target may have moved behind the caster during the cast: face
        // them again so the completion check below does not fail on facing.
        const targetNow = entityById(target.id) ?? target;
        if (!isSelf && targetNow.location?.position) {
          faceToward(currentPlayer, Number(targetNow.location.position.x), Number(targetNow.location.position.y));
        }

        bumpStateRevision();
        await sendPositionAnimation(
          wt,
          currentPlayer.location.position?.direction || "down",
          currentPlayer.moving || false,
          false,
          currentPlayer.mount_type || "unicorn",
          undefined,
          stateRevision(),
          false
        );

        let canAttack2: any = { value: true };

        if (spell.cast_time > 0) {
          canAttack2 = await player.canAttack(currentPlayer, target,
            {
              width: 24,
              height: 40,
            },
            spell_range,
            spell_damage > 0 || spellIsHostileEffect
          );
        }

        // Facing only mattered for the check above; walk the way you are walking.
        await resumeWalkingFacing(wt, currentPlayer);

        if (canAttack2?.reason == "nopvp") {
          broadcastCastToAOI(
            currentPlayer,
            packetManager.castSpell({ id: currentPlayer.id, spell: 'failed', time: 1 })
          );

          const resetPlayer = playerCache.get(currentPlayer.id);
          if (resetPlayer && resetPlayer.spellCooldowns) {
            delete resetPlayer.spellCooldowns[spell_id];
            cooldownManager.deleteCooldown(resetPlayer.username, spell_id);
            playerCache.set(resetPlayer.id, resetPlayer);
          }
          listener.emit(Events.SPELL_FAILED, { player: currentPlayer, target, spellName: spell.name, reason: "nopvp" } as any);
          return;
        }

        if (canAttack2?.reason == "path_blocked") {
          broadcastCastToAOI(
            currentPlayer,
            packetManager.castSpell({ id: currentPlayer.id, spell: 'failed', time: 1 })
          );

          const resetPlayer = playerCache.get(currentPlayer.id);
          if (resetPlayer && resetPlayer.spellCooldowns) {
            delete resetPlayer.spellCooldowns[spell_id];
            cooldownManager.deleteCooldown(resetPlayer.username, spell_id);
            playerCache.set(resetPlayer.id, resetPlayer);
          }
          listener.emit(Events.SPELL_FAILED, { player: currentPlayer, target, spellName: spell.name, reason: "path_blocked" } as any);
          return;
        }

        if (canAttack2?.reason == "range") {
          broadcastCastToAOI(
            currentPlayer,
            packetManager.castSpell({ id: currentPlayer.id, spell: 'failed', time: 1 })
          );

          const resetPlayer = playerCache.get(currentPlayer.id);
          if (resetPlayer && resetPlayer.spellCooldowns) {
            delete resetPlayer.spellCooldowns[spell_id];
            cooldownManager.deleteCooldown(resetPlayer.username, spell_id);
            playerCache.set(resetPlayer.id, resetPlayer);
          }
          listener.emit(Events.SPELL_FAILED, { player: currentPlayer, target, spellName: spell.name, reason: "range" } as any);
          return;
        }

        if (canAttack2?.reason == "direction") {
          broadcastCastToAOI(
            currentPlayer,
            packetManager.castSpell({ id: currentPlayer.id, spell: 'failed', time: 1 })
          );

          const resetPlayer = playerCache.get(currentPlayer.id);
          if (resetPlayer && resetPlayer.spellCooldowns) {
            delete resetPlayer.spellCooldowns[spell_id];
            cooldownManager.deleteCooldown(resetPlayer.username, spell_id);
            playerCache.set(resetPlayer.id, resetPlayer);
          }
          listener.emit(Events.SPELL_FAILED, { player: currentPlayer, target, spellName: spell.name, reason: "direction" } as any);
          return;
        }

        // If canAttack validation failed for any other reason, abort
        if (!canAttack2?.value) {
          const resetPlayer = playerCache.get(currentPlayer.id);
          if (resetPlayer && resetPlayer.spellCooldowns) {
            delete resetPlayer.spellCooldowns[spell_id];
            cooldownManager.deleteCooldown(resetPlayer.username, spell_id);
            playerCache.set(resetPlayer.id, resetPlayer);
          }
          listener.emit(Events.SPELL_FAILED, { player: currentPlayer, target, spellName: spell.name, reason: "unknown" } as any);
          return;
        }

        if (target.id !== currentPlayer.id) {
          const liveParticleCache = await readHeldList<Particle>("particles"); // held list: only read
          const resolvedParticles = resolveSpellParticles(spell, liveParticleCache);
          // Anyone who sees the caster or the target gets the projectile.
          broadcastStatsUpdateToAOI(
            target,
            currentPlayer,
            packetManager.projectile({
              id: currentPlayer.id,
              time: delay / 1000,
              target_id: target.id,
              spell: spell.name,
              icon: getIconUrl(spell.icon),
              entity: false,
              particles: resolvedParticles,
            })
          );
        }
        await new Promise((resolve) => setTimeout(resolve, delay));

        const attackerDamageBonus = currentPlayer.stats.stat_damage || 0;
        let finalDamage: number;
        let isCrit: boolean;
        if (spell_damage < 0) {
          // WoW-style heal: level roll + cast-time share of the damage stat,
          // 150% on a crit. Negative = healing.
          const heal = rollHeal(spell_damage, currentPlayer.stats, spell.cast_time);
          finalDamage = -heal.amount;
          isCrit = heal.isCrit;
        } else {
          const baseDamage = Math.floor(Math.random() * ((playerLevel - 1) * 3 + 1)) + spell_damage + (playerLevel - 1) * 2 + attackerDamageBonus;
          const critDamage = currentPlayer.stats.stat_critical_damage || 0;
          isCrit = Math.random() * 100 < (currentPlayer.stats.stat_critical_chance || 0);
          finalDamage = isCrit ? Math.floor(baseDamage * (1 + critDamage / 100)) : baseDamage;
        }

        // Utility/effect-only spells (base damage 0) never deal damage and skip avoidance/armor
        if (spell_damage === 0) finalDamage = 0;

        log.debug(`[ATTACK] Damage calculation: spell=${spell_damage}, bonus=${attackerDamageBonus}, crit=${isCrit}, final=${finalDamage}`);

        if (finalDamage > 0) {
          const targetAvoidance = target.stats?.stat_avoidance || 0;
          const avoidanceRoll = Math.random() * 100;
          if (avoidanceRoll < targetAvoidance) {
            finalDamage = 0;
          }

          if (finalDamage > 0) {
            const targetArmor = target.stats?.stat_armor || 0;
            const armorReduction = Math.min(targetArmor, 75) / 100;
            finalDamage = Math.floor(finalDamage * (1 - armorReduction));
          }
        }

        const finalManaCheck = playerCache.get(currentPlayer.id);
        if (!finalManaCheck || (finalManaCheck.stats.stamina || 0) < actualManaCost) {

          if (finalManaCheck && finalManaCheck.spellCooldowns) {
            delete finalManaCheck.spellCooldowns[spell_id];
            cooldownManager.deleteCooldown(finalManaCheck.username, spell_id);
            playerCache.set(finalManaCheck.id, finalManaCheck);
          }
          return;
        }

        currentPlayer.stats.stamina = finalManaCheck.stats.stamina;
        currentPlayer.stats.stamina -= actualManaCost;

        if (currentPlayer.stats.stamina < 0) {
          currentPlayer.stats.stamina = 0;
        }

        // False only when a mirrored target's owner refused the hit or did not answer: nothing landed.
        let remoteLanded = true;
        if (target.remote) {
          // A player of a neighbouring node: its owner checks no-PvP and immunity, and applies the hit (spec §4).
          // A dodged damage spell is still harmful: the target is flagged and the attack recorded, as a local one is.
          remoteLanded = await hitRemotePlayer(currentPlayer, target, remoteHit(currentPlayer, spell, finalDamage, isCrit, {
            skipEffects: spell_damage > 0 && finalDamage === 0,
            showsDamage: spell_damage !== 0,
            harmful: spell_damage > 0 || spellIsHostileEffect,
          }));
          // Always send caster's stats (mana change)
          broadcastToAOIBestEffort(currentPlayer, packetManager.updateStats({ id: currentPlayer.id, target: currentPlayer.id, stats: currentPlayer.stats }));
          sendStatsToPartyMembers(currentPlayer.username, currentPlayer.id, currentPlayer.stats);
        } else {
          // Apply damage to player target
          // Add if negative damage (healing) to current health, subtract positive damage
          // Positive damage is first absorbed by absorbtion, remainder hits health
          // Corpses awaiting release can neither be damaged further nor healed;
          // only the release + revive flow changes their state.
          if (target.isDead) {
            return;
          }
          let damageToHealth = finalDamage;
          if (finalDamage > 0) {
            const absorbed = spellEffects.consumeBarrier(target, finalDamage);
            damageToHealth = finalDamage - absorbed;
            if (absorbed > 0) {
              spellEffects.broadcastEffectsUpdate(target);
            }
          }
          target.stats.health = Math.round(target.stats.health - damageToHealth);
          if (finalDamage < 0) {
            listener.emit(Events.PLAYER_HEALED, { caster: currentPlayer, target, amount: Math.abs(finalDamage), source: spell.name } as any);
          }
          listener.emit(Events.PLAYER_DAMAGED, { attacker: currentPlayer, target, damage: finalDamage, isCrit });

          playerCache.set(currentPlayer.id, currentPlayer);

          if (target.stats.health > target.stats.total_max_health) {
            target.stats.health = target.stats.total_max_health;
          }

          if (target.stats.health <= 0) {

          await handlePlayerDeath(target, currentPlayer, { damage: finalDamage, isCrit });
        } else {

          const broadcastStats = (p: any) => {
            const pls = filterPlayersByMap(p.location.map).filter((pl: any) => {
              if (pl.id === p.id) return true;
              if (p.isVanished && !pl.isAdmin && !pl.party?.includes(p.username)) return false;
              return true;
            });
            pls.forEach((pl: any) =>
              sendPacket(pl.wt, packetManager.updateStats({ id: p.id, target: p.id, stats: p.stats }))
            );
            sendStatsToPartyMembers(p.username, p.id, p.stats);
          };
          const broadcastEffects = (p: any) => {
            spellEffects.broadcastEffectsUpdate(p);
          };
          // If the attack was dodged (spell deals damage but 0 got through), skip effects
          let effectResult: any = {};
          if (!(spell_damage > 0 && finalDamage === 0)) {
            effectResult = await spellEffects.applySpellEffects(spell, currentPlayer, target, broadcastStats, broadcastEffects);
          }

          // Vanish despawn - must happen in receiver, same pattern as admin stealth
          if (Array.isArray(spell.effects) && spell.effects.some((e: SpellEffect) => e.type === "vanish") && target.isVanished) {
            findPlayersWithTargetInAOI(target.id).forEach((player) => {
              if (player.id === target.id) return;
              if (player.isAdmin) return;
              if (player.party?.includes(target.username)) return;
              forgetLook(player.wt, String(target.id));
              sendPacket(player.wt, packetManager.despawnPlayer(target.id));
            });
          }

          // Utility spells (damage=0) don't show damage numbers
          if (spell_damage !== 0) {
          broadcastStatsUpdateToAOI(
            target,
            currentPlayer,
            packetManager.updateStats({
              id: wt.data.id,
              target: target.id,
              stats: target.stats,
              isCrit: isCrit,
              damage: finalDamage,
              absorb: effectResult.absorb || 0,
            })
          );
          }

          // Always send caster's stats (mana change)
          broadcastToAOIBestEffort(
            currentPlayer,
            packetManager.updateStats({
              id: currentPlayer.id,
              target: currentPlayer.id,
              stats: currentPlayer.stats,
            })
          );

          sendStatsToPartyMembers(target.username, target.id, target.stats);
          sendStatsToPartyMembers(currentPlayer.username, currentPlayer.id, currentPlayer.stats);
        }
        }

        // Update attacker stats regardless of target type
        playerCache.set(currentPlayer.id, currentPlayer);

        // The owner of a mirrored target refused the hit or did not answer: no PvP flag, cast event or splash.
        if (!remoteLanded) break;

        // Is not in the targets party and is not self, then set PvP flag on both
        if (!isInParty && !isSelf) {
          setPlayerPvp(currentPlayer, true);
          setPlayerPvp(target, true);
        }

        currentPlayer.last_attack = performance.now();
        // A mirror is never written here; its owner set its last attack when the hit landed.
        if (!target.remote) target.last_attack = performance.now();

        // Attacking breaks vanish (but not DoT ticks - this is a direct cast)
        if (currentPlayer.isVanished && !isSelf && !isInParty) {
          const vanishId = spellEffects.getVanishedEffectId(currentPlayer);
          if (vanishId) {
            cancelEffect(currentPlayer, vanishId);
            spellEffects.broadcastEffectsUpdate(currentPlayer);
          }
        }
        listener.emit(Events.SPELL_CAST, { player: currentPlayer, spellName: spell.name, target, isEntityTarget: false });

        // AoE splash: apply damage and effects to all valid targets within aoe_radius
        // of the primary target (excluding the primary target itself).
        const aoeRadius = spell?.aoe_radius;
        if (aoeRadius && aoeRadius > 0) {
          const splashTargets: Array<{ target: any; distance: number }> = [];

          // Collect nearby players: same layer only, and only the crowd within
          // the radius of the target.
          for (const p of playersAndMirrorsNear(targetX, targetY, currentPlayer.location.map, aoeRadius, layerManager.getPlayerLayer(currentPlayer.id))) {
            // A mirror (another node's player) passes the same checks; its hit goes to its owner below.
            if (p.id === target.id) continue;
            if (p.isGuest) continue;
            // Ghosts cannot be damaged or healed.
            if (p.isGhost) continue;
            // An admin in stealth is out of the game for everyone else: no spell touches them.
            if (p.isStealth) continue;
            if (isInParty && currentPlayer?.party?.includes(p?.username)) continue;
            const pPos = p.location?.position;
            if (!pPos) continue;
            const dist = Math.sqrt((pPos.x - targetX) ** 2 + (pPos.y - targetY) ** 2);
            if (dist > aoeRadius) continue;
            // The target passed player.canAttack; the players beside it are asked the same about no-PvP zones.
            if ((spell_damage > 0 || spellIsHostileEffect) && !(await areaSpellHarms(currentPlayer.location.position, pPos, pvpAllowed))) continue;
            splashTargets.push({ target: p, distance: dist });
          }

          // Creatures near the target take the splash too.
          splashCreatures(currentPlayer, spell, targetX, targetY, aoeRadius, null);

          // Hits on mirrors, sent to their owners after the local victims are done.
          const remoteHits: Promise<boolean>[] = [];
          for (const splash of splashTargets) {
            const splashTarget = splash.target;

            // AoE damage: independent roll per target (same formula as primary)
            // Heals: WoW-style roll (negative = healing); damage: level roll + damage stat.
            let splashDmg = spell_damage < 0
              ? -rollHeal(spell_damage, currentPlayer.stats, spell.cast_time).amount
              : Math.floor(Math.random() * ((playerLevel - 1) * 3 + 1)) + spell_damage + (playerLevel - 1) * 2 + attackerDamageBonus;
            if (spell_damage === 0) splashDmg = 0;

            if (splashDmg > 0) {
              const splashAvoid = splashTarget.stats?.stat_avoidance || 0;
              if (Math.random() * 100 < splashAvoid) splashDmg = 0;
              if (splashDmg > 0) {
                const splashArmor = splashTarget.stats?.stat_armor || 0;
                splashDmg = Math.floor(splashDmg * (1 - Math.min(splashArmor, 75) / 100));
              }
            }

            // A player of a neighbouring node: its owner checks no-PvP and immunity, and applies the hit (spec §4).
            if (routeSplashToMirror(remoteHits, currentPlayer, splashTarget, spell, splashDmg, { showsDamage: true, harmful: spell_damage > 0 || spellIsHostileEffect })) continue;

            {
              let splashToHealth = splashDmg;
              if (splashDmg > 0) {
                const absorbed = spellEffects.consumeBarrier(splashTarget, splashDmg);
                splashToHealth = splashDmg - absorbed;
                if (absorbed > 0) spellEffects.broadcastEffectsUpdate(splashTarget);
              }
              splashTarget.stats.health = Math.round(splashTarget.stats.health - splashToHealth);
              listener.emit(Events.PLAYER_DAMAGED, { attacker: currentPlayer, target: splashTarget, damage: splashDmg, isCrit: false });

              if (splashTarget.stats.health <= 0) {
                await handlePlayerDeath(splashTarget, currentPlayer, { damage: splashDmg, isCrit: false });
              } else {
                await spellEffects.applySpellEffects(spell, currentPlayer, splashTarget,
                  (p: any) => broadcastStatsUpdateToAOI(p, currentPlayer, packetManager.updateStats({ id: p.id, target: p.id, stats: p.stats })),
                  (p: any) => spellEffects.broadcastEffectsUpdate(p)
                );

                broadcastStatsUpdateToAOI(
                  splashTarget,
                  currentPlayer,
                  packetManager.updateStats({
                    id: wt.data.id,
                    target: splashTarget.id,
                    stats: splashTarget.stats,
                    isCrit: false,
                    damage: splashDmg,
                  })
                );
              }

              if (!isInParty) {
                setPlayerPvp(currentPlayer, true);
                setPlayerPvp(splashTarget, true);
                splashTarget.last_attack = performance.now();
              }
            }
          }

          // The hits on mirrors go to their owners together, so one dead link delays none of the others.
          if (remoteHits.length) await Promise.allSettled(remoteHits);
        }

        break;
      }

      case "CANCEL_SPELL": {
        if (!currentPlayer) return;

        // Only process if actually casting
        if (!currentPlayer.casting) return;

        // Treat ESC cancel as spell interruption
        broadcastCastToAOI(
          currentPlayer,
          packetManager.castSpell({ id: currentPlayer.id, spell: 'interrupted', time: 1 })
        );
        clearGroundPreviewForAOI(currentPlayer, packetManager.groundAoeDespawn({ id: currentPlayer.id + "_casting" }));

        bumpStateRevision();
        await sendPositionAnimation(
          wt,
          currentPlayer.location.position?.direction || "down",
          currentPlayer.moving || false,
          currentPlayer.mounted,
          currentPlayer.mount_type || "unicorn",
          undefined,
          stateRevision(),
          false
        );

        // Mark this as a manual cancel (not a movement interrupt)
        // Don't set lastInterruptTime to allow immediate recast
        currentPlayer.casting = false;
        currentPlayer.castId = (currentPlayer.castId || 0) + 1;
        currentPlayer.manualSpellCancel = performance.now();

        if (currentPlayer.castingSpellId && currentPlayer.spellCooldowns) {
          delete currentPlayer.spellCooldowns[currentPlayer.castingSpellId];
          cooldownManager.deleteCooldown(currentPlayer.username, currentPlayer.castingSpellId);
          currentPlayer.castingSpellId = undefined;
        }

        // Also update in playerCache so spell execution can detect it
        const cachedPlayer = playerCache.get(currentPlayer.id);
        if (cachedPlayer) {
          cachedPlayer.casting = false;
          cachedPlayer.castId = currentPlayer.castId;
          cachedPlayer.manualSpellCancel = performance.now();
          if (cachedPlayer.castingSpellId && cachedPlayer.spellCooldowns) {
            delete cachedPlayer.spellCooldowns[cachedPlayer.castingSpellId];
            cachedPlayer.castingSpellId = undefined;
          }
          playerCache.set(cachedPlayer.id, cachedPlayer);
        }

        log.debug(`[SPELL] Player ${currentPlayer.username} cancelled spell via ESC`);
        listener.emit(Events.SPELL_INTERRUPTED, { player: currentPlayer });
        break;
      }

      case "CANCEL_EFFECT": {
        if (!currentPlayer) return;
        const effectId = (data as any)?.id;
        if (!effectId) return;
        const removed = spellEffects.cancelEffect(currentPlayer, effectId);
        if (removed) {
          spellEffects.broadcastEffectsUpdate(currentPlayer);
          broadcastToAOIBestEffort(
            currentPlayer,
            packetManager.updateStats({ id: currentPlayer.id, target: currentPlayer.id, stats: currentPlayer.stats })
          );
        }
        break;
      }
  }
}
