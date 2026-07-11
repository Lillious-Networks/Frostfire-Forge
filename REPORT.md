# Frostfire Forge - Security Vulnerability Report

**Generated:** 2026-07-11
**Scope:** Full codebase audit of 2D MMO Game Engine
**Severity Scale:** CRITICAL > HIGH > MEDIUM > LOW

**Tags:** `[FIXED]` = resolved

---

## VULN-01: [FIXED] Session ID Entropy Collapse

**Location:** `src/socket/server.ts:190`
**Severity:** CRITICAL

### Description

Session IDs were generated from 2 bytes of randomness (`crypto.randomBytes(2)`), producing only 65,536 possible values. An attacker could brute-force active session IDs and impersonate any online player.

### Proof of Concept

```
For id in range(0, 65536):
  Send: { type: "GET_ONLINE_PLAYERS", sessionId: id }
  If response received → valid session found
With valid session → full impersonation (movement, inspection, chat)
Expected: ~32K attempts (seconds) to hijack any session.
```

### Remediation (Applied)

`server.ts:190` — changed `crypto.randomBytes(2)` to `crypto.randomUUID()` (128-bit entropy).

---

## VULN-02: [FIXED] Path Traversal via mapName

**Location:** `src/modules/assetloader.ts:698-750`, `src/modules/checksums.ts:37-65`
**Severity:** CRITICAL

### Description

The `SAVE_MAP` handler accepted a user-controlled `mapName` that flowed into `path.join(mapDir, mapName)` without validation. A malicious admin could use `../` sequences to read/write files outside the maps directory.

### Proof of Concept

```
Send: { type: "SAVE_MAP", data: { mapName: "../../../.env.production", chunks: [] } }
Resolves to: ./src/assets/maps/../../../.env.production → project root .env.production
Expected: Arbitrary file read/write, enabling plugin-based RCE.
```

### Remediation (Applied)

Added `getValidMapPath()` in both `assetloader.ts` and `checksums.ts` — strips directory components with `path.basename()`, verifies resolved path stays within map directory. Applied to all five affected functions.

---

## VULN-03: [FIXED] Currency Remove() Broken Borrowing

**Location:** `src/systems/currency.ts:22-70`
**Severity:** CRITICAL

### Description

`remove()` zeroed copper when insufficient but never borrowed from silver/gold, making copper-denominated transactions free. `add()` was missing `else` clauses — non-overflowing additions were silently lost.

### Proof of Concept

```
Player has {copper: 0, silver: 5, gold: 0}
currency.remove(username, {copper: 50, silver: 0, gold: 0})
Result: {copper: 0, silver: 5, gold: 0}  // 50 copper never deducted
Expected: Infinite free copper purchases.
```

### Remediation (Applied)

Rewrote `add()` and `remove()` — proper multi-denomination borrowing, overflow capping with `Math.min`/`Math.max`, negative value rejection.

---

## VULN-04: Demo Admin Account with Hardcoded Password

**Location:** `src/utility/database_setup.ts:569-684`, `CLAUDE.md:956`
**Severity:** CRITICAL

### Description

The database setup script creates `demo_user` with full admin privileges (`admin.*,server.*,permission.*`). The password (`Changeme123!`) is documented in CLAUDE.md. `Dockerfile.prod:30` runs `bun setup-production` at container start, which executes database_setup.ts. Same pattern in `database_setup_sqlite.ts:514-591`.

### Proof of Concept

```
1. Read CLAUDE.md → credentials: demo_user / Changeme123!
2. Login → get auth token
3. Authenticate to WebSocket with token
4. Full admin: TELEPORTXY, NOCLIP, STEALTH, EDITOR_*, SHUTDOWN, RESTART

Expected: Anyone reading the public repo documentation gains admin control
if production setup creates the account.
```

### Remediation

- Remove hardcoded demo account from `database_setup.ts` and `database_setup_sqlite.ts`
- If a demo account is needed, use an environment variable for the password and `role: 0`
- `setup-production` must not create demo accounts

---

## VULN-05: [FIXED] No Token Expiration

**Location:** `src/systems/player.ts:492-503`
**Severity:** HIGH

### Description

Auth tokens have no expiration. Once issued, a token is valid until explicit logout or session kick. A leaked token grants permanent, undetectable access. No `token_expires_at` column, no periodic cleanup, no age check during authentication. Users have no "log out everywhere" mechanism to revoke compromised tokens.

### Proof of Concept

```
1. Obtain valid token (credential theft, network intercept, shared device)
2. Wait weeks — no expiry check
3. Authenticate: SELECT * FROM accounts WHERE token = ?
   Token still present → auth succeeds
4. Victim cannot invalidate — even password change doesn't clear tokens

Expected: Permanent, undetectable account access from a single token leak.
```

### Remediation

- Add `token_expires_at TIMESTAMP` column, set 24-hour expiry from issuance
- Check during authentication: `WHERE token = ? AND token_expires_at > NOW()`
- Periodic cleanup of expired tokens
- Add "log out everywhere" endpoint

---

## VULN-06: isAdmin Boolean Bypasses Permission System

**Location:** `src/socket/receiver.ts:1945,2353,2364,2078,2103,2117,2143,7846`
**Severity:** MEDIUM

### Description

Eight admin handlers check only a cached `isAdmin` boolean instead of the granular permission system. A demoted admin retains all powers until server restart because the flag is never re-verified against the database.

