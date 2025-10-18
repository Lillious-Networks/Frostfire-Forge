// This file is used to create the database and tables if they don't exist
import query from "../controllers/sqldatabase";
import log from "../modules/logger";
const database = process.env.DATABASE_NAME || "TEMP_Mystika";

// Create TEMP_Mystika Database if it doesn't exist
const createDatabase = async () => {
  log.info("Creating database...");
  const sql = `CREATE DATABASE IF NOT EXISTS ${database};`;
  await query(sql);
};

const useDatabase = async () => {
  const useDatabaseSql = `USE ${database};`;
  await query(useDatabaseSql);
};

// Create accounts table if it doesn't exist
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
        map VARCHAR(255) DEFAULT 'main' NOT NULL,
        position VARCHAR(255) DEFAULT '0,0' NOT NULL,
        session_id VARCHAR(255) UNIQUE DEFAULT NULL,
        stealth INT DEFAULT 0 NOT NULL,
        direction VARCHAR(10) DEFAULT 'down' NOT NULL,
        verified INT DEFAULT 0 NOT NULL,
        noclip INT DEFAULT 0 NOT NULL,
        party_id INT DEFAULT NULL,
        guest_mode INT DEFAULT 0 NOT NULL
      );
  `;
  await query(sql);
};

// Create allowed_ips table if it doesn't exist
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

// Create blocked_ips table if it doesn't exist
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

// Insert 127.0.0.1 and ::1 as allowed IPs if they doesn't exist
const insertLocalhost = async () => {
  log.info("Inserting localhost and ::1 as allowed IPs...");
  const sql = `
    INSERT IGNORE INTO allowed_ips (ip) VALUES ('127.0.0.1'), ('::1');
    `;
  await query(sql);
};

// Create inventory table if it doesn't exist
const createInventoryTable = async () => {
  log.info("Creating inventory table...");
  const sql = `
    CREATE TABLE IF NOT EXISTS inventory (
        id INT AUTO_INCREMENT PRIMARY KEY UNIQUE NOT NULL,
        username VARCHAR(255) NOT NULL,
        item VARCHAR(255) NOT NULL,
        quantity INT NOT NULL
    )
  `;
  await query(sql);
};

// Create items table if it doesn't exist
const createItemsTable = async () => {
  log.info("Creating items table...");
  const sql = `
    CREATE TABLE IF NOT EXISTS items (
        id INT AUTO_INCREMENT PRIMARY KEY UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL UNIQUE,
        quality VARCHAR(255) NOT NULL,
        description VARCHAR(255) DEFAULT NULL,
        icon VARCHAR(1000) DEFAULT NULL
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
        level INT NOT NULL DEFAULT 1
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
        muted INT NOT NULL DEFAULT 0
    )
  `;
  await query(sql);
};

const createWeaponsTable = async () => {
  log.info("Creating weapons table...");
  const sql = `
    CREATE TABLE IF NOT EXISTS weapons (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY UNIQUE,
      name VARCHAR(255) NOT NULL,
      damage INT NULL DEFAULT 0,
      mana INT NULL DEFAULT 0,
      \`range\` INT NULL DEFAULT 0,
      type VARCHAR(255) NULL DEFAULT 'melee',
      description VARCHAR(255) NULL,
      quality VARCHAR(255) NULL DEFAULT 'common'
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
      description VARCHAR(255) NULL
    )
  `;
  await query(sql);
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
  
  // First create the table
  const createTableSql = `
    CREATE TABLE IF NOT EXISTS permission_types (
      name VARCHAR(255) NOT NULL UNIQUE PRIMARY KEY
    );
  `;
  await query(createTableSql);

  // Then insert the default permissions
  const insertPermissionsSql = `
    INSERT IGNORE INTO permission_types (name) VALUES
      ('admin.*'),
      ('admin.ban'),
      ('admin.disconnect'),
      ('admin.permission'),
      ('admin.respawn'),
      ('admin.unban'),
      ('permission.*'),
      ('permission.add'),
      ('permission.list'),
      ('permission.remove'),
      ('server.*'),
      ('server.admin'),
      ('server.notify'),
      ('server.restart'),
      ('server.shutdown')
  `;
  await query(insertPermissionsSql);
};

