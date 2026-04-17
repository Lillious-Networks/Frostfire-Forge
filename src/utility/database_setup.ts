
import query from "../controllers/sqldatabase";
import log from "../modules/logger";
const database = process.env.DATABASE_NAME || "TEMP_Mystika";

const createDatabase = async () => {
  log.info("Creating database...");
  const sql = `CREATE DATABASE IF NOT EXISTS ${database};`;
  await query(sql);
};

const useDatabase = async () => {
  const useDatabaseSql = `USE ${database};`;
  await query(useDatabaseSql);
};

const createAccountsTable = async () => {
  log.info("Creating accounts table...");
  const sql = `
    CREATE TABLE IF NOT EXISTS accounts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        username VARCHAR(255) NOT NULL UNIQUE,
        token VARCHAR(255) UNIQUE DEFAULT NULL,
        password_hash VARCHAR(500) NOT NULL,
        last_login DATETIME DEFAULT NULL,
        online INT DEFAULT 0 NOT NULL,
        role INT DEFAULT 0 NOT NULL,
        banned INT DEFAULT 0 NOT NULL,
        ip_address VARCHAR(255) DEFAULT NULL,
        geo_location VARCHAR(255) DEFAULT NULL,
        verification_code VARCHAR(1000) DEFAULT NULL,
        reset_password_code VARCHAR(1000) DEFAULT NULL,
        map VARCHAR(255) DEFAULT 'overworld' NOT NULL,
        position VARCHAR(255) DEFAULT '0,0' NOT NULL,
        session_id VARCHAR(255) UNIQUE DEFAULT NULL,
        stealth INT DEFAULT 0 NOT NULL,
        direction VARCHAR(10) DEFAULT 'down' NOT NULL,
        verified INT DEFAULT 0 NOT NULL,
        noclip INT DEFAULT 0 NOT NULL,
        party_id INT DEFAULT NULL,
        guild_id INT DEFAULT NULL,
        guest_mode INT DEFAULT 0 NOT NULL
      );
  `;
  await query(sql);
};

const createAllowedIpsTable = async () => {
  log.info("Creating allowed_ips table...");
  const sql = `
    CREATE TABLE IF NOT EXISTS allowed_ips (
        id INT AUTO_INCREMENT PRIMARY KEY,
        ip VARCHAR(45) NOT NULL UNIQUE
    )
  `;
  await query(sql);
};

const createBlockedIpsTable = async () => {
  log.info("Creating blocked_ips table...");
  const sql = `
    CREATE TABLE IF NOT EXISTS blocked_ips (
        id INT AUTO_INCREMENT PRIMARY KEY,
        ip VARCHAR(45) NOT NULL UNIQUE
    )
  `;
  await query(sql);
};

const insertLocalhost = async () => {
  log.info("Inserting localhost and ::1 as allowed IPs...");
  const checkSql = `SELECT COUNT(*) as count FROM allowed_ips WHERE ip IN ('127.0.0.1', '::1')`;
  const result = await query(checkSql) as Array<{ count: number }>;

  if (result[0]?.count === 0) {
    const sql = `INSERT INTO allowed_ips (ip) VALUES ('127.0.0.1'), ('::1')`;
    await query(sql);
  } else {
    log.debug("Localhost IPs already exist - skipping");
  }
};

const createInventoryTable = async () => {
  log.info("Creating inventory table...");
  const sql = `
    CREATE TABLE IF NOT EXISTS inventory (
        id INT AUTO_INCREMENT PRIMARY KEY UNIQUE NOT NULL,
        username VARCHAR(255) NOT NULL,
        item VARCHAR(255) NOT NULL,
        quantity INT NOT NULL,
        equipped INT NOT NULL DEFAULT 0
    )
  `;
  await query(sql);
};

