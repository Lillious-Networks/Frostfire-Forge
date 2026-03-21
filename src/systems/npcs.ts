import query from "../controllers/sqldatabase";
import assetCache from "../services/assetCache";

const npcs = {
  async add(npc: Npc) {
    if (!npc || !npc?.map || !npc?.position) return;
    const last_updated = Date.now();
    const hidden = npc.hidden ? 1 : 0;
    const x = npc.position.x || 0;
    const y = npc.position.y || 0;
    const direction = npc.position.direction || "down";
    const particles = npc.particles || [];
    const quest = npc.quest || null;

    const response = await query(
      "INSERT INTO npcs (last_updated, map, position, direction, hidden, script, dialog, particles, quest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        last_updated,
        npc.map,
        `${x},${y}`,
        direction,
        hidden,
        npc.script || null,
        npc.dialog || null,
        JSON.stringify(particles),
        quest,
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
        position,
        hidden: npc?.hidden === 1,
        script: npc?.script as string,
        dialog: npc?.dialog as string,
        particles: npc?.particles as Particle[],
        quest: npc?.quest as number,
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
    const last_updated = Date.now();
    const hidden = npc.hidden ? 1 : 0;
    const x = npc.position.x || 0;
    const y = npc.position.y || 0;
    const direction = npc.position.direction;
    const particles = npc.particles || [];
    const quest = npc.quest || null;

    const response = await query(
      "UPDATE npcs SET last_updated = ?, map = ?, position = ?, direction = ?, hidden = ?, script = ?, dialog = ?, particles = ?, quest = ? WHERE id = ?",
      [
        last_updated,
        npc.map,
        `${x},${y}`,
        direction,
        hidden,
        npc.script,
        npc.dialog,
        JSON.stringify(particles),
        quest,
        npc.id,
      ]
    );

    assetCache.set("npcs", response);

    return response;
  },

  async move(npc: Npc) {
    if (!npc?.id || !npc?.position) return;
    const last_updated = Date.now();

    const response = await query(
      "UPDATE npcs SET last_updated = ?, position = ? WHERE id = ?",
      [last_updated, JSON.stringify(npc.position), npc.id]
    );

    assetCache.set("npcs", response);

    return response;
  },
};

export default npcs;