const createNpcTable = async () => {
  log.info("Creating npcs table...");
  const sql = `
    CREATE TABLE IF NOT EXISTS npcs (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY UNIQUE,
      last_updated DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      map VARCHAR(255) NOT NULL,
      position VARCHAR(255) NOT NULL,
      direction VARCHAR(10) NOT NULL,
      dialog VARCHAR(500) NOT NULL,
      hidden INT NOT NULL DEFAULT 0,
      script VARCHAR(5000) NOT NULL,
      particles VARCHAR(500) NOT NULL,
      quest INT DEFAULT NULL
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
  const sql = `
    INSERT IGNORE INTO weather (name, ambience, wind_direction, wind_speed, humidity, temperature, precipitation) VALUES ('clear', 0, 'none', 0, 30, 68, 0);
  `;
  await query(sql);
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

const createDefaultWorld = async () => {
  log.info("Creating default world...");
  const sql = `
    INSERT IGNORE INTO worlds (name, weather, max_players, default_map) VALUES ('default', 'clear', 100, 'main');
  `;
  await query(sql);
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
      completed_quests TEXT NOT NULL,
      incomplete_quests TEXT NOT NULL
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

// Create indexes for performance optimization
const createIndexes = async () => {
  log.info("Creating performance indexes...");

  const indexes = [
    // Accounts table indexes (most critical for auth queries)
    "CREATE INDEX idx_accounts_token ON accounts(token)",
    "CREATE INDEX idx_accounts_session_id ON accounts(session_id)",
    "CREATE INDEX idx_accounts_username ON accounts(username)",
    "CREATE INDEX idx_accounts_party_id ON accounts(party_id)",

    // Indexes for JOIN queries in GetPlayerLoginData
    "CREATE INDEX idx_permissions_username ON permissions(username)",
    "CREATE INDEX idx_stats_username ON stats(username)",
    "CREATE INDEX idx_currency_username ON currency(username)",
    "CREATE INDEX idx_friendslist_username ON friendslist(username)",
    "CREATE INDEX idx_clientconfig_username ON clientconfig(username)",
    "CREATE INDEX idx_quest_log_username ON quest_log(username)",

    // Inventory query optimization
    "CREATE INDEX idx_inventory_username ON inventory(username)",
    "CREATE INDEX idx_inventory_item ON inventory(item)",

    // Party query optimization
    "CREATE INDEX idx_parties_id ON parties(id)",
    "CREATE INDEX idx_parties_leader ON parties(leader)",
  ];

  for (const indexSql of indexes) {
    try {
      await query(indexSql);
      log.info(`✓ ${indexSql.match(/idx_\w+/)?.[0] || 'Index'} created`);
    } catch (error: any) {
      // Index already exists or other error - skip and continue
      if (error.message?.includes("Duplicate key name")) {
        log.debug(`Index already exists: ${indexSql.match(/idx_\w+/)?.[0]}`);
      } else {
        log.warn(`Could not create index: ${error.message}`);
      }
    }
  }

  log.success("Index creation complete!");
};

// Run the database setup
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
  await createWeaponsTable();
  await createSpellsTable();
  await createPermissionsTable();
  await createPermissionTypesTable();
  await createNpcTable();
  await createParticleTable();
  await createWeatherTable();
  await createDefaultWeather();
  await createWorldTable();
  await createDefaultWorld();
  await createQuestsTable();
  await createQuestLogTable();
  await createFriendsListTable();
  await createPartiesTable();
  await createCurrencyTable();
  await createIndexes(); // Add indexes after all tables are created
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
