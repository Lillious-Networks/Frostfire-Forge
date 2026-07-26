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
    WHISPER: "onWhisper",
    PLAYER_STEALTH_CHANGE: "onPlayerStealthChange",
    PLAYER_HEALED: "onPlayerHealed",
    PLAYER_ABSORBTION: "onPlayerAbsorbtion",
    PLAYER_STUNNED: "onPlayerStunned",
    PLAYER_DEBUFF_ADDED: "onPlayerDebuffAdded",
    PLAYER_BUFF_ADDED: "onPlayerBuffAdded",
    PLAYER_DEBUFF_REMOVED: "onPlayerDebuffRemoved",
    PLAYER_BUFF_REMOVED: "onPlayerBuffRemoved",
    PLAYER_VANISH: "onPlayerVanish",
    SPELL_FAILED: "onSpellFailed",
    PLAYER_LOOT_DROPPED: "onPlayerLootDropped",
    PLAYER_LOOT_DESPAWNED: "onPlayerLootDespawned",
    PLAYER_LOOT_RETRIEVED: "onPlayerLootRetrieved",
    PARTY_CHAT: "onPartyChat",
    GUILD_CHAT: "onGuildChat",
    PLAYER_ENTERED_PVP: "onPlayerEnteredPVP",
    PLAYER_LEFT_PVP: "onPlayerLeftPVP",
    PLAYER_ENTER_AOE: "onPlayerEnterAOE",
    PLAYER_LEFT_AOE: "onPlayerLeftAOE",
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
    type: "kick" | "leave" | "disband" | "join";
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

export interface WhisperEvent {
    fromUsername: string;
    toUsername: string;
    message: string;
}

export interface PlayerStealthChangeEvent {
    player: any;
    isStealth: boolean;
}

export interface PlayerHealedEvent {
    caster: any;
    target: any;
    amount: number;
    source?: string;
}

export interface PlayerAbsorbtionEvent {
    caster: any;
    target: any;
    spellName: string;
    amount: number;
    duration: number;
}

export interface PlayerStunnedEvent {
    caster: any;
    target: any;
    spellName: string;
    duration: number;
}

export interface PlayerEffectEvent {
    caster: any;
    target: any;
    spellName: string;
    effectType: string;
    effect: SpellEffect;
}

export interface PlayerEffectRemovedEvent {
    player: any;
    effectId: string;
    effectType: string;
    spellName?: string;
}

export interface PlayerVanishEvent {
    player: any;
    vanished: boolean;
    spellName?: string;
}

export interface SpellFailedEvent {
    player: any;
    target: any;
    spellName: string;
    reason: string;
}

export interface PlayerLootEvent {
    player: any;
    itemName: string;
    quantity: number;
    mapName: string;
    x: number;
    y: number;
}

export interface PartyChatEvent {
    player: any;
    message: string;
    partyMembers: string[];
}

export interface GuildChatEvent {
    player: any;
    message: string;
    guildMembers: string[];
    guildId: number;
}

export interface PlayerPvpEvent {
    player: any;
}

export interface PlayerAoeEvent {
    player: any;
    zoneId: string;
    spellName: string;
}

export function setPlayerPvp(player: any, value: boolean): void {
    if (!player) return;
    if (player.pvp === value) return;
    player.pvp = value;
    if (value) {
        listener.emit(Events.PLAYER_ENTERED_PVP, { player } as PlayerPvpEvent);
    } else {
        listener.emit(Events.PLAYER_LEFT_PVP, { player } as PlayerPvpEvent);
    }
}

const now = performance.now();

event.on("online", () => {
    const readyTimeMs = performance.now() - now;
    log.success(`TCP server is listening on port 3000 - Ready in ${(readyTimeMs / 1000).toFixed(3)}s (${readyTimeMs.toFixed(0)}ms)`);
});
