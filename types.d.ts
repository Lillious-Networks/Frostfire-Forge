type Nullable<T> = T | null;

// Define the packet structure
declare interface Packet {
  type: PacketType;
  data: PacketData;
  id: Nullable<string>;
  useragent: Nullable<string>;
  language: Nullable<string>;
  publicKey: Nullable<string>;
}

// Define the packet type
declare interface PacketType {
  [key: number]: string;
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
  publicKey: string;
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
  hash: string;
  compressed: Buffer;
}

// Define tileset data
declare interface TilesetData {
  name: string;
  data: Buffer;
  hash: string;
}

// Define script data
declare interface ScriptData {
  name: string;
  data: string;
  hash: string;
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
}

// Define location data
declare interface LocationData {
  [key: string]: string;
}

// Define location
declare interface PositionData {
  x: number;
  y: number;
  direction: string;
}

// Define stats data
declare interface StatsData {
  health: number;
  max_health: number;
  stamina: number;
  max_stamina: number;
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
  hash: string;
}

// Define Sprite data
declare interface SpriteData {
  name: string;
  data: Buffer;
  hash: string;
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