const createItemsTable = async () => {
  log.info("Creating items table...");
  const sql = `
    CREATE TABLE IF NOT EXISTS items (
        id INT AUTO_INCREMENT PRIMARY KEY UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL UNIQUE,
        type VARCHAR(255) NOT NULL,
        quality VARCHAR(255) NOT NULL,
        description VARCHAR(255) DEFAULT NULL,
        icon VARCHAR(1000) DEFAULT NULL,
        stat_armor INT DEFAULT NULL,
        stat_damage INT DEFAULT NULL,
        stat_critical_chance INT DEFAULT NULL,
        stat_critical_damage INT DEFAULT NULL,
        stat_health INT DEFAULT NULL,
        stat_stamina INT DEFAULT NULL,
        stat_avoidance INT DEFAULT NULL,
        level_requirement INT DEFAULT NULL,
        equipment_slot VARCHAR(255) DEFAULT NULL,
        equipable INT NOT NULL DEFAULT 0
    )
  `;
  await query(sql);
};

const createStatsTable = async () => {
  log.info("Creating stats table...");
  const sql = `
    CREATE TABLE IF NOT EXISTS stats (
        id INT AUTO_INCREMENT PRIMARY KEY UNIQUE NOT NULL,
        username VARCHAR(255) NOT NULL UNIQUE,
        health INT NOT NULL DEFAULT 100,
        max_health INT NOT NULL DEFAULT 100,
        stamina INT NOT NULL DEFAULT 100,
        max_stamina INT NOT NULL DEFAULT 100,
        xp INT NOT NULL DEFAULT 0,
        max_xp INT NOT NULL DEFAULT 100,
        level INT NOT NULL DEFAULT 1,
        stat_critical_damage INT NOT NULL DEFAULT 0,
        stat_critical_chance INT NOT NULL DEFAULT 0,
        stat_armor INT NOT NULL DEFAULT 0,
        stat_damage INT NOT NULL DEFAULT 0,
        stat_health INT NOT NULL DEFAULT 0,
        stat_stamina INT NOT NULL DEFAULT 0,
        stat_avoidance INT NOT NULL DEFAULT 0
    )
  `;
  await query(sql);
};

const createClientConfig = async () => {
  log.info("Creating clientconfig table...");
  const sql = `
      CREATE TABLE IF NOT EXISTS clientconfig (
        id INT AUTO_INCREMENT PRIMARY KEY UNIQUE NOT NULL,
        username VARCHAR(255) NOT NULL UNIQUE,
        fps INT NOT NULL DEFAULT 60,
        music_volume INT NOT NULL DEFAULT 100,
        effects_volume INT NOT NULL DEFAULT 100,
        muted INT NOT NULL DEFAULT 0,
        hotbar_config JSON DEFAULT NULL,
        inventory_config JSON DEFAULT NULL
    )
  `;
  await query(sql);
};

const createSpellsTable = async () => {
  log.info("Creating spells table...");
  const sql = `
    CREATE TABLE IF NOT EXISTS spells (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY UNIQUE,
      name VARCHAR(255) NOT NULL,
      damage INT NULL DEFAULT 0,
      mana INT NULL DEFAULT 0,
      \`range\` INT NULL DEFAULT 0,
      type VARCHAR(255) NULL DEFAULT 'cast',
      cast_time INT NULL DEFAULT 0,
      cooldown INT NULL DEFAULT 0,
      can_move INT NULL DEFAULT 0,
      description VARCHAR(255) NULL,
      icon VARCHAR(255) NULL DEFAULT NULL
    )
  `;
  await query(sql);
};

const insertDefaultSpell = async () => {
  log.info("Inserting default spell...");
  const checkSql = `SELECT COUNT(*) as count FROM spells WHERE name = 'frost_bolt'`;
  const result = await query(checkSql) as Array<{ count: number }>;

  if (result[0]?.count === 0) {
    const sql = `INSERT INTO spells (name, damage, mana, \`range\`, type, cast_time, cooldown, description, icon, can_move) VALUES
      ('frost_bolt', 10, 10, 1000, 'spell', 2, 1, 'A frosty projectile that deals damage to a single target.', 'frost_bolt', 0)`;
    await query(sql);
  } else {
    log.debug("Default spell 'frost_bolt' already exists - skipping");
  }
};

