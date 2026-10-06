type Nullable<T> = T | null;

type DatabaseEngine = "mysql" | "postgres" | "sqlite";

declare interface Packet {
  type: string;
  data: PacketData;
  id: Nullable<string>;
  useragent: Nullable<string>;
  language: Nullable<string>;
  publicKey: Nullable<string>;
  chatDecryptionKey: Nullable<string>;
}

declare interface PacketType {
  [key: string]: string;
}

declare interface PacketData {
  data: Array<any>;
}

declare interface Identity {
  id: string;
  useragent: string;
  chatDecryptionKey: string;
}

declare interface ClientRateLimit {
  id: string;
  requests: number;
  rateLimited: boolean;
  time: Nullable<number>;
  windowTime: number;
}

declare interface RateLimitOptions {
  maxRequests: number;
  time: number;
  maxWindowTime: number;
}

declare interface MapData {
  name: string;
  data: any;
  compressed: Buffer;
  chunks: any;
}

declare interface TilesetData {
  name: string;
  data: Buffer;
}

declare interface ScriptData {
  name: string;
  data: string;
}

declare interface Player {
  id: Nullable<string>;
  username: Nullable<string>;
  position: PositionData;
  location: Nullable<LocationData>;
  map: Nullable<string>;
  layer: Nullable<string>;
  stats: Nullable<StatsData>;
  isStealth: boolean;
  isAdmin: Nullable<boolean>;
  isGuest: Nullable<boolean>;
  isNoclip: Nullable<boolean>;
  pvp: Nullable<boolean>;
  last_attack: Nullable<number>;
  animation: Nullable<string>;
  friends: Nullable<string[]>;
  invitiations: Nullable<string[]>;
  mounted: boolean;
  mount_type: Nullable<string>;
}

type QuestObjectiveType = "kill" | "collect" | "talk" | "explore";
type QuestRepeatable = "none" | "repeatable" | "daily";
type QuestState = "active" | "ready" | "completed";

declare interface QuestObjective {
  id: number;
  quest_id: number;
  sort_order: number;
  type: QuestObjectiveType;
  target: string;
  required_count: number;
  target_x: Nullable<number>;
  target_y: Nullable<number>;
  target_radius: Nullable<number>;
  description: Nullable<string>;
}

declare interface QuestReward {
  id: number;
  quest_id: number;
  item_name: string;
  quantity: number;
  is_choice: boolean;
  sort_order: number;
}

declare interface Quest {
  id: number;
  name: string;
  zone: Nullable<string>;
  offer_text: string;
  description: string;
  progress_text: string;
  completion_text: string;
  required_level: number;
  quest_level: number;
  xp_reward: number;
  copper_reward: number;
  repeatable: QuestRepeatable;
  next_quest_id: Nullable<number>;
  sort_order: number;
  /** Hydrated at asset-load time, not columns on the quests row. */
  objectives: QuestObjective[];
  rewards: QuestReward[];
  prerequisites: number[];
}

declare interface QuestLogEntry {
  quest_id: number;
  state: QuestState;
  accepted_at: number;
  completed_at: number;
  times_completed: number;
  /** objective_id -> current count */
  progress: Record<number, number>;
}

declare interface QuestLogData {
  active: QuestLogEntry[];
  completed: number[];
}

declare interface QuestOffer {
  questId: number;
  name: string;
  questLevel: number;
  requiredLevel: number;
  marker: QuestMarkerState;
  action: "offer" | "incomplete" | "turnin";
  reason: QuestEligibility;
}

declare interface ObjectiveUpdate {
  questId: number;
  objectiveId: number;
  type: QuestObjectiveType;
  target: string;
  count: number;
  required: number;
  /** This update pushed the whole quest to 'ready'. */
  questReady: boolean;
}

type QuestMarkerState =
  | "available"
  | "available_future"
  | "in_progress"
  | "ready"
  | "none";

type QuestEligibility =
  | "available"
  | "active"
  | "ready"
  | "completed"
  | "level_too_low"
  | "missing_prerequisite"
  | "log_full"
  | "daily_not_reset"
  | "unknown_quest";

