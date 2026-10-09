// Entry of `bun setup`: sets the schema up for the engine in DATABASE_ENGINE. The SQLite script for
// "sqlite", the MySQL script (also used for MariaDB) for anything else. Each script ends the process.
const script = (process.env.DATABASE_ENGINE || "mysql") === "sqlite" ? "./database_setup_sqlite" : "./database_setup";

await import(script);