const createPermissionsTable = async () => {
  log.info("Creating permissions table...");
  const sql = `
    CREATE TABLE IF NOT EXISTS permissions (
      username VARCHAR(255) NOT NULL UNIQUE PRIMARY KEY,
      permissions VARCHAR(255) NOT NULL
    )
  `;
  await query(sql);
};

const createPermissionTypesTable = async () => {
  log.info("Creating permission_types table...");

  const createTableSql = `
    CREATE TABLE IF NOT EXISTS permission_types (
      name VARCHAR(255) NOT NULL UNIQUE PRIMARY KEY
    );
  `;
  await query(createTableSql);

  const checkSql = `SELECT COUNT(*) as count FROM permission_types`;
  const result = await query(checkSql) as Array<{ count: number }>;

  if (result[0]?.count === 0) {
    const insertPermissionsSql = `
      INSERT INTO permission_types (name) VALUES
        ('admin.*'),
        ('admin.ban'),
        ('admin.disconnect'),
        ('admin.permission'),
        ('admin.respawn'),
        ('admin.unban'),
        ('admin.whitelist'),
        ('permission.*'),
        ('permission.add'),
        ('permission.list'),
        ('permission.remove'),
        ('server.*'),
        ('server.admin'),
        ('server.notify'),
        ('server.restart'),
        ('server.shutdown'),
        ('tools.*'),
        ('tools.tile_editor'),
        ('tools.npc_editor'),
        ('tools.entity_editor'),
        ('tools.particle_editor')
    `;
    await query(insertPermissionsSql);
  } else {
    log.debug("Permission types already exist - skipping");
  }
};

const createNpcTable = async () => {
  log.info("Creating npcs table...");
  const sql = `
    CREATE TABLE IF NOT EXISTS npcs (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY UNIQUE,
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
      name VARCHAR(255) DEFAULT NULL,
      map VARCHAR(255) NOT NULL,
      position VARCHAR(255) NOT NULL,
      direction VARCHAR(10) NOT NULL,
      dialog VARCHAR(500) DEFAULT NULL,
      hidden INT NOT NULL DEFAULT 0,
      script VARCHAR(5000) DEFAULT NULL,
      particles VARCHAR(500) DEFAULT NULL,
      quest INT DEFAULT NULL,
      sprite_type VARCHAR(10) NOT NULL DEFAULT 'none',
      sprite_body VARCHAR(255) DEFAULT NULL,
      sprite_head VARCHAR(255) DEFAULT NULL,
      sprite_helmet VARCHAR(255) DEFAULT NULL,
      sprite_shoulderguards VARCHAR(255) DEFAULT NULL,
      sprite_neck VARCHAR(255) DEFAULT NULL,
      sprite_hands VARCHAR(255) DEFAULT NULL,
      sprite_chest VARCHAR(255) DEFAULT NULL,
      sprite_feet VARCHAR(255) DEFAULT NULL,
      sprite_legs VARCHAR(255) DEFAULT NULL,
      sprite_weapon VARCHAR(255) DEFAULT NULL
    )
  `;
  await query(sql);
};

const createEntitiesTable = async () => {
  log.info("Creating entities table...");
  const sql = `
    CREATE TABLE IF NOT EXISTS entities (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY UNIQUE,
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
      name VARCHAR(255) DEFAULT NULL,
      map VARCHAR(255) NOT NULL,
      position VARCHAR(255) NOT NULL,
      direction VARCHAR(10) NOT NULL DEFAULT 'down',
      particles VARCHAR(500) DEFAULT NULL,
      sprite_body VARCHAR(255) DEFAULT NULL,
      sprite_head VARCHAR(255) DEFAULT NULL,
      sprite_helmet VARCHAR(255) DEFAULT NULL,
      sprite_shoulderguards VARCHAR(255) DEFAULT NULL,
      sprite_neck VARCHAR(255) DEFAULT NULL,
      sprite_hands VARCHAR(255) DEFAULT NULL,
      sprite_chest VARCHAR(255) DEFAULT NULL,
      sprite_feet VARCHAR(255) DEFAULT NULL,
      sprite_legs VARCHAR(255) DEFAULT NULL,
      sprite_weapon VARCHAR(255) DEFAULT NULL,
      aggro_type VARCHAR(255) DEFAULT 'neutral',
      level INT DEFAULT 1,
      max_health INT DEFAULT 100,
      aggro_range INT DEFAULT 300,
      speed DECIMAL(5,2) DEFAULT 2.0,
      aggro_leash INT DEFAULT 600
    )
  `;
  await query(sql);
};

