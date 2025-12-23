type Nullable<T> = T | null;

// Define Database Engines
type DatabaseEngine = "mysql" | "postgres" | "sqlite";

// Define the packet structure
declare interface Packet {
  type: PacketType;
  data: PacketData;
  id: Nullable<string>;
  useragent: Nullable<string>;
  language: Nullable<string>;
  publicKey: Nullable<string>;
  chatDecryptionKey: Nullable<string>;
}

// Define the packet type
declare interface PacketType {
  [key: any]: string;
}

// Define the packet data
declare interface PacketData {
  data: Array<any>;
}

declare interface Subscription {
  event: string;
  callback: (data: any) => void;
}

// Define the identity of a client
declare interface Identity {
  id: string;
  useragent: string;
  chatDecryptionKey: string;
}

// Define client rate limit
declare interface ClientRateLimit {
  id: string;
  requests: number;
  rateLimited: boolean;
  time: Nullable<number>;
  windowTime: number;
}

// Define RateLimit options
declare interface RateLimitOptions {
  maxRequests: number;
  time: number;
  maxWindowTime: number;
}

// Define map data
declare interface MapData {
  name: string;
  data: any;
  compressed: Buffer;
}

// Define tileset data
declare interface TilesetData {
  name: string;
  data: Buffer;
}

// Define script data
declare interface ScriptData {
  name: string;
  data: string;
}

// Define player data
declare interface Player {
  id?: string;
  username?: string;
  position?: PositionData;
  location?: LocationData;
  map?: string;
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

type NullablePlayer = Player | null;

// Define inventory item
declare interface InventoryItem {
  name: string;
  quantity: Nullable<number>;
}

// Define item data
declare interface Item {
  name: string;
  quality: string;
  description: string;
  icon: Nullable<string>;
}

// Define icon data
declare interface Icon {
  name: string;
  data: Buffer;
}

// Define npc data
declare interface Npc {
  id: Nullable<number>;
  last_updated: Nullable<number>;
  map: string;
  position: PositionData;
  hidden: boolean;
  script: Nullable<string>;
  dialog: Nullable<string>;
  particles: Nullable<Particle[]>;
  quest: Nullable<number>;
}

// Define location data
declare interface LocationData {
  [key: string]: string;
}

// Define location
declare interface PositionData {
  x: number;
  y: number;
  direction: string | null;
}

// Define stats data
declare interface StatsData {
  health: number;
  max_health: number;
  stamina: number;
  max_stamina: number;
  level: number;
  xp: number;
  max_xp: number;
  crit_damage: number;
  crit_chance: number;
}

// Define config data
declare interface ConfigData {
  [key: string]: number | string | boolean;
}

// Define weapon data
declare interface WeaponData {
  name: string;
  damage: number;
  mana: number;
  range: number;
  quality: string;
  type: string;
  description: string;
}

// Define Sound effects data
declare interface SoundData {
  name: string;
  data: Buffer;
  pitch?: number;
}

// Define Sprite data
declare interface SpriteSheetData {
  name: string;
  width: number;
  height: number;
  data: Buffer;
}

// Define Sprite data
declare interface SpriteData {
  name: string;
  data: Buffer;
  hash?: string;
}

// Define Spell data
declare interface SpellData {
  name: string;
  damage: number;
  mana: number;
  range: number;
  type: string;
  cast_time: number;
  description: string;
}

type NPCScript = {
  onCreated: (this: Npc) => void;
  say: (this: Npc, message: string) => void;
};

declare interface Particle {
  name: string | null; // Name of the particle
  size: number; // Size of the particle
  color: string | null; // Color of the particle (optional)
  velocity: {
      x: number; // Velocity of the particle in the x direction
      y: number; // Velocity of the particle in the y direction
  };
  lifetime: number; // Lifetime of the particle in seconds
  scale: number; // Scale of the particle
  opacity: number; // Opacity of the particle
  visible: boolean; // Whether the particle is visible
  gravity: {
      x: number; // Gravity of the particle in the x direction
      y: number; // Gravity of the particle in the y direction
  }; // Whether the particle has gravity
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

// Add data property to the WebSocket object but keep the existing properties
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

declare interface Currency {
  copper: number;
  silver: number;
  gold: number;
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
  stats: {
    max_health: number;
    health: number;
    max_stamina: number;
    stamina: number;
    xp: number;
    max_xp: number;
    level: number;
    crit_chance: number;
    crit_damage: number;
  };
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
  party_members: string[];
  friends: string[];
}