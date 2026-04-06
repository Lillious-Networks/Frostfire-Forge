type Nullable<T> = T | null;

type DatabaseEngine = "mysql" | "postgres" | "sqlite";

declare interface Packet {
  type: PacketType;
  data: PacketData;
  id: Nullable<string>;
  useragent: Nullable<string>;
  language: Nullable<string>;
  publicKey: Nullable<string>;
  chatDecryptionKey: Nullable<string>;
}

declare interface PacketType {
  [key: any]: string;
}

declare interface PacketData {
  data: Array<any>;
}

declare interface Subscription {
  event: string;
  callback: (data: any) => void;
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
  id?: string;
  username?: string;
  position?: PositionData;
  location?: LocationData;
  map?: string;
  layer?: string | null;
  stats?: StatsData;
  isStealth?: boolean;
  isAdmin?: boolean;
  isGuest?: boolean;
  isNoclip?: boolean;
  pvp?: boolean;
  last_attack?: number;
  animation?: string;
  friends?: string[];
  invitiations?: string[];
  mounted: boolean;
  mount_type?: string | null;
}

declare interface QuestLogData {
  completed: number[];
  incomplete: number[];
}

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
  affected_by_weather?: boolean;
}

type NullablePlayer = Player | null;

declare interface InventoryItem {
  name: string;
  quantity: Nullable<number>;
}

type ItemType = "consumable" | "equipment" | "material" | "quest" | "miscellaneous";
type ItemQuality = "common" | "uncommon" | "rare" | "epic" | "legendary";
type ItemSlot = "helmet" | "necklace" | "shoulderguards" | "cape" | "chestplate" | "wristguards" | "gloves" | "belt" | "pants" | "boots" | "ring_1" | "ring_2" | "trinket_1" | "trinket_2" | "weapon";

declare interface Item {
  name: string;
  quality: ItemQuality;
  type: ItemType;
  description: string;
  icon: Nullable<string>;
  stat_armor?: Nullable<number>;
  stat_damage?: Nullable<number>;
  stat_critical_chance?: Nullable<number>;
  stat_critical_damage?: Nullable<number>;
  stat_health?: Nullable<number>;
  stat_stamina?: Nullable<number>;
  stat_avoidance?: Nullable<number>;
  level_requirement: Nullable<number>;
  equipable: boolean;
  equipment_slot: Nullable<ItemSlot>;
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
  particles: Nullable<Particle[]>;
  quest: Nullable<number>;
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
  pitch?: number;
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
  hash?: string;
}

declare interface SpellData {
  id?: number;
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
  players?: number;
  max_players: number;
  default_map: string;
}

declare interface Quest {
  id: number;
  name: string;
  description: string;
  reward: number;
  xp_gain: number;
  required_quest: number;
  required_level: number;
}

declare interface WebSocket {
  data: {
    [key: string]: any;
  };
}

declare interface MapProperties {
  name: string;
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  warps?: Nullable<WarpObject[]>;
  graveyards?: Nullable<GraveyardObject[]>;
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
}

declare interface GraveyardObject {
  name: string;
  position: {
    x: number;
    y: number;
  };
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
  error?: string;
  data?: PlayerData;
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
  config: Array<{
    fps: number;
    music_volume: number;
    effects_volume: number;
    muted: boolean;
    hotbar_config: any[];
  }>;
  questlog: {
    completed: string[];
    incomplete: string[];
  };
  isAdmin: boolean;
  isGuest: boolean;
  isStealth: boolean;
  isNoclip: boolean;
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
  icon?: string | null | Buffer<any>;
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
  offset?: {
    x: number;
    y: number;
  };
}

declare interface AnimationFrame {
  imageElement: HTMLImageElement;
  width: number;
  height: number;
  delay: number;
  offset?: {
    x: number;
    y: number;
  };
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
  assetServerUrl?: string;
  serverId: string;
  description?: string;
  host: string;
  publicHost?: string;
  port: number;
  wsPort: number;
  maxConnections: number;
  heartbeatInterval: number;
}