const createEntitySpawnPointsTable = async () => {
  log.info("Creating entity_spawn_points table...");
  const sql = `
    CREATE TABLE IF NOT EXISTS entity_spawn_points (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY UNIQUE,
      entity_template_id INT NOT NULL,
      map VARCHAR(255) NOT NULL,
      position VARCHAR(255) NOT NULL,
      respawn_time INT DEFAULT 30000,
      max_spawns INT DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (entity_template_id) REFERENCES entities(id) ON DELETE CASCADE
    )
  `;
  await query(sql);
};

const createParticleTable = async () => {
  log.info("Creating particles table...");
  const sql = `
    CREATE TABLE IF NOT EXISTS particles (
      name VARCHAR(255) NOT NULL UNIQUE PRIMARY KEY,
      size INT NOT NULL DEFAULT '1',
      color VARCHAR(45) NOT NULL DEFAULT 'transparent',
      velocity VARCHAR(45) NOT NULL DEFAULT '0,0',
      lifetime INT NOT NULL DEFAULT '100',
      opacity FLOAT NOT NULL DEFAULT '1',
      visible INT NOT NULL DEFAULT '1',
      gravity VARCHAR(45) NOT NULL DEFAULT '0,0',
      localposition VARCHAR(45) NOT NULL DEFAULT '0,0',
      amount INT NOT NULL DEFAULT '1',
      \`interval\` INT NOT NULL DEFAULT '1',
      staggertime FLOAT NOT NULL DEFAULT '0',
      spread VARCHAR(45) NOT NULL DEFAULT '0,0',
      affected_by_weather INT NOT NULL DEFAULT 0
    )
  `;
  await query(sql);
};

const createWeatherTable = async () => {
  log.info("Creating weather table...");
  const sql = `
    CREATE TABLE IF NOT EXISTS weather (
      name VARCHAR(100) NOT NULL UNIQUE PRIMARY KEY,
      ambience FLOAT NOT NULL DEFAULT 0,
      wind_direction VARCHAR(5) NOT NULL DEFAULT 'none',
      wind_speed FLOAT NOT NULL DEFAULT 0,
      humidity FLOAT NOT NULL DEFAULT 30,
      temperature FLOAT NOT NULL DEFAULT 68,
      precipitation FLOAT NOT NULL DEFAULT 0
    )
  `;
  await query(sql);
}

const createDefaultWeather = async () => {
  log.info("Creating default weather...");
  const checkSql = `SELECT COUNT(*) as count FROM weather WHERE name = 'clear'`;
  const result = await query(checkSql) as Array<{ count: number }>;

  if (result[0]?.count === 0) {
    const sql = `INSERT INTO weather (name, ambience, wind_direction, wind_speed, humidity, temperature, precipitation) VALUES ('clear', 0, 'none', 0, 30, 68, 0)`;
    await query(sql);
  } else {
    log.debug("Default weather 'clear' already exists - skipping");
  }
}

const createWorldTable = async () => {
  log.info("Creating world table...");
  const sql = `
    CREATE TABLE IF NOT EXISTS worlds (
      name VARCHAR(100) NOT NULL UNIQUE PRIMARY KEY,
      weather VARCHAR(45) NOT NULL DEFAULT 'none',
      max_players INT NOT NULL DEFAULT 100,
      default_map VARCHAR(255) NOT NULL DEFAULT 'main'
    )
  `;
  await query(sql);
};

