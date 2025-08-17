import * as Mitata from "mitata";
const { bench, run } = Mitata;

import SQLiteController from "./sqlite";


import * as settings from "../../config/settings.json";
settings.logging.level = "info";
// settings.logging.level = "warn";
// settings.logging.level = "trace";
// settings.logging.level = "debug";

const db = new SQLiteController(":memory:");
bench("In-Memory SQLite fetch version", async () => {
    let i = 0
    const r = await db.query("SELECT sqlite_version() as Version, ? as i", [i++]);
    if (r.length > 0) {
        console.log("SQLite Version:", r[0].Version);
    }
    else {
        console.error("No version found in SQLite database.");
    }
});


await run();