declare interface Particle {
  name: string | null;
  size: number;
  color: string | null;
  velocity: {
      x: number;
      y: number;
  };
  lifetime: number;
  opacity: number;
  visible: boolean;
  gravity: {
      x: number;
      y: number;
  };
  localposition: {
    x: number | 0;
    y: number | 0;
  } | null;
  interval: number;
  amount: number;
  staggertime: number;
  currentLife: number | null;
  initialVelocity: {
    x: number;
    y: number;
  } | null;
  spread: {
    x: number;
    y: number;
  };
  weather: WeatherData | 'none';
  affected_by_weather: Nullable<boolean>;
  zIndex: number;
  /** Brightness of the glow (0 = none). */
  glow_intensity: number;
  /** How far the glow reaches past the particle, in px (0 = derived from size and intensity, the old look). */
  glow_radius?: number;
  /** One steady light at the particle's position instead of an emitted stream (no lifetime, movement or spread). */
  static_light?: boolean;
  /** How much light the whole particle (core and glow) gives off, day and night: 1 = as drawn, 0 = none, above 1 brighter. */
  brightness?: number;
  affected_by_time: Nullable<boolean>;
  time_on: Nullable<string>;
  time_off: Nullable<string>;
  /** The sprite (asset server, assets/sprites) emitted in place of the round dot, `size` px wide; null = the dot. */
  image?: Nullable<string>;
}

type NullablePlayer = Player | null;

declare interface InventoryItem {
  name: string;
  quantity: Nullable<number>;
}

type ItemType = "consumable" | "equipment" | "material" | "quest" | "miscellaneous";
type ItemQuality = "common" | "uncommon" | "rare" | "epic" | "legendary";
type ItemSlot = "helmet" | "necklace" | "shoulderguards" | "cape" | "chestplate" | "wristguards" | "gloves" | "belt" | "pants" | "boots" | "ring_1" | "ring_2" | "trinket_1" | "trinket_2" | "weapon" | "bag";

declare interface Item {
  name: string;
  quality: ItemQuality;
  type: ItemType;
  description: string;
  icon: Nullable<string>;
  stat_armor: Nullable<number>;
  stat_damage: Nullable<number>;
  stat_critical_chance: Nullable<number>;
  stat_critical_damage: Nullable<number>;
  stat_health: Nullable<number>;
  stat_stamina: Nullable<number>;
  stat_avoidance: Nullable<number>;
  level_requirement: Nullable<number>;
  equipable: boolean;
  equipment_slot: Nullable<ItemSlot>;
  bag_slots: Nullable<number>;
  /** Weapons: swing damage range and swing speed. Null means "not a weapon". */
  damage_min: Nullable<number>;
  damage_max: Nullable<number>;
  attack_speed_ms: Nullable<number>;
}

declare interface Equipment {
  chest_sprite: any;
  legs_sprite: any;
  head_sprite: any;
  username: string;
  helmet: Nullable<string>;
  head: Nullable<string>;
  body: Nullable<string>;
  necklace: Nullable<string>;
  shoulderguards: Nullable<string>;
  cape: Nullable<string>;
  chestplate: Nullable<string>;
  wristguards: Nullable<string>;
  gloves: Nullable<string>;
  belt: Nullable<string>;
  pants: Nullable<string>;
  boots: Nullable<string>;
  ring_1: Nullable<string>;
  ring_2: Nullable<string>;
  trinket_1: Nullable<string>;
  trinket_2: Nullable<string>;
  weapon: Nullable<string>;
  off_hand_weapon: Nullable<string>;
}

declare interface Icon {
  name: string;
  data: Buffer;
}