const createWorld = async (name: string, weather: string, max_players: number, default_map: string) => {
  log.info(`Creating world '${name}'...`);
  const checkSql = `SELECT COUNT(*) as count FROM worlds WHERE name = '${name}'`;
  const result = await query(checkSql) as Array<{ count: number }>;

  if (result[0]?.count === 0) {
    const sql = `INSERT INTO worlds (name, weather, max_players, default_map) VALUES ('${name}', '${weather}', ${max_players}, '${default_map}')`;
    await query(sql);
  } else {
    log.debug(`World '${name}' already exists - skipping`);
  }
}

const createQuestsTable = async () => {
  log.info("Creating quests table...");
  const sql = `
    CREATE TABLE IF NOT EXISTS quests (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY UNIQUE,
      name VARCHAR(255) NOT NULL,
      description VARCHAR(5000) NOT NULL,
      reward INT NOT NULL,
      xp_gain INT NOT NULL,
      required_quest INT NOT NULL,
      required_level INT NOT NULL
    )
  `;
  await query(sql);
};

const createQuestLogTable = async () => {
  log.info("Creating quest log table...");
  const sql = `
    CREATE TABLE IF NOT EXISTS quest_log (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY UNIQUE,
      username VARCHAR(255) UNIQUE NOT NULL,
      completed_quests VARCHAR(5000) NOT NULL default '0',
      incomplete_quests VARCHAR(5000) NOT NULL default '0'
    )
  `;
  await query(sql);
};

const createFriendsListTable = async () => {
  log.info("Creating friends list table...");
  const sql = `
    CREATE TABLE IF NOT EXISTS friendslist (
      username VARCHAR(255) NOT NULL PRIMARY KEY UNIQUE,
      friends TEXT NOT NULL
    )
  `;
  await query(sql);
};

const createPartiesTable = async () => {
  log.info("Creating parties table...");
  const sql = `
    CREATE TABLE IF NOT EXISTS parties (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY UNIQUE,
      leader VARCHAR(255) NOT NULL,
      members TEXT DEFAULT NULL
    )
  `;
  await query(sql);
}

const createCurrencyTable = async () => {
  log.info("Creating currency table...");
  const sql = `
    CREATE TABLE IF NOT EXISTS currency (
      username VARCHAR(255) NOT NULL PRIMARY KEY UNIQUE,
      copper INT NOT NULL DEFAULT 0,
      silver INT NOT NULL DEFAULT 0,
      gold INT NOT NULL DEFAULT 0
    )
  `;
  await query(sql);
};

const createGuildsTable = async () => {
  log.info("Creating guilds table...");
  const sql = `
    CREATE TABLE IF NOT EXISTS guilds (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY UNIQUE,
      name VARCHAR(255) NOT NULL UNIQUE,
      leader VARCHAR(255) NOT NULL,
      members TEXT DEFAULT NULL,
      bank TEXT DEFAULT NULL,
      rank_permissions TEXT DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `;
  await query(sql);
};

const createMountsTable = async () => {
  log.info("Creating mounts table...");
  const sql = `
    CREATE TABLE IF NOT EXISTS mounts (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY UNIQUE,
      name VARCHAR(255) NOT NULL UNIQUE,
      description VARCHAR(500) NOT NULL,
      particles VARCHAR(500) DEFAULT NULL,
      icon VARCHAR(5000) DEFAULT NULL
    )
  `;
  await query(sql);
};

const insertDefaultMount = async () => {
  log.info("Inserting default mount...");
  const checkSql = `SELECT COUNT(*) as count FROM mounts WHERE name = 'unicorn'`;
  const result = await query(checkSql) as Array<{ count: number }>;

  if (result[0]?.count === 0) {
    const sql = `INSERT INTO mounts (name, description, particles, icon) VALUES ('unicorn', 'A sturdy unicorn for traveling.', NULL, 'mount_unicorn')`;
    await query(sql);
  } else {
    log.debug("Default mount 'unicorn' already exists - skipping");
  }
};

