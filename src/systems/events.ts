import EventEmitter from "node:events";
import log from "../modules/logger";
export const event = new EventEmitter();
import { listener } from "../modules/event_bus.ts";
export { listener };

// ── Event name constants ──
export const Events = {
    // Lifecycle
    AWAKE: "onAwake",
    START: "onStart",
    PLUGIN_LOAD: "onPluginLoad",
    PLUGIN_INITIALIZE: "onPluginInitialize",
    PLUGIN_REGISTER: "onPluginRegister",
    PLUGIN_UNREGISTER: "onPluginUnregister",

    // Tick
    UPDATE: "onUpdate",
    FIXED_UPDATE: "onFixedUpdate",
    SAVE: "onSave",
    SERVER_TICK: "onServerTick",

    // Network
    CONNECTION: "onConnection",
    DISCONNECT: "onDisconnect",

    // Game hooks (emitted by engine, listened to by plugins)
    WARP: "onWarp",
    MAP_ENTER: "onMapEnter",
    PLAYER_AUTH_COMPLETE: "onPlayerAuthComplete",
    PARTY_CHANGED: "onPartyChanged",
    PLAYER_CHAT: "onPlayerChat",
    PLAYER_DEATH: "onPlayerDeath",
    PLAYER_RESPAWN: "onPlayerRespawn",
    GUILD_CHANGED: "onGuildChanged",
    ITEM_EQUIP: "onItemEquip",
    ITEM_UNEQUIP: "onItemUnequip",
    PLAYER_MOUNT: "onPlayerMount",
    PLAYER_MOVED: "onPlayerMoved",
    PLAYER_LOGOUT: "onPlayerLogout",
    PLAYER_DISCONNECT: "onPlayerDisconnect",
    SPELL_CAST: "onSpellCast",
    SPELL_INTERRUPTED: "onSpellInterrupted",
    PLAYER_DAMAGED: "onPlayerDamaged",
    PLAYER_LEVEL_UP: "onPlayerLevelUp",
    FRIEND_ADDED: "onFriendAdded",
    FRIEND_REMOVED: "onFriendRemoved",
    PARTY_INVITE: "onPartyInvite",
    PARTY_JOIN: "onPartyJoin",
    WHISPER: "onWhisper",
    PLAYER_STEALTH_CHANGE: "onPlayerStealthChange",
} as const;

// ── Event payload types ──
export interface WarpEvent {
    mapName: string;
    metadata: {
        name: string;
        assetServerUrl: string;
        width: number;
        height: number;
        tilewidth: number;
        tileheight: number;
        tilesets: any[];
        spawnX: number;
        spawnY: number;
        direction: string;
        chunks: any;
        warps: any;
        graveyards: any;
        hasWeather: boolean;
        objectLayers: any[];
    };
}

export interface MapEnterEvent {
    player: any;
    mapName: string;
    position: { x: number; y: number };
}

export interface PlayerAuthCompleteEvent {
    username: string;
    spawnLocation: {
        map: string;
        x: number;
        y: number;
        direction: string;
    };
    playerData: any;
}

export interface PartyChangedEvent {
    type: "kick" | "leave" | "disband";
    username?: string;
    kickedUsername?: string;
    members: string[];
}

export interface PluginLoadEvent {
    name: string;
    version: string;
    dirPath: string;
}

export interface PluginInitializeEvent {
    name: string;
    engine: any;
}

export interface PluginRegisterEvent {
    name: string;
}

export interface PlayerChatEvent {
    player: any;
    message: string;
    mapName: string;
    language?: string;
}

export interface PlayerDeathEvent {
    player: any;
    killer?: any;
}

export interface PlayerRespawnEvent {
    player: any;
    mapName: string;
    x: number;
    y: number;
}

export interface GuildChangedEvent {
    type: "create" | "join" | "leave" | "kick" | "disband";
    guildId: number | null;
    guildName: string | null;
    playerUsername: string;
    kickedUsername?: string;
}

export interface ItemEquipEvent {
    player: any;
    item: any;
    slot: string;
}

export interface ItemUnequipEvent {
    player: any;
    slot: string;
}

export interface PlayerMountEvent {
    player: any;
    mounted: boolean;
    mountType?: string;
}

export interface PlayerMovedEvent {
    player: any;
    position: { x: number; y: number; direction: string };
}

export interface PlayerLogoutEvent {
    player: any;
}

export interface PlayerDisconnectEvent {
    player: any;
}

export interface SpellCastEvent {
    player: any;
    spellName: string;
    target: any;
    isEntityTarget: boolean;
}

export interface SpellInterruptedEvent {
    player: any;
}

export interface PlayerDamagedEvent {
    attacker: any;
    target: any;
    damage: number;
    isCrit: boolean;
}

export interface PlayerLevelUpEvent {
    player: any;
    oldLevel: number;
    newLevel: number;
}

export interface FriendChangedEvent {
    type: "add" | "remove";
    playerUsername: string;
    friendUsername: string;
}

export interface PartyInviteEvent {
    inviterUsername: string;
    invitedUsername: string;
}

export interface PartyJoinEvent {
    playerUsername: string;
    partyMembers: string[];
}

export interface WhisperEvent {
    fromUsername: string;
    toUsername: string;
    message: string;
}

export interface PlayerStealthChangeEvent {
    player: any;
    isStealth: boolean;
}

const now = performance.now();

event.on("online", () => {
    const readyTimeMs = performance.now() - now;
    log.success(`TCP server is listening on port 3000 - Ready in ${(readyTimeMs / 1000).toFixed(3)}s (${readyTimeMs.toFixed(0)}ms)`);
});