declare interface Npc {
  id: Nullable<number>;
  last_updated: Nullable<number>;
  map: string;
  name: Nullable<string>;
  position: PositionData;
  hidden: boolean;
  script: Nullable<string>;
  dialog: Nullable<string>;
  /** Gossip chain, one line per conversation step. Cycles into dialog. */
  gossip?: Nullable<string>;
  particles: Nullable<Particle[]>;
  /** Whether quests can be assigned to this NPC in the editors. */
  quest_giver: boolean;
  sprite_type: 'none' | 'static' | 'animated';
  sprite_body: Nullable<string>;
  sprite_head: Nullable<string>;
  sprite_helmet: Nullable<string>;
  sprite_shoulderguards: Nullable<string>;
  sprite_neck: Nullable<string>;
  sprite_hands: Nullable<string>;
  sprite_chest: Nullable<string>;
  sprite_feet: Nullable<string>;
  sprite_legs: Nullable<string>;
  sprite_weapon: Nullable<string>;
}

declare interface LocationData {
  [key: string]: string;
}

declare interface PositionData {
  x: number;
  y: number;
  direction: string | null;
}

declare interface StatsData {
  health: number;
  max_health: number;
  total_max_health: number;
  stamina: number;
  max_stamina: number;
  total_max_stamina: number;
  level: number;
  xp: number;
  max_xp: number;
  stat_critical_damage: number;
  stat_critical_chance: number;
  stat_armor: number;
  stat_damage: number;
  stat_health: number;
  stat_stamina: number;
  stat_avoidance: number;
  absorbtion: number;
}

declare interface WeaponData {
  name: string;
  damage: number;
  mana: number;
  range: number;
  quality: string;
  type: string;
  description: string;
}

declare interface SoundData {
  name: string;
  data: Buffer;
  pitch: Nullable<number>;
}

declare interface SpriteSheetData {
  name: string;
  width: number;
  height: number;
  data: Buffer;
}

declare interface SpriteData {
  name: string;
  data: Buffer;
  hash: Nullable<string>;
}

declare interface SpellEffect {
  type: string;
  value: number;
  duration?: number;
  interval?: number;
  stackable?: boolean;
  max_stacks?: number;
  target_particles?: string;
}

declare interface SpellData {
  id: Nullable<number>;
  name: string;
  damage: number;
  mana: number;
  range: number;
  type: string;
  cast_time: number;
  description: string;
  can_move: number;
  cooldown: number;
  icon: Nullable<string>;
  sprite: Nullable<string>;
  particles: Nullable<string>;
  effects: SpellEffect[];
  aoe_radius: Nullable<number>;
  ground_aoe: Nullable<number>;
  ground_duration: Nullable<number>;
  is_thrown: Nullable<number>;
  charge_distance: Nullable<number>;
  teleport_behind: Nullable<number>;
}

declare interface LearnedSpell {
  spell: string;
  username: string;
}

type NPCScript = {
  onCreated: (this: Npc) => void;
  say: (this: Npc, message: string) => void;
};

declare interface WeatherData {
  name: string;
  temperature: number;
  humidity: number;
  wind_speed: number;
  wind_direction: string;
  precipitation: number;
  ambience: number;
}

declare interface WorldData {
  name: string;
  weather: string;
  players: Nullable<number>;
}

declare interface LegacyQuest {
  id: number;
  name: string;
  description: string;
  reward: number;
  xp_gain: number;
  required_quest: number;
  required_level: number;
}

declare interface MapProperties {
  name: string;
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  warps: Nullable<WarpObject[]>;
  graveyards: Nullable<GraveyardObject[]>;
  shadowLayerNames?: Nullable<string[]>;
  version: string;
  /** Worlds only: where new players start, in pixels. */
  spawn?: Nullable<{ x: number; y: number }>;
}

declare interface PlayerProperties {
  width: number;
  height: number;
}

declare interface WarpObject {
  name: string;
  map: string;
  x: number;
  y: number;
  position: {
    x: number;
    y: number;
  };
  size: {
    width: number;
    height: number;
  };
  layer: Nullable<string>;
}

declare interface GraveyardObject {
  name: string;
  position: {
    x: number;
    y: number;
  };
  layer: Nullable<string>;
}

declare interface Currency {
  copper: number;
  silver: number;
  gold: number;
}

declare interface Mount {
  name: string;
  description: string;
  particles: string | null;
  icon: string | null |Buffer<any>;
}