const createCollectablesTable = async () => {
  log.info("Creating collectables table...");
  const sql = `
    CREATE TABLE IF NOT EXISTS collectables (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY UNIQUE,
      type VARCHAR(255) NOT NULL,
      item VARCHAR(255) NOT NULL,
      username VARCHAR(255) NOT NULL
    )
  `;
  await query(sql);
}

const createLearnedSpellsTable = async () => {
  log.info("Creating learned_spells table...");
  const sql = `
    CREATE TABLE IF NOT EXISTS learned_spells (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY UNIQUE,
      spell VARCHAR(255) NOT NULL,
      username VARCHAR(255) NOT NULL
    )
  `;
  await query(sql);
}

const createEquipmentTable = async () => {
  log.info("Creating equipment table...");
  const sql = `
    CREATE TABLE IF NOT EXISTS equipment (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY UNIQUE,
      username VARCHAR(255) NOT NULL UNIQUE,
      head VARCHAR(255) DEFAULT 'player_head_default',
      body VARCHAR(255) DEFAULT 'player_body_default',
      helmet VARCHAR(255) DEFAULT NULL,
      necklace VARCHAR(255) DEFAULT NULL,
      shoulderguards VARCHAR(255) DEFAULT NULL,
      cape VARCHAR(255) DEFAULT NULL,
      chestplate VARCHAR(255) DEFAULT NULL,
      wristguards VARCHAR(255) DEFAULT NULL,
      gloves VARCHAR(255) DEFAULT NULL,
      belt VARCHAR(255) DEFAULT NULL,
      pants VARCHAR(255) DEFAULT NULL,
      boots VARCHAR(255) DEFAULT NULL,
      ring_1 VARCHAR(255) DEFAULT NULL,
      ring_2 VARCHAR(255) DEFAULT NULL,
      trinket_1 VARCHAR(255) DEFAULT NULL,
      trinket_2 VARCHAR(255) DEFAULT NULL,
      weapon VARCHAR(255) DEFAULT NULL,
      off_hand_weapon VARCHAR(255) DEFAULT NULL
    )
  `;
  await query(sql);
};

const insertDemoAccount = async () => {
  log.info("Inserting demo account...");
  const checkSql = `SELECT COUNT(*) as count FROM accounts WHERE username = 'demo_user'`;
  const result = await query(checkSql) as Array<{ count: number }>;

  if (result[0]?.count === 0) {
    const sql = `
      INSERT INTO accounts (
        email,
        username,
        password_hash,
        online,
        role,
        banned,
        map,
        position
      ) VALUES (
        'demo@example.com',
        'demo_user',
        '$argon2id$v=19$m=65536,t=2,p=1$t10G4CvyWPSnL53oJjhAeUwxVn3npXudy6CN41Z8JZE$/Rz8vPge3ECpIeYqJ2XbmBsrXipWuVPLmEGFyQfliWM',
        0,
        1,
        0,
        'overworld',
        '0,0'
      )
    `;
    await query(sql);
  } else {
    log.debug("Demo account 'demo_user' already exists - skipping");
  }
};

const insertDemoStats = async () => {
  log.info("Inserting demo stats...");
  const checkSql = `SELECT COUNT(*) as count FROM stats WHERE username = 'demo_user'`;
  const result = await query(checkSql) as Array<{ count: number }>;

  if (result[0]?.count === 0) {
    const sql = `
      INSERT INTO stats (
        username,
        health,
        max_health,
        stamina,
        max_stamina,
        xp,
        max_xp,
        level
      ) VALUES (
        'demo_user',
        100,
        100,
        100,
        100,
        0,
        0,
        1
      )
    `;
    await query(sql);
  } else {
    log.debug("Demo stats for 'demo_user' already exist - skipping");
  }
}

const insertDemoClientConfig = async () => {
  log.info("Inserting demo client config...");
  const checkSql = `SELECT COUNT(*) as count FROM clientconfig WHERE username = 'demo_user'`;
  const result = await query(checkSql) as Array<{ count: number }>;

  if (result[0]?.count === 0) {
    const sql = `
      INSERT INTO clientconfig (
        username,
        fps,
        music_volume,
        effects_volume,
        muted
      ) VALUES (
        'demo_user',
        60,
        100,
        100,
        0
      )
    `;
    await query(sql);
  } else {
    log.debug("Demo client config for 'demo_user' already exists - skipping");
  }
}

