import * as classEditor from "../../systems/classeditor";
import * as controlPanel from "../../systems/controlpanel";
import * as itemEditor from "../../systems/itemeditor";
import * as lootEditor from "../../systems/looteditor";
import * as mailboxEditor from "../../systems/mailboxeditor";
import * as mountEditor from "../../systems/mounteditor";
import * as playerEditor from "../../systems/playereditor";
import * as questEditor from "../../systems/quests/editor";
import * as spellEditor from "../../systems/spelleditor";
import * as weatherEditor from "../../systems/weathereditor";
import { clusterDebugSource } from "../../cluster/index";
import { buildClusterDebug, debugRateLimit } from "../../cluster/nodedebug";
import achievements from "../../systems/achievements";
import assetCache from "../../services/assetCache";
import creatures from "../../systems/creatures";
import fishing from "../../systems/fishing";
import footprints from "../../systems/footprints";
import gathering from "../../systems/gathering";
import log from "../../modules/logger";
import lootTable from "../../systems/lootTable";
import npcSystem from "../../systems/npcs";
import particles, { renameInList } from "../../systems/particles";
import permissions from "../../systems/permissions";
import player, { clearMapCache } from "../../systems/player.ts";
import playerCache from "../../services/playermanager.ts";
import { addCreatedMap } from "../../modules/assetloader";
import { getWorldMap, refreshWorldMap } from "../../modules/worldmaps";
import { mayCreateMaps, readCreateMap, requestCreateMap } from "../../systems/mapcreate";
import { mayEditTileSounds, readTileSoundChanges, saveTileSounds } from "../../systems/tilesounds";
import { packetManager } from "../packet_manager";
import { saveMapChunks, saveMapProperties, applyChunksWithRebase } from "../../modules/assetloader";
import { serverFetch } from "../../modules/https_servers.ts";
import { updatePlayerAOI, shouldUpdateAOI, broadcastToAOI } from "../aoi";
import { activeEditorsByMap, bumpStateRevision, despawnBatchQueue, editorEditHistory, filterPlayersByMap, mailboxEditorWorld, mapPropertiesCache, maps, resyncNpcChunks, runForControlPanel, sendMailboxes, sendPacket, spawnBatchQueue, stateRevision, teleportPlayerWrapper, transitionPlayerToMap } from "../receiver";
import type { PacketContext } from "./context";

// Packet handlers moved from receiver.ts's packetReceiver switch (phase 6, Task 1). The case bodies are unchanged.

export const handles: ReadonlySet<string> = new Set(["EDITOR_TILE_EDIT", "EDITOR_LAYER_LOCK", "EDITOR_OPEN", "EDITOR_CLOSE", "CREATURE_EDITOR_LIST", "CREATURE_EDITOR_CLOSE", "CREATURE_EDITOR_SAVE_TEMPLATE", "CREATURE_EDITOR_DELETE_TEMPLATE", "CREATURE_EDITOR_SAVE_ABILITY", "CREATURE_EDITOR_DELETE_ABILITY", "CREATURE_EDITOR_SAVE_ABILITIES", "CREATURE_EDITOR_SAVE_SPAWN", "CREATURE_EDITOR_DELETE_SPAWN", "CREATURE_EDITOR_SAVE_PATH", "CREATURE_EDITOR_DELETE_PATH", "CREATURE_EDITOR_SAVE_LINKGROUP", "CREATURE_EDITOR_DELETE_LINKGROUP", "CREATURE_EDITOR_SAVE_POOL", "CREATURE_EDITOR_DELETE_POOL", "CREATURE_EDITOR_ACTION", "ITEM_EDITOR_LIST", "ITEM_EDITOR_SEARCH", "ITEM_EDITOR_SAVE", "ITEM_EDITOR_DELETE", "MOUNT_EDITOR_LIST", "MOUNT_EDITOR_SAVE", "MOUNT_EDITOR_DELETE", "SPELL_EDITOR_LIST", "SPELL_EDITOR_SEARCH", "SPELL_EDITOR_SAVE", "SPELL_EDITOR_DELETE", "SPELL_EDITOR_LEARN", "WEATHER_EDITOR_LIST", "WEATHER_EDITOR_SAVE", "WEATHER_EDITOR_DELETE", "CLASS_EDITOR_LIST", "CLASS_EDITOR_SAVE", "CLASS_EDITOR_DELETE", "LOOT_EDITOR_CREATE_TABLE", "LOOT_EDITOR_DELETE_TABLE", "LOOT_EDITOR_ADD_ITEM", "LOOT_EDITOR_REMOVE_ITEM", "LOOT_EDITOR_UPDATE_ITEM", "PLAYER_EDITOR_LOAD", "PLAYER_EDITOR_SEARCH", "PLAYER_EDITOR_ACTION", "CONTROL_PANEL_LOAD", "CONTROL_PANEL_QUERY", "CONTROL_PANEL_ACTION", "CREATURE_DEBUG_SUBSCRIBE", "CLUSTER_DEBUG", "TOGGLE_QUEST_EDITOR", "QUEST_EDITOR_DATA", "QUEST_EDITOR_SEARCH", "QUEST_EDITOR_SAVE", "QUEST_EDITOR_DELETE", "QUEST_EDITOR_CLOSE", "CREATE_MAP", "SAVE_TILE_SOUNDS", "SAVE_TILE_FOOTPRINTS", "SAVE_MAP", "SAVE_PARTICLE", "DELETE_PARTICLE", "RENAME_PARTICLE", "LIST_PARTICLES", "TEST_PARTICLE", "FISHING_EDITOR_LIST", "FISHING_EDITOR_SAVE", "MAILBOX_EDITOR_LIST", "MAILBOX_EDITOR_SAVE", "MAILBOX_EDITOR_DELETE", "ACHIEVEMENT_EDITOR_LIST", "ACHIEVEMENT_EDITOR_SAVE", "ACHIEVEMENT_EDITOR_DELETE", "GATHERING_EDITOR_LIST", "GATHERING_EDITOR_SAVE", "GATHERING_EDITOR_DELETE", "GATHERING_EDITOR_PREVIEW", "LIST_LOOT_TABLES"]);