| Handler | Check |
|---------|-------|
| TELEPORTXY, NOCLIP, STEALTH, GET_ONLINE_PLAYERS | `if (!currentPlayer?.isAdmin) return;` |
| EDITOR_TILE_EDIT, EDITOR_LAYER_LOCK, EDITOR_OPEN, EDITOR_CLOSE | `if (!currentPlayer \|\| !currentPlayer.isAdmin) return;` |

Compare with `SUMMON` (line 4669) which correctly checks `currentPlayer.permissions`.

### Proof of Concept

```
1. Admin is demoted: DELETE FROM permissions WHERE username = 'admin'
2. Admin still has isAdmin=true cached in memory
3. TELEPORTXY, NOCLIP, STEALTH — all succeed despite no permissions
4. Persists until server restart

Expected: Demoted admins retain full powers. Requires existing admin access
to be exploited (internal threat / compromised admin account).
```

### Remediation

- Replace all `isAdmin` checks with fine-grained permission checks matching the `SUMMON` handler pattern
- Re-verify admin status against the database on sensitive operations

---

## VULN-07: [FIXED] Chat Flooding (No Message Size/Rate Limits)

**Location:** `src/socket/receiver.ts:1974-2058`
**Severity:** MEDIUM

### Description

Chat messages have no server-side length limit and no per-player rate limit. A single player can flood all players on a map with arbitrarily large messages at maximum throughput, causing denial of service.

Note: The original report flagged potential XSS, but exploitability depends on client rendering architecture which is outside audit scope. The DoS vector is client-agnostic.

### Proof of Concept

```
1. Authenticate as any player
2. Flood loop:
   while (true) {
     Send: { type: "CHAT", data: { message: "A".repeat(1024 * 1024) } }
   }
3. All map players receive massive data stream

Expected: Client memory exhaustion, network saturation for all players on map.
```

### Remediation

- Enforce maximum message length (e.g., 500 characters)
- Rate-limit chat per player (e.g., 5 messages per 3 seconds)

---

## VULN-08: Custom SQL Wrapper Uses .unsafe()

**Location:** `src/controllers/sqldatabase.worker.ts:9-47,189`
**Severity:** MEDIUM

### Description

The database layer uses a hand-rolled SQL escaping function that ultimately passes strings through `.unsafe()`. The escaping only handles single quotes and misses multi-byte character bypasses and backslash sequences. While all runtime queries currently use `?` placeholders with properly validated values, the architecture provides no safety net against future mistakes — any unvalidated input becomes a direct injection vector.

### Proof of Concept

```
1. Multi-byte charset bypass (MySQL, certain charsets):
   Input: username = "\xbf' OR 1=1 -- "
   The \xbf absorbs escaping backslash → ' passes through unescaped
2. Object with custom toString():
   escapeValue falls to String(param).replace(/'/g, "''")
   If toString() returns crafted SQL → injection

Expected: No current exploit path, but architectural fragility.
```

### Remediation

- Replace `sqlController.unsafe(sqlWrapper(...))` with Bun's native tagged template:
  ```typescript
  await sql`SELECT * FROM t WHERE x = ${val}`;
  ```

---

## VULN-09: Guild and Party — No Authorization on Add/Remove/Delete

**Location:** `src/systems/guild.ts:82-136`, `src/systems/parties.ts:65-112`
**Severity:** LOW

### Description

Guild and party system functions (`add`, `remove`, `delete`) have no caller authorization — no check that the caller is leader, officer, or even a member. Currently these functions are not called from any packet handler, making this a latent issue that becomes exploitable once guild/party management is connected to the client.

### Proof of Concept

```
1. guild.add("attacker", targetGuildId) — join any guild, no invite
2. guild.remove("guildLeader", targetGuildId) — kick the leader
3. guild.delete(targetGuildId) — disband entirely
Expected: Mass griefing once UI is connected.
```

### Remediation

- Add authorization checks at the system level (verify caller is leader/officer)
- Do this at the system layer, not just the receiver, for defense-in-depth

---

## VULN-10: [FIXED] No WebSocket Origin Validation

**Location:** `src/socket/server.ts:224`
**Severity:** LOW

### Description

The WebSocket upgrade does not validate the `Origin` header. Connections require HMAC-signed tokens which prevents practical CSWSH, but origin validation is a standard defense-in-depth measure.

### Proof of Concept

```
1. Malicious site opens WebSocket to game server with valid token
2. Without origin check, connection succeeds from any origin
3. Impact depends on HMAC key secrecy — if key leaks, cross-origin attacks possible
```

### Remediation

- Validate `Origin` header against `CORS_ALLOWED_ORIGINS`

---

## Summary

### Vulnerabilities by Category

| Category | VULNs |
|----------|-------|
| Session / Auth | ~~VULN-01~~ (FIXED), ~~VULN-05~~ (FIXED) |
| File System | ~~VULN-02~~ (FIXED) |
| Game Logic | ~~VULN-03~~ (FIXED) |
| Default Credentials | VULN-04 |
| Authorization | VULN-06, VULN-09 |
| Input Validation | ~~VULN-07~~ (FIXED), VULN-08 |
| Network | ~~VULN-10~~ (FIXED) |

### Recommended Action Priority

1. **Immediate:** Remove demo admin account (VULN-04)
2. **Within 1 week:** Replace `isAdmin` checks with permissions (VULN-06)
3. **Within 1 sprint:** Replace `.unsafe()` SQL (VULN-08)
4. **Backlog:** Add guild/party authorization before connecting to client (VULN-09)