const insertDemoQuestLog = async () => {
  log.info("Inserting demo quest log...");
  const checkSql = `SELECT COUNT(*) as count FROM quest_log WHERE username = 'demo_user'`;
  const result = await query(checkSql) as Array<{ count: number }>;

  if (result[0]?.count === 0) {
    const sql = `INSERT INTO quest_log (username) VALUES ('demo_user')`;
    await query(sql);
  } else {
    log.debug("Demo quest log for 'demo_user' already exists - skipping");
  }
}

const insertDefaultLearnedSpell = async () => {
  log.info("Inserting default learned spell for demo user...");
  const checkSql = `SELECT COUNT(*) as count FROM learned_spells WHERE spell = 'frost_bolt' AND username = 'demo_user'`;
  const result = await query(checkSql) as Array<{ count: number }>;

  if (result[0]?.count === 0) {
    const sql = `INSERT INTO learned_spells (spell, username) VALUES ('frost_bolt', 'demo_user')`;
    await query(sql);
  } else {
    log.debug("Demo user 'demo_user' already has spell 'frost_bolt' - skipping");
  }
};

const addPermissionsToDemoAccount = async () => {
  log.info("Adding permissions to demo account...");
  const checkSql = `SELECT COUNT(*) as count FROM permissions WHERE username = 'demo_user'`;
  const result = await query(checkSql) as Array<{ count: number }>;

  if (result[0]?.count === 0) {
    const sql = `INSERT INTO permissions (username, permissions) VALUES ('demo_user', 'admin.*,server.*,permission.*')`;
    await query(sql);
  } else {
    log.debug("Permissions for 'demo_user' already exist - skipping");
  }
}

const insertDemoMount = async () => {
  log.info("Inserting demo mount collectable...");
  const checkSql = `SELECT COUNT(*) as count FROM collectables WHERE type = 'mount' AND item = 'unicorn' AND username = 'demo_user'`;
  const result = await query(checkSql) as Array<{ count: number }>;

  if (result[0]?.count === 0) {
    const sql = `INSERT INTO collectables (type, item, username) VALUES ('mount', 'unicorn', 'demo_user')`;
    await query(sql);
  } else {
    log.debug("Demo user 'demo_user' already has mount 'unicorn' collectable - skipping");
  }
}

