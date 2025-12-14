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
        })
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
            location: {
              x: data.position.x,
              y: data.position.y,
              direction: "down",
            },
            script: data.script,
            hidden: data.hidden,
            dialog: data.dialog,
            particles: data.particles,
            quest: data.quest,
            map: data.map,
            position: data.position,
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
            stats: data.stats,
            sprite: data.sprite,
            ...(data.friends ? { friends: data.friends } : {}),
            ...(data.party ? { party: data.party } : {}),
            ...(data.currency ? { currency: data.currency } : { copper: 0, silver: 0, gold: 0 })
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
    return [
      packet.encode(
        JSON.stringify({
          type: "MOVEXY",
          data,
        })
      )
    ] as any[];
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
  audio: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "AUDIO", name: data.name, data: data.data, pitch: data.pitch, timestamp: data.timestamp || null })),
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
  music: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "MUSIC", name: data.name, data: data.data })),
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
  }
};