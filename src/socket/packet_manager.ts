import packet from "../modules/packet";

export const packetManager = {
  disconnect: (id: string) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "DISCONNECT_MALIFORMED",
          data: {
            id: id
          },
        })
      )
    ] as any[];
  },
  reconnect: () => {
    return [
      packet.encode(
        JSON.stringify({
          type: "RECONNECT",
          data: null,
        })
      )
    ] as any[];
  },
  ping: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "PONG", data: data })),
      packet.encode(
        JSON.stringify({
          type: "TIME_SYNC",
          data: Date.now(),
        })
      ),
    ] as any[];
  },
  pong: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "PONG", data: data })),
    ] as any[];
  },
  timeSync: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "TIME_SYNC", data: data })),
    ] as any[];
  },
  benchmark: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "BENCHMARK", data: data })),
    ] as any[];
  },
  login: (ws: WebSocket) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "LOGIN_SUCCESS",
          data: ws.data.id,
          secret: ws.data.secret,
          chatDecryptionKey: ws.data.chatDecryptionKey,
        })
      )
    ] as any[];
  },
  loginFailed: () => {
    return [
      packet.encode(JSON.stringify({ type: "LOGIN_FAILED", data: null })),
    ] as any[];
  },
  inventory: (data: InventoryItem[]) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "INVENTORY",
          data,
          slots: 30,
        }),
      )
    ] as any[];
  },
  equipment: (data: Equipment) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "EQUIPMENT",
          data,
        }),
      )
    ] as any[];
  },
  collectables: (data: Collectable[]) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "COLLECTABLES",
          data,
          slots: 20,
        }),
      )
    ] as any[];
  },
  spells: (data: any) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "SPELLS",
          data,
        }),
      )
    ] as any[];
  },
  loadHotBar: (data: any) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "LOAD_HOTBAR",
          data,
        }),
      )
    ] as any[];
  },
  questlog: (completedQuest: Quest[], incompleteQuest: Quest[]) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "QUESTLOG",
          data: {
            completed: completedQuest,
            incomplete: incompleteQuest,
          },
        })
      )
    ] as any[];
  },
  stats: (data: any) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "STATS",
          data,
        })
      )
    ] as any[];
  },
  clientConfig: (data: any) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "CLIENTCONFIG",
          data,
        })
      )
    ] as any[];
  },
  createNpc: (data: any) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "CREATE_NPC",
          data: {
            id: data.id,
            last_updated: data.last_updated,
            name: data.name || null,
            location: {
              x: data.position.x,
              y: data.position.y,
              direction: data.location?.direction || data.position?.direction || "down",
            },
            script: data.script,
            hidden: data.hidden,
            dialog: data.dialog,
            particles: data.particles,
            quest: data.quest,
            map: data.map,
            position: data.position,
            sprite_type: data.sprite_type || 'animated',
            spriteLayers: data.spriteLayers || null,
          },
        })
      )
    ] as any[];
  },
  loadMap: (data: any) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "LOAD_MAP",
          data
        })
      )
    ] as any[];
  },
  spawnPlayer: (data: any) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "SPAWN_PLAYER",
          data: {
            id: data.id,
            userid: data.userid,
            location: {
              map: data.location.map,
              x: data.location.x || 0,
              y: data.location.y || 0,
              direction: data.location.direction,
            },
            username: data.username,
            isAdmin: data.isAdmin,
            isGuest: data.isGuest,
            isStealth: data.isStealth,
            isNoclip: data.isNoclip,
            stats: data.stats,
            sprite: data.sprite,
            mounted: data.mounted,
            spriteData: data.spriteData || null,
            ...(data.friends ? { friends: data.friends } : {}),
            ...(data.party ? { party: data.party } : {}),
            ...(data.currency ? { currency: data.currency } : { copper: 0, silver: 0, gold: 0 }),
          },
        })
      )
    ] as any[];
  },
  loadPlayers: (data: any) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "LOAD_PLAYERS",
          data,
        })
      )
    ] as any[];
  },
  moveXY: (data: any) => {
    const HEADER_BYTE = 0x02;
    const DIRECTION_MAP: Record<string, number> = {
      up: 0, down: 1, left: 2, right: 3,
      upleft: 4, upright: 5, downleft: 6, downright: 7
    };

    const playerId = typeof data.i === "number" ? data.i : parseInt(data.i, 10) || 0;
    const x = typeof data.d?.x === "number" ? Math.round(data.d.x) : 0;
    const y = typeof data.d?.y === "number" ? Math.round(data.d.y) : 0;
    const direction = DIRECTION_MAP[data.d?.dr as string] ?? 1;
    const stealth = data.s === 1 ? 1 : 0;

    const packetData = new Uint8Array(9);
    const view = new DataView(packetData.buffer);

    packetData[0] = HEADER_BYTE;
    view.setUint16(1, playerId, true);
    view.setInt16(3, x, true);
    view.setInt16(5, y, true);
    packetData[7] = direction | (stealth << 4);

    return [packetData];
  },
  batchMoveXY: (movements: any[]) => {
    const HEADER_BYTE = 0x01;
    const DIRECTION_MAP: Record<string, number> = {
      up: 0, down: 1, left: 2, right: 3,
      upleft: 4, upright: 5, downleft: 6, downright: 7
    };

    const chunks: number[][] = [];

    chunks.push([HEADER_BYTE]);

    const countBytes = new Uint8Array(2);
    const dataView = new DataView(countBytes.buffer);
    dataView.setUint16(0, movements.length, true);
    chunks.push(Array.from(countBytes));

    for (const m of movements) {
      const playerId = typeof m.i === "number" ? m.i : parseInt(m.i, 10) || 0;

      const idBytes = new Uint8Array(2);
      const idView = new DataView(idBytes.buffer);
      idView.setUint16(0, playerId, true);
      chunks.push(Array.from(idBytes));

      const x = typeof m.d?.x === "number" ? Math.round(m.d.x) : 0;
      const y = typeof m.d?.y === "number" ? Math.round(m.d.y) : 0;
      const direction = DIRECTION_MAP[m.d?.dr as string] ?? 1;
      const stealth = m.s === 1 ? 1 : 0;

      const moveData = new Uint8Array(5);
      const moveView = new DataView(moveData.buffer);

      moveView.setInt16(0, x, true);
      moveView.setInt16(2, y, true);
      moveData[4] = direction | (stealth << 4);

      chunks.push(Array.from(moveData));
    }

    const flatLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Uint8Array(flatLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    return [result];
  },
  chat: (data: any) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "CHAT",
          data,
        })
      )
    ] as any[];
  },
  whisper: (data: any) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "WHISPER",
          data,
        })
      )
    ] as any[];
  },
  partyChat: (data: any) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "PARTY_CHAT",
          data,
        })
      )
    ] as any[];
  },
  selectPlayer: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "SELECTPLAYER", data })),
    ] as any[];
  },
  inspectPlayer: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "INSPECTPLAYER", data })),
    ] as any[];
  },
  stealth: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "STEALTH", data })),
    ] as any[];
  },
  noclip: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "NOCLIP", data })),
    ] as any[];
  },
  dragPlayerStart: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "DRAG_PLAYER_START", data })),
    ] as any[];
  },
  dragPlayerStop: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "DRAG_PLAYER_STOP", data })),
    ] as any[];
  },
  revive: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "REVIVE", data })),
    ] as any[];
  },
  updateStats: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "UPDATESTATS", data })),
    ] as any[];
  },
  questDetails: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "QUESTDETAILS", data })),
    ] as any[];
  },
  notify: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "NOTIFY", data })),
    ] as any[];
  },
  typing: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "TYPING", data })),
    ] as any[];
  },
  stopTyping: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "STOPTYPING", data })),
    ] as any[];
  },
  updateXp: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "UPDATE_XP", data })),
    ] as any[];
  },
  animation: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "ANIMATION", data })),
    ] as any[];
  },
  spriteSheetAnimation: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "SPRITE_SHEET_ANIMATION", data })),
    ] as any[];
  },
  batchSpriteSheetAnimation: (animations: any[]) => {
    return [
      packet.encode(JSON.stringify({ type: "BATCH_SPRITE_SHEET_ANIMATION", data: animations })),
    ] as any[];
  },
  updateFriends: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "UPDATE_FRIENDS", data })),
    ] as any[];
  },
  invitation: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "INVITATION", data })),
    ] as any[];
  },
  updateOnlineStatus: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "UPDATE_ONLINE_STATUS", data })),
    ] as any[];
  },
  updateParty: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "UPDATE_PARTY", data })),
    ] as any[];
  },
  currency: (data: Currency) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "CURRENCY",
          data,
        })
      )
    ] as any[];
  },
  consoleMessage: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "CONSOLE_MESSAGE", data })),
    ] as any[];
  },
  serverTime: () => {
    return [
      packet.encode(JSON.stringify({ type: "SERVER_TIME", data: Date.now() })),
    ] as any[];
  },
  weather: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "WEATHER", data })),
    ] as any[];
  },
  collisionDebug: (data: { tileX: number; tileY: number }) => {
    return [
      packet.encode(JSON.stringify({ type: "COLLISION_DEBUG", data })),
    ] as any[];
  },
  toggleTileEditor: () => {
    return [
      packet.encode(JSON.stringify({ type: "TOGGLE_TILE_EDITOR", data: null })),
    ] as any[];
  },
  toggleParticleEditor: () => {
    return [
      packet.encode(JSON.stringify({ type: "TOGGLE_PARTICLE_EDITOR", data: null })),
    ] as any[];
  },
  toggleNpcEditor: () => {
    return [
      packet.encode(JSON.stringify({ type: "TOGGLE_NPC_EDITOR", data: null })),
    ] as any[];
  },
  npcList: (npcs: any[]) => {
    return [
      packet.encode(JSON.stringify({ type: "NPC_LIST", data: npcs })),
    ] as any[];
  },
  npcUpdated: (npc: any) => {
    return [
      packet.encode(JSON.stringify({ type: "NPC_UPDATED", data: npc })),
    ] as any[];
  },
  npcRemoved: (id: number) => {
    return [
      packet.encode(JSON.stringify({ type: "NPC_REMOVED", data: { id } })),
    ] as any[];
  },
  saveParticle: (particle: any) => {
    return [
      packet.encode(JSON.stringify({ type: "SAVE_PARTICLE", data: particle })),
    ] as any[];
  },
  deleteParticle: (particleName: string) => {
    return [
      packet.encode(JSON.stringify({ type: "DELETE_PARTICLE", data: { name: particleName } })),
    ] as any[];
  },
  listParticles: () => {
    return [
      packet.encode(JSON.stringify({ type: "LIST_PARTICLES", data: null })),
    ] as any[];
  },
  testParticle: (particle: any, testType: string, data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "TEST_PARTICLE", data: { particle, testType, data } })),
    ] as any[];
  },
  particleUpdated: (particle: any) => {
    return [
      packet.encode(JSON.stringify({ type: "PARTICLE_UPDATED", data: particle })),
    ] as any[];
  },
  reloadChunks: () => {
    return [
      packet.encode(JSON.stringify({ type: "RELOAD_CHUNKS", data: null })),
    ] as any[];
  },
  updateChunks: (chunks: Array<{chunkX: number, chunkY: number}>) => {
    return [
      packet.encode(JSON.stringify({ type: "UPDATE_CHUNKS", data: chunks })),
    ] as any[];
  },
  chunkData: (chunkX: number, chunkY: number, width: number, height: number, layers: any[], tilewidth?: number, tileheight?: number, startX?: number, startY?: number) => {
    return [
      packet.encode(JSON.stringify({
        type: "CHUNK_DATA",
        data: { chunkX, chunkY, width, height, layers, tilewidth, tileheight, startX, startY }
      })),
    ] as any[];
  },
  custom: (data: any) => {
    return [
      packet.encode(JSON.stringify(data)),
    ] as any[];
  },
  mount: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "MOUNT", data })),
    ] as any[];
  },
  castSpell: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "CAST_SPELL", data })),
    ] as any[];
  },
  projectile: (data: any) => {

    if (!data?.icon) return [];
    return [
      packet.encode(JSON.stringify({ type: "PROJECTILE", data })),
    ] as any[];
  },
  despawnPlayer: (playerId: string, reason?: string) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "DESPAWN_PLAYER",
          data: {
            id: playerId,
            reason: reason
          }
        })
      )
    ] as any[];
  },
  despawnEntity: (entityId: string, respawnTime?: number) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "DESPAWN_ENTITY",
          data: {
            id: entityId,
            respawnTime: respawnTime || 0
          }
        })
      )
    ] as any[];
  },
  spawnEntity: (entity: any) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "SPAWN_ENTITY",
          data: entity
        })
      )
    ] as any[];
  },
  moveEntity: (data: any) => {
    const HEADER_BYTE = 0x03;
    const DIRECTION_MAP: Record<string, number> = {
      up: 0, down: 1, left: 2, right: 3,
      upleft: 4, upright: 5, downleft: 6, downright: 7
    };

    const entityId = typeof data.id === "number" ? data.id : parseInt(data.id, 10) || 0;
    const x = typeof data.position?.x === "number" ? Math.round(data.position.x) : 0;
    const y = typeof data.position?.y === "number" ? Math.round(data.position.y) : 0;
    const direction = DIRECTION_MAP[data.direction as string] ?? 1;
    const isMoving = data.isMoving ? 1 : 0;
    const isCasting = data.isCasting ? 1 : 0;

    const packetData = new Uint8Array(11);
    const view = new DataView(packetData.buffer);

    view.setUint8(0, HEADER_BYTE);
    view.setUint32(1, entityId, true);
    view.setInt16(5, x, true);
    view.setInt16(7, y, true);

    const flags = (direction << 4) | (isMoving << 3) | (isCasting << 2);
    view.setUint8(9, flags);
    view.setUint8(10, data.castingProgress ? Math.round(data.castingProgress * 100) : 0);

    return [packetData];
  },
  batchDisconnectPlayer: (despawnData: Array<{ id: string; reason: string }>) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "BATCH_DISCONNECT_PLAYER",
          data: despawnData
        })
      )
    ] as any[];
  },
  getOnlinePlayers: () => {
    return [
      packet.encode(
        JSON.stringify({
          type: "GET_ONLINE_PLAYERS",
          data: null
        })
      )
    ] as any[];
  },
  onlinePlayersList: (players: Array<{ username: string; map: string; isAdmin: boolean }>) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "ONLINE_PLAYERS_LIST",
          data: players
        })
      )
    ] as any[];
  },
  createEntity: (data: any) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "CREATE_ENTITY",
          data: {
            id: data.id,
            last_updated: data.last_updated,
            name: data.name || null,
            location: {
              x: data.position.x,
              y: data.position.y,
              direction: data.position?.direction || "down",
            },
            health: data.health,
            max_health: data.max_health,
            level: data.level,
            aggro_type: data.aggro_type,
            particles: data.particles,
            map: data.map,
            position: data.position,
            sprite_type: data.sprite_type || 'animated',
            spriteLayers: data.spriteLayers || null,
          },
        })
      )
    ] as any[];
  },
  entityList: (entities: any[]) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "ENTITY_LIST",
          data: entities
        })
      )
    ] as any[];
  },
  updateEntity: (entity: any) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "UPDATE_ENTITY",
          data: entity
        })
      )
    ] as any[];
  },
  entityDied: (entityId: string, lootData?: any) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "ENTITY_DIED",
          data: {
            id: entityId,
            loot: lootData || []
          }
        })
      )
    ] as any[];
  },
  entityDamage: (entityId: string, damage: number, damageType: string = 'physical') => {
    return [
      packet.encode(
        JSON.stringify({
          type: "ENTITY_DAMAGE",
          data: {
            id: entityId,
            damage: damage,
            damageType: damageType
          }
        })
      )
    ] as any[];
  },
  updateEntityHealth: (entityId: string, health: number, maxHealth: number) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "UPDATE_ENTITY_HEALTH",
          data: {
            id: entityId,
            health: health,
            maxHealth: maxHealth
          }
        })
      )
    ] as any[];
  },
  toggleEntityEditor: () => {
    return [
      packet.encode(JSON.stringify({ type: "TOGGLE_ENTITY_EDITOR", data: null })),
    ] as any[];
  },
  debugAstar: (data: any) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "DEBUG_ASTAR",
          data
        })
      )
    ] as any[];
  }
};