declare interface Authentication {
  authenticated: boolean;
  completed: boolean;
  error: Nullable<string>;
  data: Nullable<PlayerData>;
}

declare interface PlayerData {
  id: string;
  username: string;
  location: {
    map: string;
    position: {
      x: number;
      y: number;
      direction: string;
    };
  };
  permissions: string[];
  stats: statsData;
  currency: {
    copper: number;
    silver: number;
    gold: number;
  };
  friends: string[];
  party_id: string;
  guild_id: string;
  guild_name: string;
  guild: string[];
  config: Array<{
    fps: number;
    music_volume: number;
    effects_volume: number;
    muted: boolean;
    hotbar_config: any[];
  }>;
  questlog: QuestLogData;
  isAdmin: boolean;
  isGuest: boolean;
  isStealth: boolean;
  isNoclip: boolean;
  isDead: number;
  corpse: { map: string; x: number; y: number } | null;
  inventory: any;
  party: string[];
  friends: string[];
  collectables: object[Collectable];
  learnedSpells: {[key: string]: { sprite: Nullable<string> }};
  hotbarConfig: string | null;
  equipment: Equipment;
}

declare interface Collectable {
  type: string;
  item: string;
  username: string;
  icon: Nullable<string | null | Buffer<any>>;
}

declare interface SpriteSheetTemplate {
  name: string;
  imageSource: string;
  frameWidth: number;
  frameHeight: number;
  columns: number;
  rows: number;
  animations: {
    [animationName: string]: SpriteSheetAnimation;
  };
}

declare interface SpriteSheetAnimation {
  directions: any;
  frames: number[];
  frameDuration: number;
  loop: boolean;
  offset: Nullable<{
    x: number;
    y: number;
  }>;
}

declare interface AnimationFrame {
  imageElement: HTMLImageElement;
  width: number;
  height: number;
  delay: number;
  offset: Nullable<{
    x: number;
    y: number;
  }>;
}

declare interface AnimationLayer {
  type: 'mount' | 'body' | 'head' | 'armor_helmet' | 'armor_shoulderguards' | 'armor_neck' | 'armor_hands' | 'armor_chest' | 'armor_feet' | 'armor_legs' | 'armor_weapon';
  spriteSheet: Nullable<SpriteSheetTemplate>;
  frames: AnimationFrame[];
  currentFrame: number;
  lastFrameTime: number;
  zIndex: number;
  visible: boolean;
}

declare interface SpriteSheetCache {
  [spriteSheetName: string]: {
    imageElement: HTMLImageElement;
    template: SpriteSheetTemplate;
    extractedFrames: {
      [frameIndex: number]: HTMLImageElement;
    };
  };
}

declare interface ServerRegistrationConfig {
  gatewayUrl: string;
  assetServerUrl: Nullable<string>;
  serverId: string;
  description: Nullable<string>;
  host: string;
  publicHost: Nullable<string>;
  port: number;
  wtPort?: number;
  wtEnabled?: boolean;
  maxConnections: number;
  heartbeatInterval: number;
}

declare interface LootTableEntry {
  itemName: string; minQuantity: number; maxQuantity: number; dropChance: number; quality?: string;
}
declare interface LootRollResult {
  index: number; itemName: string; quantity: number; quality: string; iconUrl: string;
}

/** The stats the player editor sets: what the stats table holds, before equipment. */
declare interface PlayerEditorStats {
  level: number;
  xp: number;
  max_xp: number;
  health: number;
  max_health: number;
  stamina: number;
  max_stamina: number;
  stat_damage: number;
  stat_armor: number;
  stat_critical_chance: number;
  stat_critical_damage: number;
  stat_avoidance: number;
}

declare interface PlayerEditorItem {
  name: string;
  quantity: number;
  equipped: boolean;
  quality: Nullable<string>;
  type: Nullable<string>;
  icon: Nullable<string>;
  equipment_slot: Nullable<string>;
  level_requirement: Nullable<number>;
  /** False when the item's definition has been deleted: the row can only be removed. */
  known: boolean;
}

