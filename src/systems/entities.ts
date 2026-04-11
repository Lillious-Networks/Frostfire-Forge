import query from "../controllers/sqldatabase";
import assetCache from "../services/assetCache";

function toMysqlDatetime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

const entities = {
  async add(entity: Entity) {
    if (!entity || !entity?.map || !entity?.position) return;
    const last_updated = toMysqlDatetime(Date.now());
    const x = entity.position.x || 0;
    const y = entity.position.y || 0;
    const particles = Array.isArray(entity.particles)
      ? entity.particles.join(",")
      : (entity.particles || "");
    const aggro_type = entity.aggro_type || "neutral";

    const response = await query(
      `INSERT INTO entities (last_updated, map, name, position, aggro_type, level, max_health,
        particles, sprite_type, sprite_body, sprite_head, sprite_helmet, sprite_shoulderguards, sprite_neck,
        sprite_hands, sprite_chest, sprite_feet, sprite_legs, sprite_weapon, aggro_range, speed, aggro_leash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        last_updated,
        entity.map,
        entity.name || null,
        `${x},${y}`,
        aggro_type,
        entity.level || 1,
        entity.max_health || 100,
        particles,
        (entity as any).sprite_type || 'animated',
        entity.sprite_body || null,
        entity.sprite_head || null,
        entity.sprite_helmet || null,
        entity.sprite_shoulderguards || null,
        entity.sprite_neck || null,
        entity.sprite_hands || null,
        entity.sprite_chest || null,
        entity.sprite_feet || null,
        entity.sprite_legs || null,
        entity.sprite_weapon || null,
        (entity as any).aggro_range || 300,
        (entity as any).speed || 2.0,
        (entity as any).aggro_leash || 600,
      ]
    );

    assetCache.set("entities", response);

    return response;
  },

  async remove(entity: Entity) {
    if (!entity?.id) return;
    const response = await query("DELETE FROM entities WHERE id = ?", [entity.id]);

    assetCache.set("entities", response);

    return response;
  },

  async list() {
    const response = (await query("SELECT * FROM entities")) as any[];
    const entities: Entity[] = [];

    for (const entity of response) {
      const map = entity?.map as string;
      const position: PositionData = {
        x: Number(entity?.position?.split(",")[0]),
        y: Number(entity?.position?.split(",")[1]),
        direction: "down",
      };

      entities.push({
        id: entity?.id as number,
        last_updated: (entity?.last_updated as number) || null,
        map,
        name: entity?.name || null,
        position,
        health: entity?.health || 100,
        max_health: entity?.max_health || 100,
        level: entity?.level || 1,
        aggro_type: (entity?.aggro_type as 'friendly' | 'neutral' | 'aggressive') || 'neutral',
        particles: entity?.particles as Particle[],
        sprite_type: (entity?.sprite_type as 'none' | 'static' | 'animated') || 'animated',
        sprite_body: entity?.sprite_body || null,
        sprite_head: entity?.sprite_head || null,
        sprite_helmet: entity?.sprite_helmet || null,
        sprite_shoulderguards: entity?.sprite_shoulderguards || null,
        sprite_neck: entity?.sprite_neck || null,
        sprite_hands: entity?.sprite_hands || null,
        sprite_chest: entity?.sprite_chest || null,
        sprite_feet: entity?.sprite_feet || null,
        sprite_legs: entity?.sprite_legs || null,
        sprite_weapon: entity?.sprite_weapon || null,
        aggro_range: entity?.aggro_range || 300,
        speed: entity?.speed || 6.0,
        aggro_leash: entity?.aggro_leash || 600,
      } as any);
    }

    await assetCache.set("entities", entities);
    return entities;
  },

  async find(entity: Entity) {
    if (!entity?.id) return;
    const response = await query("SELECT * FROM entities WHERE id = ?", [entity.id]);

    assetCache.set("entities", response);

    return response;
  },

  async update(entity: Entity) {
    if (!entity?.id || !entity?.map || !entity?.position) return;
    const last_updated = toMysqlDatetime(Date.now());
    const x = entity.position.x || 0;
    const y = entity.position.y || 0;
    const particles = Array.isArray(entity.particles)
      ? entity.particles.join(",")
      : (entity.particles || "");
    const aggro_type = entity.aggro_type || "neutral";
    const direction = (entity as any).location?.direction || "down";

    const response = await query(
      `UPDATE entities SET last_updated = ?, map = ?, name = ?, position = ?, direction = ?, aggro_type = ?,
        level = ?, max_health = ?, particles = ?, sprite_type = ?, sprite_body = ?, sprite_head = ?,
        sprite_helmet = ?, sprite_shoulderguards = ?, sprite_neck = ?, sprite_hands = ?,
        sprite_chest = ?, sprite_feet = ?, sprite_legs = ?, sprite_weapon = ?,
        aggro_range = ?, speed = ?, aggro_leash = ? WHERE id = ?`,
      [
        last_updated,
        entity.map,
        entity.name || null,
        `${x},${y}`,
        direction,
        aggro_type,
        entity.level || 1,
        entity.max_health || 100,
        particles,
        (entity as any).sprite_type || 'animated',
        entity.sprite_body || null,
        entity.sprite_head || null,
        entity.sprite_helmet || null,
        entity.sprite_shoulderguards || null,
        entity.sprite_neck || null,
        entity.sprite_hands || null,
        entity.sprite_chest || null,
        entity.sprite_feet || null,
        entity.sprite_legs || null,
        entity.sprite_weapon || null,
        (entity as any).aggro_range || 300,
        (entity as any).speed || 2.0,
        (entity as any).aggro_leash || 600,
        entity.id,
      ]
    );

    assetCache.set("entities", response);

    return response;
  },

  async move(entity: Entity) {
    if (!entity?.id || !entity?.position) return;
    const last_updated = toMysqlDatetime(Date.now());
    const x = entity.position.x || 0;
    const y = entity.position.y || 0;

    const response = await query(
      "UPDATE entities SET last_updated = ?, position = ? WHERE id = ?",
      [last_updated, `${x},${y}`, entity.id]
    );

    assetCache.set("entities", response);

    return response;
  },
};

export default entities;