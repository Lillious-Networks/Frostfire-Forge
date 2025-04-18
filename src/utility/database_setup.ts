// This file is used to create the database and tables if they don't exist
import query from "../controllers/sqldatabase";
import log from "../modules/logger";
const database = process.env.DATABASE_NAME || "TEMP_Mystika";

// Create TEMP_Mystika Database if it doesn't exist
const createDatabase = async () => {
  const sql = `CREATE DATABASE IF NOT EXISTS ${database};`;
  await query(sql);
};

// Create accounts table if it doesn't exist
const createAccountsTable = async () => {
  const useDatabaseSql = `USE ${database};`;
  await query(useDatabaseSql);

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
        verification_code VARCHAR(100) DEFAULT NULL,
        needs_password_reset INT DEFAULT 0 NOT NULL,
        map VARCHAR(255) DEFAULT NULL,
        position VARCHAR(255) DEFAULT NULL,
        session_id VARCHAR(255) UNIQUE DEFAULT NULL,
        stealth INT DEFAULT 0 NOT NULL,
        direction VARCHAR(10) DEFAULT NULL,
        verified INT DEFAULT 0 NOT NULL,
        noclip INT DEFAULT 0 NOT NULL
      );
  `;
  await query(sql);
};

// Create allowed_ips table if it doesn't exist
const createAllowedIpsTable = async () => {
  const useDatabaseSql = `USE ${database};`;
  await query(useDatabaseSql);

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
  const useDatabaseSql = `USE ${database};`;
  await query(useDatabaseSql);

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
  const useDatabaseSql = `USE ${database};`;
  await query(useDatabaseSql);

  const sql = `
    INSERT IGNORE INTO allowed_ips (ip) VALUES ('127.0.0.1'), ('::1');
    `;
  await query(sql);
};

// Create inventory table if it doesn't exist
const createInventoryTable = async () => {
  const useDatabaseSql = `USE ${database};`;
  await query(useDatabaseSql);

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
  const useDatabaseSql = `USE ${database};`;
  await query(useDatabaseSql);

  const sql = `
    CREATE TABLE IF NOT EXISTS items (
        id INT AUTO_INCREMENT PRIMARY KEY UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL UNIQUE,
        quality VARCHAR(255) NOT NULL,
        description VARCHAR(255) DEFAULT NULL
    )
  `;
  await query(sql);
};

const createStatsTable = async () => {
  const useDatabaseSql = `USE ${database};`;
  await query(useDatabaseSql);

  const sql = `
    CREATE TABLE IF NOT EXISTS stats (
        id INT AUTO_INCREMENT PRIMARY KEY UNIQUE NOT NULL,
        username VARCHAR(255) NOT NULL UNIQUE,
        health INT NOT NULL DEFAULT 100,
        max_health INT NOT NULL DEFAULT 100,
        stamina INT NOT NULL DEFAULT 100,
        max_stamina INT NOT NULL DEFAULT 100
    )
  `;
  await query(sql);
};

const createClientConfig = async () => {
  const useDatabaseSql = `USE ${database};`;
  await query(useDatabaseSql);

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
  const useDatabaseSql = `USE ${database};`;
  await query(useDatabaseSql);

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
  const useDatabaseSql = `USE ${database};`;
  await query(useDatabaseSql);

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
  const useDatabaseSql = `USE ${database};`;
  await query(useDatabaseSql);

  const sql = `
    CREATE TABLE IF NOT EXISTS permissions (
      username VARCHAR(255) NOT NULL UNIQUE PRIMARY KEY,
      permissions VARCHAR(255) NOT NULL
    )
  `;
  await query(sql);
};

const createPermissionTypesTable = async () => {
  const useDatabaseSql = `USE ${database};`;
  await query(useDatabaseSql);


  const sql = `
    CREATE TABLE IF NOT EXISTS permission_types (
      name VARCHAR(255) NOT NULL UNIQUE PRIMARY KEY
    )

    INSERT IGNORE INTO permission_types (name) VALUES
      ('admin.ban'),
      ('admin.disconnect'),
      ('admin.permission'),
      ('admin.respawn'),
      ('admin.unban'),
      ('permission.add'),
      ('permission.list'),
      ('permission.remove'),
      ('server.admin'),
      ('server.notify'),
      ('server.restart'),
      ('server.shutdown');
  `;
  await query(sql);
};

const createNpcTable = async () => {
  const useDatabaseSql = `USE ${database};`;
  await query(useDatabaseSql);

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
      particles VARCHAR(500) NOT NULL
    )
  `;
  await query(sql);
};

const createParticleTable = async () => {
  const useDatabaseSql = `USE ${database};`;
  await query(useDatabaseSql);

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
      interval INT NOT NULL DEFAULT '1',
      staggertime FLOAT NOT NULL DEFAULT '0',
      spread VARCHAR(45) NOT NULL DEFAULT '0,0',
      weather VARCHAR(45) NOT NULL DEFAULT 'none'
    )
  `;
  await query(sql);
};

// Run the database setup
const setupDatabase = async () => {
  await createDatabase();
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
