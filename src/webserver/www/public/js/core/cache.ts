class Cache {
  private static instance: Cache;

  players: Set<any> = new Set();
  npcs: any[] = [];
  audio: any[] = [];
  animations: Map<string, any> = new Map();

  private constructor() {}

  static getInstance(): Cache {
    if (!Cache.instance) {
      Cache.instance = new Cache();
    }
    return Cache.instance;
  }
}

export default Cache;