/** One player as the server holds them; the player editor is sent a fresh one after every change. */
declare interface PlayerEditorSnapshot {
  username: string;
  userid: number;
  online: boolean;
  /** The connection id while online: what the other admin commands take as an id. */
  sessionId: Nullable<string>;
  isAdmin: boolean;
  isGuest: boolean;
  banned: boolean;
  /** 0 alive, 1 a corpse awaiting release, 2 a ghost. */
  dead: number;
  location: { map: string; x: number; y: number; direction: string };
  stats: PlayerEditorStats;
  /** Totals with equipment and effects applied, known only while the player is online. */
  totals: Nullable<Record<string, number>>;
  currency: Currency;
  inventory: PlayerEditorItem[];
  inventorySlots: number;
  equipment: Record<string, Nullable<string>>;
  bags: Record<string, Nullable<string>>;
  collectables: Array<{ type: string; item: string; icon: Nullable<string>; known: boolean }>;
  spells: string[];
  friends: string[];
  guild: Nullable<{ id: number; name: string; leader: string; members: string[] }>;
  party: Nullable<{ id: number; leader: string; members: string[] }>;
  quests: {
    active: Array<{
      id: number;
      name: string;
      state: QuestState;
      objectives: Array<{ id: number; label: string; count: number; required: number }>;
    }>;
    completed: Array<{ id: number; name: string }>;
  };
  permissions: string[];
}

/** What the player editor offers in its pickers, and the limits it validates against. */
declare interface PlayerEditorOptions {
  /** The admin using the editor: their own permissions and admin status are not theirs to change. */
  editor: string;
  slots: string[];
  directions: string[];
  collectableTypes: string[];
  /** Map sizes are in pixels, the unit positions are stored in. */
  maps: Array<{ name: string; width: number; height: number }>;
  mounts: Array<{ name: string; icon: Nullable<string> }>;
  spells: Array<{ name: string; icon: Nullable<string> }>;
  quests: Array<{ id: number; name: string; level: number }>;
  guilds: Array<{ id: number; name: string; leader: string; members: number }>;
  permissionTypes: string[];
  limits: { level: number; value: number; currency: Currency };
}

/** One online player as the control panel lists them. */
declare interface ControlPanelPlayer {
  /** The connection id: what the admin commands take as an id. */
  id: string;
  username: string;
  level: number;
  map: string;
  isAdmin: boolean;
  isStealth: boolean;
  isGuest: boolean;
  /** 0 alive, 1 a corpse awaiting release, 2 a ghost. */
  dead: number;
  /** Seconds since they logged in, or null where that is not known. */
  onlineFor: Nullable<number>;
}

/**
 * One reading of the control panel's history: seconds since the epoch, players
 * online, event loop delay in ms, memory in MB, creatures awake. A figure that
 * was not known is null.
 */
declare type ControlPanelReading = Array<Nullable<number>>;

/** One thing an admin did through the control panel. */
declare interface ControlPanelActivity {
  /** Counts up from 1: the panel asks for what came after the last one it holds. */
  seq: number;
  /** When, in milliseconds since the epoch. */
  at: number;
  /** The admin, as stored. */
  by: string;
  action: string;
  /** The player it was done to, as stored. */
  target: Nullable<string>;
  /** The values that went with it: the item, the map, the message. */
  details: Record<string, string | number | boolean>;
  /** What the command answered. */
  said: string;
}

