/**
 * The classes table (systems/classes.ts), as the setup scripts and the start-time step make it. On its own so the
 * setup scripts need nothing else of the game to make it.
 */
export const CLASSES_TABLE = {
  mysql: `CREATE TABLE IF NOT EXISTS classes (
      id INT AUTO_INCREMENT PRIMARY KEY UNIQUE NOT NULL,
      name VARCHAR(45) NOT NULL UNIQUE,
      description TEXT DEFAULT NULL,
      max_health INT NOT NULL DEFAULT 100,
      max_stamina INT NOT NULL DEFAULT 100,
      stat_damage INT NOT NULL DEFAULT 0,
      stat_armor INT NOT NULL DEFAULT 0,
      stat_critical_chance INT NOT NULL DEFAULT 10,
      stat_critical_damage INT NOT NULL DEFAULT 10,
      stat_avoidance INT NOT NULL DEFAULT 0,
      spells TEXT DEFAULT NULL,
      items TEXT DEFAULT NULL
    )`,
  sqlite: `CREATE TABLE IF NOT EXISTS classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT UNIQUE NOT NULL,
      name TEXT NOT NULL UNIQUE,
      description TEXT DEFAULT NULL,
      max_health INTEGER NOT NULL DEFAULT 100,
      max_stamina INTEGER NOT NULL DEFAULT 100,
      stat_damage INTEGER NOT NULL DEFAULT 0,
      stat_armor INTEGER NOT NULL DEFAULT 0,
      stat_critical_chance INTEGER NOT NULL DEFAULT 10,
      stat_critical_damage INTEGER NOT NULL DEFAULT 10,
      stat_avoidance INTEGER NOT NULL DEFAULT 0,
      spells TEXT DEFAULT NULL,
      items TEXT DEFAULT NULL
    )`,
};