export async function handle(ctx: PacketContext): Promise<unknown> {
  const { currentPlayer, data, type, wt } = ctx;
  switch (type) {

      case "EDITOR_TILE_EDIT": {
        // Relay live tile edits from one admin/editor to other admins editing the
        // same map so concurrent editors stay in sync (no save-time clobbering).
        if (!currentPlayer || !currentPlayer.isAdmin) return;
        const editData = data as any;
        if (!editData || !Array.isArray(editData.edits)) return;

        const mapName = editData.mapName;
        if (mapName) {
          // Store in history so new editors can sync unsaved work
          if (!editorEditHistory.has(mapName)) {
            editorEditHistory.set(mapName, []);
          }
          editorEditHistory.get(mapName)!.push({ senderId: wt.data.id, mapName, edits: editData.edits });
        }

        const targets = filterPlayersByMap(currentPlayer.location.map).filter(
          (p) => p.isAdmin && p.id !== wt.data.id && p.wt?.readyState === 1
        );
        if (targets.length === 0) break;
        const relay = { senderId: wt.data.id, mapName: editData.mapName, edits: editData.edits };
        targets.forEach((player) => {
          sendPacket(player.wt, packetManager.editorTileEdit(relay));
        });
        break;
      }

      case "EDITOR_LAYER_LOCK": {
        // Relay layer lock/unlock changes to other admins on the same map.
        if (!currentPlayer || !currentPlayer.isAdmin) return;
        const lockData = data as any;
        if (!lockData || lockData.mapName !== currentPlayer.location.map) return;
        const targets = filterPlayersByMap(currentPlayer.location.map).filter(
          (p) => p.isAdmin && p.id !== wt.data.id && p.wt?.readyState === 1
        );
        if (targets.length === 0) break;
        const relay = { mapName: lockData.mapName, layerName: lockData.layerName, locked: lockData.locked };
        targets.forEach((player) => {
          sendPacket(player.wt, packetManager.editorLayerLock(relay));
        });
        break;
      }

      case "EDITOR_OPEN": {
        if (!currentPlayer) return;
        const mapName = currentPlayer.location.map;
        // Live sync between editors is for admins. Anyone else who may open the editor (tools.tile_editor) still
        // has to be answered: their editor waits for this before it opens, and waited for good without it.
        if (!currentPlayer.isAdmin) {
          sendPacket(wt, packetManager.editorSyncReady({ mapName }));
          break;
        }
        if (!activeEditorsByMap.has(mapName)) {
          activeEditorsByMap.set(mapName, new Set());
        }
        activeEditorsByMap.get(mapName)!.add(wt.data.id);

        // Replay all unsaved edits as one batch.
        const history = editorEditHistory.get(mapName);
        if (history && history.length > 0) {
          const allEdits: any[] = [];
          for (const entry of history) {
            if (!Array.isArray(entry.edits)) continue;
            for (const edit of entry.edits) {
              allEdits.push(edit);
            }
          }
          if (allEdits.length > 0) {
            sendPacket(wt, packetManager.editorTileEdit({ mapName, edits: allEdits }));
          }
        }

        sendPacket(wt, packetManager.editorSyncReady({ mapName }));
        break;
      }

      case "EDITOR_CLOSE": {
        if (!currentPlayer || !currentPlayer.isAdmin) return;
        // Every map this connection edits, not only the one the player is on: an editor that closes because its
        // player walked through a warp says so once the player is already on the next map, and the map it was
        // editing would keep them as an editor, and its unsaved edits, until they left the game.
        for (const [mapName, editors] of activeEditorsByMap.entries()) {
          if (!editors.delete(wt.data.id)) continue;
          if (editors.size === 0) {
            activeEditorsByMap.delete(mapName);
            // No editors left on this map - clear unsaved edit history
            editorEditHistory.delete(mapName);
          }
        }
        break;
      }

      case "CREATURE_EDITOR_LIST":
      case "CREATURE_EDITOR_CLOSE":
      case "CREATURE_EDITOR_SAVE_TEMPLATE":
      case "CREATURE_EDITOR_DELETE_TEMPLATE":
      case "CREATURE_EDITOR_SAVE_ABILITY":
      case "CREATURE_EDITOR_DELETE_ABILITY":
      case "CREATURE_EDITOR_SAVE_ABILITIES":
      case "CREATURE_EDITOR_SAVE_SPAWN":
      case "CREATURE_EDITOR_DELETE_SPAWN":
      case "CREATURE_EDITOR_SAVE_PATH":
      case "CREATURE_EDITOR_DELETE_PATH":
      case "CREATURE_EDITOR_SAVE_LINKGROUP":
      case "CREATURE_EDITOR_DELETE_LINKGROUP":
      case "CREATURE_EDITOR_SAVE_POOL":
      case "CREATURE_EDITOR_DELETE_POOL":
      case "CREATURE_EDITOR_ACTION": {
        if (!currentPlayer) return;
        // Permission is re-checked on every editor packet, not just on /ce.
        if (!creatures.canUseEditor(currentPlayer)) {
          sendPacket(wt, packetManager.notify({ message: "You don't have permission to use the creature editor." }));
          break;
        }
        const result = await creatures.handleEditorPacket(currentPlayer, type, data);
        if (result.kind === "data") {
          sendPacket(wt, packetManager.creatureEditorData(result.data));
          break;
        }
        if (result.kind === "goto" && result.goto) {
          const destMap = String(result.goto.map).replace(".json", "");
          const currentMap = String(currentPlayer.location?.map ?? "").replace(".json", "");
          if (destMap === currentMap) {
            // Already on that map: move there like an admin teleport, without
            // reloading the map (a reload wipes everything the client shows).
            const direction = currentPlayer.location.position?.direction || "down";
            currentPlayer.location.position = {
              ...currentPlayer.location.position,
              x: Math.round(Number(result.goto.x)),
              y: Math.round(Number(result.goto.y)),
              direction,
            };
            bumpStateRevision();
            if (shouldUpdateAOI(currentPlayer)) {
              await updatePlayerAOI(currentPlayer, spawnBatchQueue, despawnBatchQueue);
            }
            broadcastToAOI(currentPlayer, packetManager.moveXY({
              i: wt.data.id,
              d: { x: currentPlayer.location.position.x, y: currentPlayer.location.position.y, dr: direction },
              r: stateRevision(),
              s: currentPlayer.isStealth ? 1 : 0,
            }), true);
            await resyncNpcChunks(currentPlayer, wt);
          } else {
            await teleportPlayerWrapper(currentPlayer, result.goto.map, result.goto.x, result.goto.y);
          }
          sendPacket(wt, packetManager.creatureEditorResult({ ok: true, errors: [], action: type }));
          break;
        }
        if (result.kind === "result") {
          sendPacket(wt, packetManager.creatureEditorResult({ ok: result.ok, errors: result.errors, id: result.id, action: type }));
          if (result.ok) {
            const updated = packetManager.creatureEditorUpdated({ by: currentPlayer.username });
            for (const viewerId of creatures.editorViewerIds()) {
              if (viewerId === currentPlayer.id) continue;
              const viewer = playerCache.get(viewerId);
              if (viewer?.wt) sendPacket(viewer.wt, updated);
            }
          }
        }
        break;
      }

      case "ITEM_EDITOR_LIST":
      case "ITEM_EDITOR_SEARCH":
      case "ITEM_EDITOR_SAVE":
      case "ITEM_EDITOR_DELETE": {
        if (!currentPlayer) return;
        // Permission is re-checked on every editor packet, not just on /ie.
        if (!itemEditor.canUseEditor(currentPlayer)) {
          sendPacket(wt, packetManager.notify({ message: "You don't have permission to use the item editor." }));
          break;
        }
        const result = await itemEditor.handleEditorPacket(type, data);
        if (result.kind === "data") {
          sendPacket(wt, packetManager.itemEditorData(result.data));
          break;
        }
        if (result.kind === "search") {
          sendPacket(wt, packetManager.itemEditorResults(result.data));
          break;
        }
        sendPacket(wt, packetManager.itemEditorResult({ ok: result.ok, errors: result.errors, name: result.name, action: type }));
        if (result.ok) {
          // Items are cached per process; tell every other editor to reload.
          const updated = packetManager.itemEditorUpdated({ by: currentPlayer.username });
          for (const other of Object.values(playerCache.list()) as any[]) {
            if (!other?.wt || other.id === currentPlayer.id) continue;
            if (itemEditor.canUseEditor(other)) sendPacket(other.wt, updated);
          }
        }
        break;
      }

      case "MOUNT_EDITOR_LIST":
      case "MOUNT_EDITOR_SAVE":
      case "MOUNT_EDITOR_DELETE": {
        if (!currentPlayer) return;
        // The handler checks permission first, on every one of these, not just on /mounteditor.
        const result = await mountEditor.handleEditorPacket(currentPlayer, type, data);
        if (result.kind === "data") {
          sendPacket(wt, packetManager.mountEditorData(result.data));
          break;
        }
        if (result.denied) sendPacket(wt, packetManager.notify({ message: mountEditor.DENIED }));
        sendPacket(wt, packetManager.mountEditorResult({ ok: result.ok, errors: result.errors, fields: result.fields, name: result.name, action: type, data: result.data }));
        if (result.changed) {
          // Mounts are cached per process; tell every other editor to reload.
          const updated = packetManager.mountEditorUpdated({ by: currentPlayer.username });
          for (const other of Object.values(playerCache.list()) as any[]) {
            if (!other?.wt || other.id === currentPlayer.id) continue;
            if (mountEditor.canUseEditor(other)) sendPacket(other.wt, updated);
          }
        }
        break;
      }

      case "SPELL_EDITOR_LIST":
      case "SPELL_EDITOR_SEARCH":
      case "SPELL_EDITOR_SAVE":
      case "SPELL_EDITOR_DELETE":
      case "SPELL_EDITOR_LEARN": {
        if (!currentPlayer) return;
        // The handler checks permission first, against the database, on every one of these.
        const result = await spellEditor.handleEditorPacket(currentPlayer, type, data);
        if (result.kind === "data") {
          sendPacket(wt, packetManager.spellEditorData(result.data));
          break;
        }
        if (result.kind === "search") {
          sendPacket(wt, packetManager.spellEditorResults(result.data));
          break;
        }
        if (result.denied) sendPacket(wt, packetManager.notify({ message: spellEditor.DENIED }));
        sendPacket(wt, packetManager.spellEditorResult({
          ok: result.ok, errors: result.errors, fields: result.fields, name: result.name, action: type,
        }));
        if (result.ok && result.changed) {
          // Spells are cached per process; tell every other editor to reload.
          const updated = packetManager.spellEditorUpdated({ by: currentPlayer.username });
          for (const other of Object.values(playerCache.list()) as any[]) {
            if (!other?.wt || other.id === currentPlayer.id) continue;
            if (spellEditor.mayHaveEditorOpen(other)) sendPacket(other.wt, updated);
          }
        }
        break;
      }

      case "WEATHER_EDITOR_LIST":
      case "WEATHER_EDITOR_SAVE":
      case "WEATHER_EDITOR_DELETE": {
        if (!currentPlayer) return;
        // The handler checks permission first, on every one of these. A change is shown by it to the players
        // of each world that shows that weather, and its answer carries the weathers as they then stand.
        const result = await weatherEditor.handleEditorPacket(currentPlayer, type, data);
        if (result.kind === "data") {
          sendPacket(wt, packetManager.weatherEditorData(result.data));
          break;
        }
        if (result.denied) sendPacket(wt, packetManager.notify({ message: weatherEditor.DENIED }));
        sendPacket(wt, packetManager.weatherEditorResult({
          ok: result.ok, errors: result.errors, fields: result.fields, name: result.name, notes: result.notes, action: type, data: result.data,
        }));
        if (result.changed) {
          // Tell every other open editor to ask for the weathers again.
          const updated = packetManager.weatherEditorUpdated({ by: currentPlayer.username });
          for (const other of Object.values(playerCache.list()) as any[]) {
            if (!other?.wt || other.id === currentPlayer.id) continue;
            if (weatherEditor.mayHaveEditorOpen(other)) sendPacket(other.wt, updated);
          }
        }
        break;
      }

      case "CLASS_EDITOR_LIST":
      case "CLASS_EDITOR_SAVE":
      case "CLASS_EDITOR_DELETE": {
        if (!currentPlayer) return;
        // The handler checks permission first, on every one of these; its answer carries the classes as they stand.
        const result = await classEditor.handleEditorPacket(currentPlayer, type, data);
        if (result.kind === "data") {
          sendPacket(wt, packetManager.classEditorData(result.data));
          break;
        }
        if (result.denied) sendPacket(wt, packetManager.notify({ message: classEditor.DENIED }));
        sendPacket(wt, packetManager.classEditorResult({
          ok: result.ok, errors: result.errors, fields: result.fields, name: result.name, notes: result.notes, action: type, data: result.data,
        }));
        if (result.changed) {
          // Tell every other open editor to ask for the classes again.
          const updated = packetManager.classEditorUpdated({ by: currentPlayer.username });
          for (const other of Object.values(playerCache.list()) as any[]) {
            if (!other?.wt || other.id === currentPlayer.id) continue;
            if (classEditor.mayHaveEditorOpen(other)) sendPacket(other.wt, updated);
          }
        }
        break;
      }

      case "LOOT_EDITOR_CREATE_TABLE":
      case "LOOT_EDITOR_DELETE_TABLE":
      case "LOOT_EDITOR_ADD_ITEM":
      case "LOOT_EDITOR_REMOVE_ITEM":
      case "LOOT_EDITOR_UPDATE_ITEM": {
        if (!currentPlayer) return;
        // The handler checks permission first, on every one of these, and its
        // answer says whether the change was made and how the tables now stand.
        const result = await lootEditor.handleEditorPacket(currentPlayer, type, data);
        sendPacket(wt, packetManager.lootEditorResult({ ...result, action: type }));
        break;
      }

      case "PLAYER_EDITOR_LOAD":
      case "PLAYER_EDITOR_SEARCH":
      case "PLAYER_EDITOR_ACTION": {
        if (!currentPlayer) return;
        // The handler checks permission first, against the database, on every one of these.
        const result = await playerEditor.handleEditorPacket(currentPlayer, type, data);
        if (result.kind === "data") {
          sendPacket(wt, packetManager.playerEditorData(result.data));
          break;
        }
        if (result.kind === "search") {
          sendPacket(wt, packetManager.playerEditorResults(result.data));
          break;
        }
        if (result.denied) sendPacket(wt, packetManager.notify({ message: playerEditor.DENIED }));
        sendPacket(wt, packetManager.playerEditorResult({ ok: result.ok, errors: result.errors, action: result.action, snapshot: result.snapshot }));
        break;
      }

      case "CONTROL_PANEL_LOAD":
      case "CONTROL_PANEL_QUERY":
      case "CONTROL_PANEL_ACTION": {
        if (!currentPlayer) return;
        // The handler checks who is asking first, on every one of these. An
        // action is one of the admin commands: it is run by this receiver.
        const result = await controlPanel.handlePanelPacket(currentPlayer, type, data, (run) => runForControlPanel(wt, run));
        if (result.kind === "data") {
          sendPacket(wt, packetManager.controlPanelData(result.data));
          break;
        }
        if (result.kind === "results") {
          sendPacket(wt, packetManager.controlPanelResults(result.data));
          break;
        }
        sendPacket(wt, packetManager.controlPanelResult(result.data));
        break;
      }

      case "CREATURE_DEBUG_SUBSCRIBE": {
        if (!currentPlayer) return;
        if (!creatures.canUseEditor(currentPlayer)) return;
        creatures.setDebugSubscription(currentPlayer.id, !!(data as any)?.on);
        break;
      }

      // The "Cluster Nodes" overlay (F2 menu), open to any logged-in player: who owns which block of the map. Read-only, from memory; at
      // most one answer a second per connection, and a request over the rate gets none.
      case "CLUSTER_DEBUG": {
        if (!currentPlayer) return;
        if (!debugRateLimit.allow(wt)) return;
        sendPacket(wt, packetManager.clusterDebugData(buildClusterDebug(clusterDebugSource(), currentPlayer) as unknown as Record<string, unknown>));
        break;
      }

      case "TOGGLE_QUEST_EDITOR":
      case "QUEST_EDITOR_DATA":
      case "QUEST_EDITOR_SEARCH":
      case "QUEST_EDITOR_SAVE":
      case "QUEST_EDITOR_DELETE": {
        if (!currentPlayer) return;
        if (!questEditor.canUseEditor(currentPlayer)) {
          sendPacket(wt, packetManager.notify({ message: "You do not have permission to use the quest editor." }));
          break;
        }
        const outcome = await questEditor.handleEditorPacket(type, data);
        if (outcome.kind === "data") {
          sendPacket(wt, packetManager.questEditorData(outcome.data));
        } else if (outcome.kind === "search") {
          sendPacket(wt, packetManager.questEditorResults(outcome.data));
        } else {
          sendPacket(wt, packetManager.questEditorResult({ ok: outcome.ok, errors: outcome.errors, id: outcome.id }));
          if (outcome.ok && (type === "QUEST_EDITOR_SAVE" || type === "QUEST_EDITOR_DELETE")) {
            const viewers = Object.values(playerCache.list() as Record<string, any>).filter(
              (p) => p?.wt?.readyState === 1 && questEditor.canUseEditor(p)
            );
            for (const viewer of viewers) {
              if (viewer.id !== wt.data.id) {
                sendPacket(viewer.wt, packetManager.questEditorUpdated({ by: currentPlayer.username }));
              }
            }
          }
        }
        break;
      }

      case "QUEST_EDITOR_CLOSE": {
        break;
      }

      case "CREATE_MAP": {
        // The map editor's New map (systems/mapcreate.ts): made blank on the asset server, taken in here, then the
        // admin who asked is warped onto it (where /warp would put them: a world's spawn, a map's middle)
        if (!currentPlayer) return;
        const refuse = (message: string) => {
          sendPacket(wt, packetManager.notify({ message }));
          sendPacket(wt, packetManager.createMapFailed({ message }));
        };
        const userPermissions = await permissions.get(currentPlayer.username) as string;
        const perms = userPermissions.includes(",") ? userPermissions.split(",") : userPermissions.length ? [userPermissions] : [];
        if (!mayCreateMaps(perms)) {
          refuse("You do not have permission to create maps.");
          return;
        }
        const read = readCreateMap(data);
        if ("error" in read) {
          refuse(read.error);
          return;
        }
        const request = read.request;
        if ((maps as any[]).some((m: MapData) => m.name === `${request.name}.json`)) {
          refuse(`A map named ${request.name} already exists.`);
          return;
        }
        try {
          const made = await requestCreateMap(request);
          await addCreatedMap(request.name, made.kind, made.data);
          log.info(`Map ${request.name} created by ${currentPlayer.username} (${request.kind}, ${request.width} x ${request.height} tiles${request.infinite ? ", infinite" : ""})`);
        } catch (error: any) {
          log.error(`Error creating map ${request.name}: ${error.message}`);
          refuse(`Error creating the map: ${error.message}`);
          return;
        }
        const props = mapPropertiesCache.find((m: any) => m.name === `${request.name}.json`);
        const arrival = {
          x: props?.spawn ? props.spawn.x : props ? (props.width * props.tileWidth) / 2 : 0,
          y: props?.spawn ? props.spawn.y : props ? (props.height * props.tileHeight) / 2 : 0,
          direction: currentPlayer.location.position?.direction || "down",
        };
        const moved = await player.setLocation(currentPlayer.id, request.name, arrival);
        if (moved && typeof moved === "object" && "affectedRows" in moved && ((moved as { affectedRows: number | null; count?: number }).affectedRows ?? (moved as { count?: number }).count) != 0) {
          await transitionPlayerToMap(currentPlayer, request.name, arrival, wt, spawnBatchQueue, despawnBatchQueue);
          sendPacket(wt, packetManager.notify({ message: `Map ${request.name} created.` }));
        } else {
          refuse(`Map ${request.name} was created, but you could not be moved there. Use /warp ${request.name}.`);
        }
        break;
      }

      case "SAVE_TILE_SOUNDS": {
        // The map editor's Sounds tab (systems/tilesounds.ts): kept on the asset server, then sent to everyone online
        if (!currentPlayer) return;
        const userPermissions = await permissions.get(currentPlayer.username) as string;
        const perms = userPermissions.includes(",") ? userPermissions.split(",") : userPermissions.length ? [userPermissions] : [];
        if (!mayEditTileSounds(perms)) {
          sendPacket(wt, packetManager.notify({ message: "You do not have permission to change tile sounds." }));
          return;
        }
        const read = readTileSoundChanges(data);
        if ("error" in read) {
          sendPacket(wt, packetManager.notify({ message: read.error }));
          return;
        }
        try {
          const tilesets = await saveTileSounds(read.changes);
          log.info(`Tile sounds saved by ${currentPlayer.username}: ${read.changes.reduce((n, c) => n + c.ids.length, 0)} tiles`);
          for (const online of Object.values(playerCache.list()) as any[]) {
            if (online?.wt) sendPacket(online.wt, packetManager.tileSounds({ tilesets }));
          }
        } catch (error: any) {
          log.error(`Error saving tile sounds: ${error.message}`);
          sendPacket(wt, packetManager.notify({ message: `Error saving tile sounds: ${error.message}` }));
        }
        break;
      }

      case "SAVE_TILE_FOOTPRINTS": {
        // The map editor's Footprints tab (systems/footprints.ts): kept in tile_footprints, then sent to everyone online
        if (!currentPlayer) return;
        const userPermissions = await permissions.get(currentPlayer.username) as string;
        const perms = userPermissions.includes(",") ? userPermissions.split(",") : userPermissions.length ? [userPermissions] : [];
        if (!footprints.mayEditFootprints(perms)) {
          sendPacket(wt, packetManager.notify({ message: "You do not have permission to change tile footprints." }));
          return;
        }
        const read = footprints.readFootprintChanges(data);
        if ("error" in read) {
          sendPacket(wt, packetManager.notify({ message: read.error }));
          return;
        }
        try {
          const tilesets = await footprints.saveFootprints(read.changes);
          log.info(`Tile footprints saved by ${currentPlayer.username}: ${read.changes.reduce((n, c) => n + c.ids.length, 0)} tiles`);
          for (const online of Object.values(playerCache.list()) as any[]) {
            if (online?.wt) sendPacket(online.wt, packetManager.tileFootprints({ tilesets }));
          }
        } catch (error: any) {
          log.error(`Error saving tile footprints: ${error.message}`);
          sendPacket(wt, packetManager.notify({ message: `Error saving tile footprints: ${error.message}` }));
        }
        break;
      }

      case "SAVE_MAP": {
        if (!currentPlayer) return;

        const userPermissions = await permissions.get(currentPlayer.username) as string;
        const perms = userPermissions.includes(",") ? userPermissions.split(",") : userPermissions.length ? [userPermissions] : [];
        const hasPermission = perms.includes('server.admin') || perms.includes('server.*');

        if (!hasPermission) {
          sendPacket(wt, packetManager.notify({
            message: 'You do not have permission to save map changes.'
          }));
          return;
        }

        const saveData = data as unknown as { mapName: string, chunks: any[], graveyards?: any, warps?: any };

        // A world (modules/worldmaps.ts) holds no tiles here: the asset server writes the edited chunks into the
        // world's packs, then this server fetches the new collision and no-pvp bits. Its size is fixed, and its
        // warps and graveyards come from the map generator.
        if (typeof saveData?.mapName === "string" && getWorldMap(saveData.mapName)) {
          const worldName = saveData.mapName.replace(".json", "");
          try {
            // As for any map, a list of graveyards or warps is saved only when it holds something
            const hasChunks = Array.isArray(saveData.chunks) && saveData.chunks.length > 0;
            const graveyards = Array.isArray(saveData.graveyards) && saveData.graveyards.length > 0 ? saveData.graveyards : undefined;
            const warps = Array.isArray(saveData.warps) && saveData.warps.length > 0 ? saveData.warps : undefined;
            if (!hasChunks && !graveyards && !warps) {
              sendPacket(wt, packetManager.notify({ message: 'Nothing to save.' }));
              break;
            }
            log.info(`World save requested by ${currentPlayer.username} for ${worldName}, ${hasChunks ? saveData.chunks.length : 0} chunks modified`);
            const assetServerUrl = process.env.ASSET_SERVER_INTERNAL_URL || process.env.ASSET_SERVER_URL || "http://localhost:8081";
            const post = async (route: string, body: Record<string, unknown>) => {
              const response = await serverFetch(`${assetServerUrl}${route}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...body, mapName: worldName, serverId: process.env.SERVER_ID || "game-server", authKey: process.env.ASSET_SERVER_AUTH_KEY || process.env.GATEWAY_AUTH_KEY })
              });
              const result = await response.json().catch(() => ({ error: response.statusText })) as any;
              if (!response.ok || !result?.success) throw new Error(result?.error || `the asset server answered ${response.status}`);
              return result;
            };
            let changed: { chunkX: number; chunkY: number }[] = [];
            if (hasChunks) {
              const result = await post("/save-map-chunks", { chunks: saveData.chunks });
              changed = Array.isArray(result.changed) ? result.changed : [];
            }
            if (graveyards || warps) {
              await post("/save-map-properties", { graveyards, warps });
              // held here as for any map; movement reads the warps from its own cache, cleared below
              const propsList = await assetCache.get("mapProperties");
              const props = propsList?.find((m: any) => m.name === `${worldName}.json`);
              const world = getWorldMap(worldName);
              for (const target of [props, world?.properties]) {
                if (!target) continue;
                if (graveyards) target.graveyards = graveyards;
                if (warps) target.warps = warps;
              }
              if (propsList) await assetCache.add("mapProperties", propsList);
              clearMapCache(worldName);
            }
            if (changed.length > 0) fishing.forgetMap(worldName);
            if (changed.length > 0 || graveyards || warps) await refreshWorldMap(worldName);

            sendPacket(wt, packetManager.notify({
              message: `Map saved successfully! ${changed.length} chunks updated.`
            }));
            // The saver already shows its edits: the others on the map fetch the changed chunks again
            if (changed.length > 0) {
              filterPlayersByMap(currentPlayer.location.map)
                .filter((p) => p.id !== wt.data.id)
                .forEach((player) => {
                  sendPacket(player.wt, packetManager.updateChunks({ chunks: changed }));
                });
            }
          } catch (error: any) {
            log.error(`Error saving world ${worldName}: ${error.message}`);
            sendPacket(wt, packetManager.notify({
              message: `Error saving map changes: ${error.message}`
            }));
          }
          editorEditHistory.delete(saveData.mapName);
          break;
        }

        try {
          log.info(`Map save requested by ${currentPlayer.username} for map: ${saveData.mapName}, ${saveData.chunks.length} chunks modified`);

          // Forward chunks to asset server via HTTP
          const assetServerUrl = process.env.ASSET_SERVER_INTERNAL_URL || process.env.ASSET_SERVER_URL || "http://localhost:8081";
          const authKey = process.env.ASSET_SERVER_AUTH_KEY || process.env.GATEWAY_AUTH_KEY;

          const response = await serverFetch(`${assetServerUrl}/save-map-chunks`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              mapName: saveData.mapName,
              chunks: saveData.chunks,
              bounds: (saveData as any).bounds,
              authKey: authKey
            })
          });

          if (!response.ok) {
            const errorData = await response.json().catch(() => ({ error: response.statusText }));
            throw new Error(errorData.error || `Failed to save chunks to asset server: ${response.status}`);
          }

          log.info(`Map chunks saved to asset server: ${saveData.mapName}`);

          // Also sync graveyards and warps to asset server if present
          if (saveData.graveyards || saveData.warps) {
            try {
              const syncResponse = await serverFetch(`${assetServerUrl}/save-map-properties`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json"
                },
                body: JSON.stringify({
                  mapName: saveData.mapName,
                  graveyards: saveData.graveyards,
                  warps: saveData.warps,
                  authKey: authKey
                })
              });

              if (!syncResponse.ok) {
                const syncErrorData = await syncResponse.json().catch(() => ({ error: syncResponse.statusText }));
                log.warn(`Failed to sync graveyards/warps to asset server: ${syncErrorData.error || syncResponse.status}`);
              } else {
                log.info(`Map graveyards/warps synced to asset server: ${saveData.mapName}`);
              }
            } catch (syncError) {
              log.warn(`Error syncing graveyards/warps to asset server: ${syncError}`);
            }
          }

          // Save graveyards and warps to mapProperties
          if (saveData.graveyards !== undefined || saveData.warps !== undefined) {
            const mapPropertiesCache = await assetCache.get("mapProperties");
            const mapPropsIndex = mapPropertiesCache.findIndex((m: any) => m.name === `${saveData.mapName.replace('.json', '')}.json`);

            if (mapPropsIndex !== -1) {
              if (saveData.graveyards !== undefined) {
                mapPropertiesCache[mapPropsIndex].graveyards = saveData.graveyards;
              }
              if (saveData.warps !== undefined) {
                mapPropertiesCache[mapPropsIndex].warps = saveData.warps;
              }

              try {
                await assetCache.add("mapProperties", mapPropertiesCache);
              } catch (propError) {
                log.warn(`Failed to update mapProperties for ${saveData.mapName}: ${propError}`);
              }
            }
          }

          // Update local cache with the changes AND save to disk
          const cachedMaps = (await assetCache.get("maps")) as MapData[];
          const mapIndex = cachedMaps.findIndex((m: any) => m.name === saveData.mapName);
          let rebaseResult: { shiftX: number; shiftY: number; width: number; height: number } | null = null;

          if (mapIndex !== -1) {
            // Update actual map layers with chunk data (growing / re-basing the
            // origin for infinite-map expansion; empty expansion is trimmed away).
            const mapData = cachedMaps[mapIndex].data;
            rebaseResult = applyChunksWithRebase(mapData, saveData.chunks, (saveData as any).bounds);

            // Update graveyards and warps in the map data
            if (saveData.graveyards !== undefined) {
              cachedMaps[mapIndex].data.graveyards = saveData.graveyards;
            }
            if (saveData.warps !== undefined) {
              cachedMaps[mapIndex].data.warps = saveData.warps;
            }

            assetCache.add("maps", cachedMaps).catch((error) => log.error(`The edited map could not be written to the cache: ${error}`));

            // Save graveyards and warps properties and reload the map
            if (saveData.graveyards !== undefined || saveData.warps !== undefined) {
              try {
                log.debug(`[SAVE_MAP] Graveyards: ${saveData.graveyards ? `${saveData.graveyards.length} items` : 'undefined'}`);
                log.debug(`[SAVE_MAP] Warps: ${saveData.warps ? `${saveData.warps.length} items` : 'undefined'}`);

                // Only call saveMapProperties if there's actual data to save
                if ((saveData.graveyards && saveData.graveyards.length > 0) || (saveData.warps && saveData.warps.length > 0)) {
                  await saveMapProperties(saveData.mapName, saveData.graveyards, saveData.warps);

                  // Reload the map to refresh mapProperties cache
                  const { reloadMap: reloadMapFunc } = await import("../../modules/assetloader");
                  const reloadedMap = await reloadMapFunc(saveData.mapName);

                  // Update the cached maps with the reloaded map
                  const updatedMaps = cachedMaps;
                  const mapIdx = updatedMaps.findIndex((m: any) => m.name === saveData.mapName);
                  if (mapIdx !== -1) {
                    updatedMaps[mapIdx] = reloadedMap;
                    assetCache.add("maps", updatedMaps).catch((error) => log.error(`The reloaded map could not be written to the cache: ${error}`));
                  }
                } else {
                  log.debug(`[SAVE_MAP] No graveyards or warps to save`);
                }
              } catch (propError) {
                log.warn(`Failed to save/reload map properties: ${propError}`);
              }
            }

          }

          // Save chunks to disk locally so reloadMap reads fresh file
          try {
            await saveMapChunks(saveData.mapName, saveData.chunks, (saveData as any).bounds);
          } catch (diskError) {
            log.warn(`Failed to save chunks to disk locally: ${diskError}`);
          }

          // Refresh collision cache since collision layer may have been updated
          try {
            const { reloadMap } = await import("../../modules/assetloader");
            await reloadMap(saveData.mapName);
            log.info(`Collision cache refreshed for ${saveData.mapName}`);
            clearMapCache(saveData.mapName);
          } catch (reloadError) {
            log.warn(`Failed to reload map collision cache: ${reloadError}`);
          }

          sendPacket(wt, packetManager.notify({
            message: `Map saved successfully! ${saveData.chunks.length} chunks updated.`
          }));

          // Propagate the save to everyone on the map. Bounds (incl. trimmed empty
          // expansion) go to ALL players so the saver's view shrinks too; chunk
          // refreshes go only to OTHER players.
          const onMapPlayers = filterPlayersByMap(currentPlayer.location.map);
          const updatedMapData = cachedMaps[mapIndex]?.data;
          // Use the SERVER-computed shift (empty expansion is trimmed away, so the
          // real shift may be 0 even if the client claimed a negative expansion) and
          // the persisted dims (what a reload will show), so live matches reload.
          const shiftTilesX = rebaseResult?.shiftX ?? 0;
          const shiftTilesY = rebaseResult?.shiftY ?? 0;
          const newMapWidth = updatedMapData?.width ?? rebaseResult?.width;
          const newMapHeight = updatedMapData?.height ?? rebaseResult?.height;
          const tw = updatedMapData?.tilewidth || 32;
          const th = updatedMapData?.tileheight || 32;
          const shiftPxX = shiftTilesX * tw;
          const shiftPxY = shiftTilesY * th;

          if (shiftTilesX > 0 || shiftTilesY > 0) {
            // Left/up expansion re-based the origin to (0,0). Shift every on-map
            // player's authoritative position and fully re-sync each client.
            for (const p of onMapPlayers) {
              if (p.location?.position) {
                p.location.position.x = (Number(p.location.position.x) || 0) + shiftPxX;
                p.location.position.y = (Number(p.location.position.y) || 0) + shiftPxY;
                playerCache.set(p.id, p);
              }
            }
            const rebasePayload = { shiftX: shiftPxX, shiftY: shiftPxY, width: newMapWidth, height: newMapHeight };
            onMapPlayers.forEach((player) => {
              sendPacket(player.wt, packetManager.mapRebase(rebasePayload));
            });
          } else {
            // No re-base (grew or trimmed): update EVERYONE's bounds (shiftX/Y = 0 is
            // a bounds-only update that drops trimmed-away chunks without re-fetching),
            // and refresh the saved chunks for OTHER players only.
            const boundsPayload = { shiftX: 0, shiftY: 0, width: newMapWidth, height: newMapHeight };
            onMapPlayers.forEach((player) => {
              sendPacket(player.wt, packetManager.mapRebase(boundsPayload));
            });
            const chunkCoords = saveData.chunks.map((chunk: any) => ({
              chunkX: chunk.chunkX,
              chunkY: chunk.chunkY
            }));
            onMapPlayers
              .filter((p) => p.id !== wt.data.id)
              .forEach((player) => {
                sendPacket(player.wt, packetManager.updateChunks({ chunks: chunkCoords }));
              });
          }
        } catch (error: any) {
          log.error(`Error saving map: ${error.message}`);
          sendPacket(wt, packetManager.notify({
            message: 'Error saving map changes.'
          }));
        }

        // Clear edit history for this map now that it's saved
        if (saveData.mapName) {
          editorEditHistory.delete(saveData.mapName);
        }

        break;
      }

      case "SAVE_PARTICLE": {
        if (!currentPlayer) return;

        const userPermissions = await permissions.get(currentPlayer.username) as string;
        const perms = userPermissions.includes(",") ? userPermissions.split(",") : userPermissions.length ? [userPermissions] : [];
        const hasPermission = perms.includes('server.admin') || perms.includes('server.*');

        if (!hasPermission) {
          sendPacket(wt, packetManager.notify({
            message: 'You do not have permission to save particles.'
          }));
          return;
        }

        try {
          const particleData = data as unknown as Particle;

          // Check if particle already exists
          const existingParticles = await particles.list();
          const particleExists = existingParticles.some(p => p.name === particleData.name);

          if (particleExists) {
            await particles.update(particleData);
            log.info(`Particle updated by ${currentPlayer.username}: ${particleData.name}`);
          } else {
            await particles.add(particleData);
            log.info(`Particle added by ${currentPlayer.username}: ${particleData.name}`);
          }

          // Reload particles cache from database to ensure consistency
          const updatedParticles = await particles.list();
          const updatedParticleData = updatedParticles.find(p => p.name === particleData.name);

          // Broadcast particle update to all connected players
          if (updatedParticleData) {
            const updatePacket = packetManager.particleUpdated(updatedParticleData);
            const allPlayers = playerCache.list();
            for (const playerId in allPlayers) {
              const player = allPlayers[playerId];
              if (player.wt && player.wt.readyState === 1) { // readyState 1 = OPEN
                sendPacket(player.wt, updatePacket);
              }
            }
          }

          sendPacket(wt, packetManager.notify({
            message: 'Particle saved successfully'
          }));
        } catch (error: any) {
          log.error(`Error saving particle: ${error.message}`);
          sendPacket(wt, packetManager.notify({
            message: 'Error saving particle.'
          }));
        }
        break;
      }

      case "DELETE_PARTICLE": {
        if (!currentPlayer) return;

        const userPermissions = await permissions.get(currentPlayer.username) as string;
        const perms = userPermissions.includes(",") ? userPermissions.split(",") : userPermissions.length ? [userPermissions] : [];
        const hasPermission = perms.includes('server.admin') || perms.includes('server.*');

        if (!hasPermission) {
          sendPacket(wt, packetManager.notify({
            message: 'You do not have permission to delete particles.'
          }));
          return;
        }

        try {
          const { name } = data as unknown as { name: string };
          await particles.remove({ name } as any);
          log.info(`Particle deleted by ${currentPlayer.username}: ${name}`);

          sendPacket(wt, packetManager.notify({
            message: 'Particle deleted successfully'
          }));
        } catch (error: any) {
          log.error(`Error deleting particle: ${error.message}`);
          sendPacket(wt, packetManager.notify({
            message: 'Error deleting particle.'
          }));
        }
        break;
      }

      // Renames a particle and every NPC / spell / mount reference to it (particles.rename), and the in-memory lists
      // of the maps' particle NPCs (their map files still name the old particle until edited)
      case "RENAME_PARTICLE": {
        if (!currentPlayer) return;

        const userPermissions = await permissions.get(currentPlayer.username) as string;
        const perms = userPermissions.includes(",") ? userPermissions.split(",") : userPermissions.length ? [userPermissions] : [];
        if (!perms.includes('server.admin') && !perms.includes('server.*')) {
          sendPacket(wt, packetManager.notify({ message: 'You do not have permission to rename particles.' }));
          return;
        }

        try {
          const { from, to } = data as unknown as { from: string; to: string };
          const oldName = String(from ?? "").trim(), newName = String(to ?? "").trim();
          if (!oldName || !newName || newName.length > 255 || newName.includes(",")) {
            sendPacket(wt, packetManager.notify({ message: 'Invalid particle name.' }));
            return;
          }
          if (oldName === newName) return;
          const existing = await particles.list();
          if (!existing.some((p) => p.name === oldName)) {
            sendPacket(wt, packetManager.notify({ message: `Particle ${oldName} not found.` }));
            return;
          }
          if (existing.some((p) => p.name === newName)) {
            sendPacket(wt, packetManager.notify({ message: `A particle named ${newName} already exists.` }));
            return;
          }

          const counts = await particles.rename(oldName, newName);
          let mapRefs = 0;
          for (const n of npcSystem.getMapNpcs()) {
            if (typeof n.particles === "string" && (n.particles as string).split(",").some((x) => x.trim() === oldName)) {
              (n as any).particles = renameInList(n.particles as string, oldName, newName);
              mapRefs++;
            }
          }
          await assetCache.set("npcs", await npcSystem.list());
          for (const key of ["spells", "mounts"]) {
            const list = (await assetCache.get(key)) as any[] | null;
            if (!Array.isArray(list)) continue;
            for (const row of list) if (typeof row?.particles === "string") row.particles = renameInList(row.particles, oldName, newName);
            await assetCache.set(key, list);
          }
          log.info(`Particle renamed by ${currentPlayer.username}: ${oldName} -> ${newName} (npcs ${counts.npcs}, spells ${counts.spells}, mounts ${counts.mounts}, map objects ${mapRefs})`);

          const parts = [`Renamed ${oldName} to ${newName}`];
          const refs = counts.npcs + counts.spells + counts.mounts;
          if (refs) parts.push(`updated ${refs} NPC/spell/mount reference(s)`);
          if (mapRefs) parts.push(`${mapRefs} map object(s) still say ${oldName} in their map file: rename it there too`);
          sendPacket(wt, packetManager.notify({ message: parts.join("; ") }));
        } catch (error: any) {
          log.error(`Error renaming particle: ${error.message}`);
          sendPacket(wt, packetManager.notify({ message: 'Error renaming particle.' }));
        }
        break;
      }

      case "LIST_PARTICLES": {
        if (!currentPlayer) return;
        // Only the particle editor and the NPC editor ask for this, and /pe and /ne open them for those they let through.
        if (!currentPlayer.permissions?.some((p: string) => p === "tools.particle_editor" || p === "tools.npc_editor" || p === "tools.*")) return;

        try {
          const particleList = await particles.list();
          sendPacket(wt, packetManager.custom({
            type: "PARTICLE_LIST",
            data: particleList
          }));
        } catch (error: any) {
          log.error(`Error listing particles: ${error.message}`);
          sendPacket(wt, packetManager.notify({
            message: 'Error loading particles.'
          }));
        }
        break;
      }

      case "TEST_PARTICLE": {
        if (!currentPlayer) return;

        const userPermissions = await permissions.get(currentPlayer.username) as string;
        const perms = userPermissions.includes(",") ? userPermissions.split(",") : userPermissions.length ? [userPermissions] : [];
        const hasPermission = perms.includes('server.admin') || perms.includes('server.*');

        if (!hasPermission) {
          return;
        }

        try {
          const { testType, data: testData } = data as { testType: string; data: any };
          log.info(`Particle test by ${currentPlayer.username}: type=${testType}`);

          // Broadcast test particle event to all players in the map
          const playersInMap = filterPlayersByMap(currentPlayer.location.map);
          playersInMap.forEach((player) => {
            sendPacket(player.wt, packetManager.custom({
              type: "TEST_PARTICLE_EVENT",
              data: {
                testType,
                particle: testData.particle,
                position: testData.position || currentPlayer.location,
                npcId: testData.npcId
              }
            }));
          });
        } catch (error: any) {
          log.error(`Error testing particle: ${error.message}`);
        }
        break;
      }

      case "FISHING_EDITOR_LIST":
      case "FISHING_EDITOR_SAVE": {
        // The map editor's Fishing tab: what it shows, and its saves (as for tile sounds: server.admin or server.*)
        if (!currentPlayer) return;
        const userPermissions = await permissions.get(currentPlayer.username) as string;
        const perms = userPermissions.includes(",") ? userPermissions.split(",") : userPermissions.length ? [userPermissions] : [];
        if (!fishing.mayEditFishing(perms)) {
          sendPacket(wt, packetManager.notify({ message: "You do not have permission to change fishing." }));
          return;
        }
        if (type === "FISHING_EDITOR_SAVE") {
          await fishing.loadItems();
          const read = fishing.readFishingChanges(data, fishing.materialName, fishing.weaponName);
          if ("error" in read) {
            sendPacket(wt, packetManager.notify({ message: read.error }));
            return;
          }
          try {
            await fishing.saveFishing(read.changes);
            log.info(`Fishing saved by ${currentPlayer.username}: ${read.changes.reduce((n, c) => n + c.ids.length, 0)} tiles`);
          } catch (error: any) {
            log.error(`Error saving fishing: ${error.message}`);
            sendPacket(wt, packetManager.notify({ message: `Error saving fishing: ${error.message}` }));
            return;
          }
          // every player is told which tiles are fishable now
          const tiles = packetManager.fishingTiles({ tilesets: fishing.publicTiles() });
          for (const online of Object.values(playerCache.list()) as any[]) {
            if (online?.wt) sendPacket(online.wt, tiles);
          }
        }
        sendPacket(wt, packetManager.fishingEditorData(await fishing.editorData()));
        break;
      }

      case "MAILBOX_EDITOR_LIST":
      case "MAILBOX_EDITOR_SAVE":
      case "MAILBOX_EDITOR_DELETE": {
        if (!currentPlayer) return;
        // The handler checks permission first, on every one of these; its answer carries the maps as they stand.
        const result = await mailboxEditor.handleEditorPacket(currentPlayer, type, data, mailboxEditorWorld(currentPlayer));
        if (result.kind === "data") {
          sendPacket(wt, packetManager.mailboxEditorData(result.data));
          break;
        }
        if (result.denied) sendPacket(wt, packetManager.notify({ message: mailboxEditor.DENIED }));
        sendPacket(wt, packetManager.mailboxEditorResult({
          ok: result.ok, errors: result.errors, fields: result.fields, name: result.name, notes: result.notes, action: type, data: result.data,
        }));
        if (result.changed) {
          const map = result.changed;
          // Everyone on the map sees the mailboxes where they now stand, and every other open editor asks for the maps again.
          const updated = packetManager.mailboxEditorUpdated({ by: currentPlayer.username });
          for (const other of Object.values(playerCache.list()) as any[]) {
            if (!other?.wt) continue;
            if (String(other.location?.map ?? "").replaceAll(".json", "") === map) await sendMailboxes(other.wt, map);
            if (other.id !== currentPlayer.id && mailboxEditor.mayHaveEditorOpen(other)) sendPacket(other.wt, updated);
          }
        }
        break;
      }

      case "ACHIEVEMENT_EDITOR_LIST":
      case "ACHIEVEMENT_EDITOR_SAVE":
      case "ACHIEVEMENT_EDITOR_DELETE": {
        if (!currentPlayer) return;
        // The handler checks permission first, on every one of these, and sends its own answers.
        await achievements.handleEditorPacket(currentPlayer, type, data);
        break;
      }

      case "GATHERING_EDITOR_LIST":
      case "GATHERING_EDITOR_SAVE":
      case "GATHERING_EDITOR_DELETE":
      case "GATHERING_EDITOR_PREVIEW": {
        if (!currentPlayer) return;
        // The handler checks permission first, on every one of these, and sends its own answers.
        await gathering.handleEditorPacket(currentPlayer, type, data);
        break;
      }

      case "LIST_LOOT_TABLES": {
        if (!currentPlayer) return;
        // Only the loot editor window asks for this, and /le opens it for those it lets through.
        if (!lootEditor.canUseEditor(currentPlayer)) return;
        const tables = await lootTable.list();
        sendPacket(wt, packetManager.lootTableList(tables, await lootEditor.itemCatalogue()));
        break;
      }
  }
}