/** What the control panel shows. It is rebuilt from memory every time the panel asks. */
declare interface ControlPanelData {
  /** The admin looking at the panel. */
  viewer: { id: string; username: string; map: string; isNoclip: boolean; isStealth: boolean };
  /** Everyone online the viewer may see. */
  players: ControlPanelPlayer[];
  status: {
    /** Seconds since the server process started. */
    uptime: number;
    online: number;
    /** The most players online at once since the server started, and when (ms since the epoch). */
    peak: { online: number; at: number };
    memoryMb: number;
    eventLoopLagMs: Nullable<number>;
    restartScheduled: boolean;
    whitelist: { enabled: boolean; size: number };
    /** What the /creature-stats route reports. */
    creatures: Nullable<Record<string, unknown>>;
  };
  /** The viewer's map with its weather, and every world. `showing` is the weather a "random" world has settled on. */
  world: { map: string; weather: string; showing: string; worlds: Array<{ name: string; weather: string; showing: string; players: number }> };
  /** For a viewer who handles reports: how many are open. */
  reports?: { open: number };
  /** Sent when asked in full: which controls the viewer's permissions allow, by action. */
  can?: Record<string, boolean>;
  /** Sent when asked in full: what the map and weather controls pick from. */
  options?: { maps: string[]; weathers: string[] };
  /** Sent when asked in full: how many accounts there are, guests aside, and how many are banned. Null if that could not be read. */
  accounts?: Nullable<{ registered: number; banned: number }>;
  /**
   * The readings the charts are drawn from: every 15 seconds for the last hour,
   * every minute for the last 24. All of them when asked in full; on a refresh,
   * the ones newer than the panel says it holds.
   */
  history?: { recent: ControlPanelReading[]; day: ControlPanelReading[] };
  /** What admins did through the panel, oldest first: sent as the history is. */
  activity?: ControlPanelActivity[];
}

/** A list the control panel asked for. */
declare type ControlPanelResults =
  | { kind: "players"; query: string; players: Array<{ username: string; userid: number; online: boolean }>; truncated: number }
  | { kind: "items"; query: string; items: Array<Pick<Item, "name" | "quality" | "type" | "icon" | "equipment_slot" | "level_requirement">>; truncated: number }
  | { kind: "permissions"; target: string; held: string[]; types: string[]; isAdmin: boolean }
  | { kind: "moderation"; target: string; mute: Nullable<import("./src/systems/mutes").Mute>; openReports: number }
  | { kind: "reports"; open: import("./src/systems/reports").Report[]; resolved: import("./src/systems/reports").Report[] }
  | { kind: "lootTables"; tables: Array<{ id: number; name: string; items: Array<{ id: number; item_name: string; min_quantity: number; max_quantity: number; drop_chance: number; quality: string }> }> };

/** The answer to one control panel request. */
declare interface ControlPanelResult {
  ok: boolean;
  /** Why it was refused. */
  errors: string[];
  /** What the command said when it ran. */
  replies: string[];
  action: string;
  /** The id the panel gave the request, to match the answer to it. */
  requestId: Nullable<string>;
  /** The player may not use the panel at all. */
  denied?: boolean;
  /** The same request had already arrived: it was not run a second time. */
  duplicate?: boolean;
  /** How things stand after an action. */
  data?: ControlPanelData;
}

declare interface PluginHandlerFn {
  (wt: any, currentPlayer: any, data: any, sendPacketFn: (wt: any, packets: any[]) => void): Promise<void>;
}

declare interface EngineAPI {
  addPacketTypes(types: string[]): void;
  addPacketBuilders(builders: Record<string, (...args: any[]) => any[]>): void;
  registerHandlers(handlers: Record<string, PluginHandlerFn>): void;
  onWarpCollision(interceptor: (warp: any, wt: any, player: any, sendPacket: any) => Promise<boolean>): void;
  onPacket(interceptor: (type: string, data: any, wt: any, player: any) => boolean): void;
  addHttpRoute(method: string, route: string, handler: (req: Request) => Promise<Response>): void;
  teleportPlayer(playerObj: any, mapName: string, x: number, y: number): Promise<void>;
  registerSpell(spell: SpellData): Promise<void>;
}

declare interface GamePlugin {
  register: (engine: EngineAPI, manifest: PluginManifest) => void | Promise<void>;
  unregister?: (manifest: PluginManifest) => void | Promise<void>;
}

declare interface PluginManifest {
    name: string;
    version: string;
    description?: string;
    entry: string;
    requires?: {
        engine?: string;
    };
    provides: string[];
    spells?: SpellData[];
}

declare interface LoadedPlugin {
    manifest: PluginManifest;
    module: GamePlugin;
    dirPath: string;
}
