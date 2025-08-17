import * as Mitata from "mitata";
const { bench, run } = Mitata;

import MySQLPoolController from "./mysql";

import * as settings from "../../config/settings.json";
settings.logging.level = "info";
// settings.logging.level = "warn";
// settings.logging.level = "trace";
// settings.logging.level = "debug";


const cc = {
    user: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
    host: process.env.DATABASE_HOST,
    database: process.env.DATABASE_NAME,
    port: parseInt(process.env.DATABASE_PORT || "3306"),
};
// const ctrl = new MySQLPoolController(cc);
const ctrl = new MySQLPoolController(`mysql://${cc.user}:${cc.password}@${cc.host}:${cc.port}/${cc.database}`);


bench("MySQL fetch version", async () => {
    let i = 0
    const r = await ctrl.queryAsync("SELECT version() as Version, ? as i", [i++]);
    if (r.length > 0) {
        console.log("MySQL Version:", r[0].Version);
    }
    else {
        console.error("No version found in MySQL database.");
    }
});


await run();
