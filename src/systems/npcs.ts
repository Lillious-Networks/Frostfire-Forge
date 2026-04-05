import query from "../controllers/sqldatabase";
import assetCache from "../services/assetCache";

function toMysqlDatetime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

const npcs = {
  async add(npc: Npc) {
    if (!npc || !npc?.map || !npc?.position) return;
    const last_updated = toMysqlDatetime(Date.now());
    const hidden = npc.hidden ? 1 : 0;
    const x = npc.position.x || 0;
    const y = npc.position.y || 0;
    const direction = npc.position.direction || "down";
    const particles = Array.isArray(npc.particles)
      ? npc.particles.join(",")
      : (npc.particles || "");
    const quest = npc.quest || null;
    const sprite_type = npc.sprite_type || "none";

    const response = await query(
      `INSERT INTO npcs (last_updated, map, name, position, direction, hidden, script, dialog, particles, quest,
        sprite_type, sprite_body, sprite_head, sprite_helmet, sprite_shoulderguards, sprite_neck,
        sprite_hands, sprite_chest, sprite_feet, sprite_legs, sprite_weapon)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        last_updated,
        npc.map,
        npc.name || null,
        `${x},${y}`,
        direction,
        hidden,
        npc.script || null,
        npc.dialog || null,
        particles,
        quest,
        sprite_type,
        npc.sprite_body || null,
        npc.sprite_head || null,
        npc.sprite_helmet || null,
        npc.sprite_shoulderguards || null,
        npc.sprite_neck || null,
        npc.sprite_hands || null,
        npc.sprite_chest || null,
        npc.sprite_feet || null,
        npc.sprite_legs || null,
        npc.sprite_weapon || null,
      ]
    );

    assetCache.set("npcs", response);

    return response;
  },

  async remove(npc: Npc) {
    if (!npc?.id) return;
    const response = await query("DELETE FROM npcs WHERE id = ?", [npc.id]);

    assetCache.set("npcs", response);

    return response;
  },

  async list() {
    const response = (await query("SELECT * FROM npcs")) as any[];
    const npcs: Npc[] = [];

    for (const npc of response) {
      const map = npc?.map as string;
      const position: PositionData = {
        x: Number(npc?.position?.split(",")[0]),
        y: Number(npc?.position?.split(",")[1]),
        direction: npc?.direction || "down",
      };

      npcs.push({
        id: npc?.id as number,
        last_updated: (npc?.last_updated as number) || null,
        map,
        name: npc?.name || null,
        position,
        hidden: npc?.hidden === 1,
        script: npc?.script as string,
        dialog: npc?.dialog as string,
        particles: npc?.particles as Particle[],
        quest: npc?.quest as number,
        sprite_type: (npc?.sprite_type as 'none' | 'static' | 'animated') || 'none',
        sprite_body: npc?.sprite_body || null,
        sprite_head: npc?.sprite_head || null,
        sprite_helmet: npc?.sprite_helmet || null,
        sprite_shoulderguards: npc?.sprite_shoulderguards || null,
        sprite_neck: npc?.sprite_neck || null,
        sprite_hands: npc?.sprite_hands || null,
        sprite_chest: npc?.sprite_chest || null,
        sprite_feet: npc?.sprite_feet || null,
        sprite_legs: npc?.sprite_legs || null,
        sprite_weapon: npc?.sprite_weapon || null,
      });
    }

    return npcs;
  },

  async find(npc: Npc) {
    if (!npc?.id) return;
    const response = await query("SELECT * FROM npcs WHERE id = ?", [npc.id]);

    assetCache.set("npcs", response);

    return response;
  },

  async update(npc: Npc) {
    if (!npc?.id || !npc?.map || !npc?.position) return;
    const last_updated = toMysqlDatetime(Date.now());
    const hidden = npc.hidden ? 1 : 0;
    const x = npc.position.x || 0;
    const y = npc.position.y || 0;
    const direction = npc.position.direction;
    const particles = Array.isArray(npc.particles)
      ? npc.particles.join(",")
      : (npc.particles || "");
    const quest = npc.quest || null;
    const sprite_type = npc.sprite_type || "none";

    const response = await query(
      `UPDATE npcs SET last_updated = ?, map = ?, name = ?, position = ?, direction = ?, hidden = ?, script = ?,
        dialog = ?, particles = ?, quest = ?, sprite_type = ?, sprite_body = ?, sprite_head = ?,
        sprite_helmet = ?, sprite_shoulderguards = ?, sprite_neck = ?, sprite_hands = ?,
        sprite_chest = ?, sprite_feet = ?, sprite_legs = ?, sprite_weapon = ? WHERE id = ?`,
      [
        last_updated,
        npc.map,
        npc.name || null,
        `${x},${y}`,
        direction,
        hidden,
        npc.script,
        npc.dialog,
        particles,
        quest,
        sprite_type,
        npc.sprite_body || null,
        npc.sprite_head || null,
        npc.sprite_helmet || null,
        npc.sprite_shoulderguards || null,
        npc.sprite_neck || null,
        npc.sprite_hands || null,
        npc.sprite_chest || null,
        npc.sprite_feet || null,
        npc.sprite_legs || null,
        npc.sprite_weapon || null,
        npc.id,
      ]
    );

    assetCache.set("npcs", response);

    return response;
  },

  async move(npc: Npc) {
    if (!npc?.id || !npc?.position) return;
    const last_updated = toMysqlDatetime(Date.now());

    const response = await query(
      "UPDATE npcs SET last_updated = ?, position = ? WHERE id = ?",
      [last_updated, JSON.stringify(npc.position), npc.id]
    );

    assetCache.set("npcs", response);

    return response;
  },
};

export default npcs;