const createIndexes = async () => {
  log.info("Creating performance indexes...");

  const indexes = [

    { name: "idx_accounts_token", sql: "CREATE INDEX idx_accounts_token ON accounts(token)" },
    { name: "idx_accounts_session_id", sql: "CREATE INDEX idx_accounts_session_id ON accounts(session_id)" },
    { name: "idx_accounts_username", sql: "CREATE INDEX idx_accounts_username ON accounts(username)" },
    { name: "idx_accounts_party_id", sql: "CREATE INDEX idx_accounts_party_id ON accounts(party_id)" },
    { name: "idx_accounts_guild_id", sql: "CREATE INDEX idx_accounts_guild_id ON accounts(guild_id)" },

    { name: "idx_permissions_username", sql: "CREATE INDEX idx_permissions_username ON permissions(username)" },
    { name: "idx_stats_username", sql: "CREATE INDEX idx_stats_username ON stats(username)" },
    { name: "idx_currency_username", sql: "CREATE INDEX idx_currency_username ON currency(username)" },
    { name: "idx_friendslist_username", sql: "CREATE INDEX idx_friendslist_username ON friendslist(username)" },
    { name: "idx_clientconfig_username", sql: "CREATE INDEX idx_clientconfig_username ON clientconfig(username)" },
    { name: "idx_quest_log_username", sql: "CREATE INDEX idx_quest_log_username ON quest_log(username)" },

    { name: "idx_inventory_username", sql: "CREATE INDEX idx_inventory_username ON inventory(username)" },
    { name: "idx_inventory_item", sql: "CREATE INDEX idx_inventory_item ON inventory(item)" },

    { name: "idx_parties_id", sql: "CREATE INDEX idx_parties_id ON parties(id)" },
    { name: "idx_parties_leader", sql: "CREATE INDEX idx_parties_leader ON parties(leader)" },

    { name: "idx_guilds_id", sql: "CREATE INDEX idx_guilds_id ON guilds(id)" },
    { name: "idx_guilds_name", sql: "CREATE INDEX idx_guilds_name ON guilds(name)" },
    { name: "idx_guilds_leader", sql: "CREATE INDEX idx_guilds_leader ON guilds(leader)" },

    { name: "idx_mounts_name", sql: "CREATE INDEX idx_mounts_name ON mounts(name)" },

    { name: "idx_collectables_username", sql: "CREATE INDEX idx_collectables_username ON collectables(username)" },

    { name: "idx_spells_name", sql: "CREATE INDEX idx_spells_name ON spells(name)" }

    ,{ name: "idx_learned_spells_username", sql: "CREATE INDEX idx_learned_spells_username ON learned_spells(username)" }

    ,{ name: "idx_equipment_username", sql: "CREATE INDEX idx_equipment_username ON equipment(username)" }

    ,{ name: "idx_entities_map", sql: "CREATE INDEX idx_entities_map ON entities(map)" }

    ,{ name: "idx_entity_spawn_points_map", sql: "CREATE INDEX idx_entity_spawn_points_map ON entity_spawn_points(map)" }

    ,{ name: "idx_entity_spawn_points_template", sql: "CREATE INDEX idx_entity_spawn_points_template ON entity_spawn_points(entity_template_id)" }
  ];

  for (const index of indexes) {
    try {

      const checkIndexSql = `
        SELECT COUNT(*) as count
        FROM INFORMATION_SCHEMA.STATISTICS
        WHERE table_schema = DATABASE()
        AND index_name = '${index.name}'
      `;

      const result = await query(checkIndexSql) as Array<{ count: number }>;
      const indexExists = result[0]?.count > 0;

      if (!indexExists) {
        await query(index.sql);
        log.info(`✓ ${index.name} created`);
      } else {
        log.debug(`Index ${index.name} already exists - skipping`);
      }
    } catch (error: any) {
      log.warn(`Could not create index ${index.name}: ${error.message}`);
    }
  }

  log.success("Index creation complete!");
};

const setupDatabase = async () => {
  await createDatabase();
  await useDatabase();
  await createAccountsTable();
  await createAllowedIpsTable();
  await createBlockedIpsTable();
  await insertLocalhost();
  await createInventoryTable();
  await createItemsTable();
  await createStatsTable();
  await createClientConfig();
  await createSpellsTable();
  await insertDefaultSpell();
  await createPermissionsTable();
  await createPermissionTypesTable();
  await createNpcTable();
  await createEntitiesTable();
  await createEntitySpawnPointsTable();
  await createParticleTable();
  await createWeatherTable();
  await createDefaultWeather();
  await createWorldTable();
  await createWorld('overworld', 'rainy', 200, 'overworld');
  await createQuestsTable();
  await createQuestLogTable();
  await createFriendsListTable();
  await createPartiesTable();
  await createCurrencyTable();
  await createGuildsTable();
  await createMountsTable();
  await insertDefaultMount();
  await createCollectablesTable();
  await createLearnedSpellsTable();
  await createEquipmentTable();
  await insertDemoAccount();
  await insertDemoStats();
  await insertDemoClientConfig();
  await insertDemoQuestLog();
  await insertDefaultLearnedSpell();
  await addPermissionsToDemoAccount();
  await insertDemoMount();
  await createIndexes();
};

try {
  log.info("Setting up database...");
  await setupDatabase();
  log.success("Database setup complete!");
  process.exit(0);
} catch (error) {
  log.error(`Error setting up database: ${error}`);
  process.exit(1);
}
