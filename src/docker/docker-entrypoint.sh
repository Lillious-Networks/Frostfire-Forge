#!/bin/sh
set -e

# Optional settings.json overrides (DEFAULT_MAP / SPAWN_X / SPAWN_Y).
if [ -n "$DEFAULT_MAP" ] || [ -n "$SPAWN_X" ] || [ -n "$SPAWN_Y" ]; then
  bun -e "
    const fs = require('fs');
    const path = 'src/config/settings.json';
    const s = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (process.env.DEFAULT_MAP) s.default_map = process.env.DEFAULT_MAP;
    if (process.env.SPAWN_X) s.spawn_x = Number(process.env.SPAWN_X);
    if (process.env.SPAWN_Y) s.spawn_y = Number(process.env.SPAWN_Y);
    fs.writeFileSync(path, JSON.stringify(s, null, 2));
  "
fi

exec bun /app/src/socket/server.ts
