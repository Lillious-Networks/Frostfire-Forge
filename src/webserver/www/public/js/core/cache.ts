class Cache {
  private static instance: Cache;

  players: Set<any> = new Set();
  npcs: any[] = [];
  audio: any[] = [];
  animations: Map<string, any> = new Map();
  mount: string | null = null;
  projectileIcons: Map<string, HTMLImageElement> = new Map();
  projectiles: Array<{
    startX: number;
    startY: number;
    targetPlayerId: string;
    currentX: number;
    currentY: number;
    startTime: number;
    duration: number;
    spell: string;
  }> = [];
  inventory: any[] = [];
  equipment: any = {};
  inventoryConfig: any = null;

  private constructor() {}

  static getInstance(): Cache {
    if (!Cache.instance) {
      Cache.instance = new Cache();
    }
    return Cache.instance;
  }
}

export default Cache;