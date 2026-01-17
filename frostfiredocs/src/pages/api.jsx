// src/pages/api.jsx
import { Link } from 'bertui/router';
import '../styles/api.css';

export default function API() {
  return (
    <div className="api-container">
      <header className="api-header bertui-animated bertui-fadeInDown">
        <h1 className="bertui-animated bertui-fadeIn">
          <span className="api-icon bertui-animated bertui-tada bertui-delay-1s">
            📚
          </span>
          API Documentation
        </h1>
        <p className="api-subtitle bertui-animated bertui-fadeIn bertui-delay-2s">
          Complete system API reference for Frostfire Forge
        </p>
        
        <div className="api-badges">
          <span className="api-badge api-badge-system bertui-animated bertui-pulse bertui-infinite bertui-slow">
            🔄 System API
          </span>
          <span className="api-badge api-badge-cache bertui-animated bertui-pulse bertui-infinite bertui-slow bertui-delay-1s">
            ⚡ Caching
          </span>
          <span className="api-badge api-badge-packet bertui-animated bertui-pulse bertui-infinite bertui-slow bertui-delay-2s">
            📦 Packets
          </span>
          <span className="api-badge api-badge-modules bertui-animated bertui-pulse bertui-infinite bertui-slow bertui-delay-3s">
            🧩 Modules
          </span>
        </div>
      </header>

      <div className="api-content">
        {/* Quick Navigation */}
        <div className="api-quick-nav bertui-animated bertui-fadeInUp">
          <a href="#overview" className="api-quick-link bertui-animated bertui-fadeInLeft">
            📋 Overview
          </a>
          <a href="#packets" className="api-quick-link bertui-animated bertui-fadeInLeft bertui-delay-1s">
            📦 Packets
          </a>
          <a href="#caching" className="api-quick-link bertui-animated bertui-fadeInLeft bertui-delay-2s">
            ⚡ Caching
          </a>
          <a href="#modules" className="api-quick-link bertui-animated bertui-fadeInLeft bertui-delay-3s">
            🧩 Modules
          </a>
          <a href="#reference" className="api-quick-link bertui-animated bertui-fadeInLeft bertui-delay-4s">
            📖 Reference
          </a>
        </div>

        {/* Overview */}
        <section id="overview" className="api-section bertui-animated bertui-fadeInUp bertui-delay-1s">
          <h2 className="bertui-animated bertui-fadeIn">
            <span className="section-icon bertui-animated bertui-wobble">
              📋
            </span>
            Overview
          </h2>
          
          <div className="api-note api-note-important bertui-animated bertui-pulse">
            <p>
              ⚠️
              <strong>Complete system API documentation is available at <code>/docs</code></strong>
            </p>
          </div>

          <p className="bertui-animated bertui-fadeIn bertui-delay-2s">
            The Frostfire Forge API provides comprehensive access to all system modules,
            allowing for deep customization and extension of game functionality.
          </p>

          <div className="api-features">
            <div className="api-feature bertui-animated bertui-fadeInUp bertui-delay-3s">
              <div className="api-feature-icon bertui-animated bertui-pulse bertui-infinite bertui-slow">
                👤
              </div>
              <h3>Player Management</h3>
              <p>Authentication, stats, inventory, and character management</p>
            </div>
            <div className="api-feature bertui-animated bertui-fadeInUp bertui-delay-4s">
              <div className="api-feature-icon bertui-animated bertui-pulse bertui-infinite bertui-slow bertui-delay-1s">
                🌍
              </div>
              <h3>World Systems</h3>
              <p>Worlds, maps, weather, NPCs, and environmental controls</p>
            </div>
            <div className="api-feature bertui-animated bertui-fadeInUp bertui-delay-5s">
              <div className="api-feature-icon bertui-animated bertui-pulse bertui-infinite bertui-slow bertui-delay-2s">
                ⚔️
              </div>
              <h3>Combat & Skills</h3>
              <p>Weapons, spells, combat mechanics, and skill systems</p>
            </div>
            <div className="api-feature bertui-animated bertui-fadeInUp bertui-fast">
              <div className="api-feature-icon bertui-animated bertui-pulse bertui-infinite bertui-slow bertui-delay-3s">
                👥
              </div>
              <h3>Social Features</h3>
              <p>Friends, parties, guilds, and permission systems</p>
            </div>
            <div className="api-feature bertui-animated bertui-fadeInUp bertui-fast bertui-delay-1s">
              <div className="api-feature-icon bertui-animated bertui-pulse bertui-infinite bertui-slow bertui-delay-4s">
                💰
              </div>
              <h3>Economy</h3>
              <p>Currency, item management, and trading systems</p>
            </div>
            <div className="api-feature bertui-animated bertui-fadeInUp bertui-fast bertui-delay-2s">
              <div className="api-feature-icon bertui-animated bertui-pulse bertui-infinite bertui-slow bertui-delay-5s">
                📜
              </div>
              <h3>Quest System</h3>
              <p>Quests, objectives, and quest log management</p>
            </div>
          </div>

          <h3 className="bertui-animated bertui-fadeIn bertui-delay-3s">
            Generating Documentation
          </h3>
          <div className="api-code-block bertui-animated bertui-fadeIn bertui-delay-4s">
            <pre><code>{`# Generate latest API documentation
bun run docs

# Documentation will be available at /docs
# or in the docs/ directory`}</code></pre>
          </div>
          <p className="bertui-animated bertui-fadeIn bertui-delay-5s">
            This command regenerates the API documentation with the latest system changes.
          </p>
        </section>

        {/* Packet Types */}
        <section id="packets" className="api-section bertui-animated bertui-fadeInUp bertui-delay-2s">
          <h2 className="bertui-animated bertui-fadeIn">
            <span className="section-icon bertui-animated bertui-bounce">
              📦
            </span>
            Authorized Packet Types
          </h2>
          
          <p className="bertui-animated bertui-fadeIn bertui-delay-3s">
            Packet type definitions for client-server communication. All packets are typed
            and validated for security.
          </p>

          <div className="api-code-block bertui-animated bertui-fadeIn bertui-delay-4s">
            <pre><code>{`// Import packet types
import { packetTypes } from "./types";

// Example packet structure
const chatPacket = {
  type: packetTypes.CHAT_MESSAGE,
  data: {
    sender: "Player1",
    message: "Hello World!",
    timestamp: Date.now()
  }
};

// Available packet types
console.log(packetTypes);
/*
  CHAT_MESSAGE: "chat_message",
  PLAYER_MOVE: "player_move",
  PLAYER_ACTION: "player_action",
  INVENTORY_UPDATE: "inventory_update",
  QUEST_UPDATE: "quest_update",
  COMBAT_EVENT: "combat_event",
  SYSTEM_MESSAGE: "system_message"
*/`}</code></pre>
          </div>

          <h3 className="bertui-animated bertui-fadeIn bertui-delay-5s">
            Packet Structure
          </h3>
          <div className="api-structure">
            <div className="api-structure-item bertui-animated bertui-fadeInLeft bertui-delay-5s">
              <h4>
                Standard Packet
              </h4>
              <div className="api-code-block">
                <pre><code>{`{
  type: string,      // Packet type identifier
  data: any,         // Packet payload
  timestamp: number, // Unix timestamp
  version: string    // Protocol version
}`}</code></pre>
              </div>
            </div>
            <div className="api-structure-item bertui-animated bertui-fadeInRight bertui-delay-5s">
              <h4>
                Error Packet
              </h4>
              <div className="api-code-block">
                <pre><code>{`{
  type: "error",
  error: {
    code: string,    // Error code
    message: string, // Human-readable message
    details?: any    // Additional error details
  }
}`}</code></pre>
              </div>
            </div>
          </div>
        </section>

        {/* Caching System */}
        <section id="caching" className="api-section bertui-animated bertui-fadeInUp bertui-delay-3s">
          <h2 className="bertui-animated bertui-fadeIn">
            <span className="section-icon bertui-animated bertui-flash bertui-infinite">
              ⚡
            </span>
            Caching System
          </h2>
          
          <div className="api-note api-note-info bertui-animated bertui-fadeIn bertui-delay-4s">
            <p>
              ℹ️ Frostfire Forge includes a dual-layer caching system with support for Redis
              (production) and in-memory (development) caching.
            </p>
          </div>

          <h3 className="bertui-animated bertui-fadeIn bertui-delay-5s">
            Importing Cache Modules
          </h3>
          <div className="api-code-block bertui-animated bertui-fadeIn bertui-fast">
            <pre><code>{`// Main player cache
import cache from '../services/cache';

// Asset caching (textures, sounds, etc.)
import assetCache from '../services/assetCache';`}</code></pre>
          </div>

          <h3 className="bertui-animated bertui-fadeIn bertui-fast bertui-delay-1s">
            Cache Methods
          </h3>
          <div className="api-methods">
            <div className="api-method-card bertui-animated bertui-fadeInUp bertui-fast bertui-delay-2s">
              <div className="api-method-header">
                <h4>
                  cache.add(key, value)
                </h4>
                <span className="api-method-signature">add(key: string, value: any): void</span>
              </div>
              <p className="api-method-desc">
                Adds an item to the cache with the specified key.
              </p>
              <div className="api-code-block">
                <pre><code>{`cache.add("player:123", {
  id: 123,
  name: "Player1",
  level: 50,
  position: { x: 100, y: 200 }
});`}</code></pre>
              </div>
            </div>

            <div className="api-method-card bertui-animated bertui-fadeInUp bertui-fast bertui-delay-3s">
              <div className="api-method-header">
                <h4>
                  cache.addNested(key, nestedKey, value)
                </h4>
                <span className="api-method-signature">addNested(key: string, nestedKey: string, value: any): void</span>
              </div>
              <p className="api-method-desc">
                Adds a nested item to an existing cache entry.
              </p>
              <div className="api-code-block">
                <pre><code>{`cache.addNested("player:123", "inventory", {
  sword: 1,
  shield: 1,
  potions: 5
});`}</code></pre>
              </div>
            </div>

            <div className="api-method-card bertui-animated bertui-fadeInUp bertui-fast bertui-delay-4s">
              <div className="api-method-header">
                <h4>
                  cache.get(key)
                </h4>
                <span className="api-method-signature">get(key: string): any</span>
              </div>
              <p className="api-method-desc">
                Fetches an item from the cache by key.
              </p>
              <div className="api-code-block">
                <pre><code>{`const player = cache.get("player:123");
console.log(player.name); // "Player1"`}</code></pre>
              </div>
            </div>

            <div className="api-method-card bertui-animated bertui-fadeInUp bertui-slow">
              <div className="api-method-header">
                <h4>
                  cache.remove(key)
                </h4>
                <span className="api-method-signature">remove(key: string): void</span>
              </div>
              <p className="api-method-desc">
                Removes an item from the cache.
              </p>
              <div className="api-code-block">
                <pre><code>{`cache.remove("player:123");`}</code></pre>
              </div>
            </div>

            <div className="api-method-card bertui-animated bertui-fadeInUp bertui-slow bertui-delay-1s">
              <div className="api-method-header">
                <h4>
                  cache.clear()
                </h4>
                <span className="api-method-signature">clear(): void</span>
              </div>
              <p className="api-method-desc">
                Clears all items from the cache.
              </p>
              <div className="api-code-block">
                <pre><code>{`cache.clear();`}</code></pre>
              </div>
            </div>

            <div className="api-method-card bertui-animated bertui-fadeInUp bertui-slow bertui-delay-2s">
              <div className="api-method-header">
                <h4>
                  cache.list()
                </h4>
                <span className="api-method-signature">list(): Array&lt;string&gt;</span>
              </div>
              <p className="api-method-desc">
                Returns all cache keys.
              </p>
              <div className="api-code-block">
                <pre><code>{`const keys = cache.list();
console.log(keys); // ["player:123", "player:456", ...]`}</code></pre>
              </div>
            </div>
          </div>

          <div className="api-note api-note-warning bertui-animated bertui-fadeIn bertui-slow bertui-delay-3s">
            <p>
              ⚠️
              <strong>Note:</strong> The same methods apply to <code>assetCache</code> for
              asset-specific caching operations.
            </p>
          </div>
        </section>

        {/* System Modules */}
        <section id="modules" className="api-section bertui-animated bertui-fadeInUp bertui-delay-4s">
          <h2 className="bertui-animated bertui-fadeIn">
            <span className="section-icon bertui-animated bertui-wiggle">
              🧩
            </span>
            System Modules
          </h2>
          
          <p className="bertui-animated bertui-fadeIn bertui-delay-5s">
            Frostfire Forge is built on a modular architecture. Here are the main system
            modules available for extension and customization.
          </p>

          <div className="api-modules">
            <div className="api-module-card bertui-animated bertui-fadeInUp bertui-fast">
              <h3>
                Player Module
              </h3>
              <div className="api-module-methods">
                <code>Player.create()</code>
                <code>Player.getById()</code>
                <code>Player.update()</code>
                <code>Player.delete()</code>
                <code>Player.getInventory()</code>
                <code>Player.getStats()</code>
              </div>
              <p className="api-module-desc">
                Complete player management including authentication, stats, inventory, and equipment.
              </p>
            </div>

            <div className="api-module-card bertui-animated bertui-fadeInUp bertui-fast bertui-delay-1s">
              <h3>
                World Module
              </h3>
              <div className="api-module-methods">
                <code>World.getMap()</code>
                <code>World.loadMap()</code>
                <code>World.getNPCs()</code>
                <code>World.spawnNPC()</code>
                <code>World.setWeather()</code>
                <code>World.getEntities()</code>
              </div>
              <p className="api-module-desc">
                World and map management including NPCs, weather systems, and entity management.
              </p>
            </div>

            <div className="api-module-card bertui-animated bertui-fadeInUp bertui-fast bertui-delay-2s">
              <h3>
                Combat Module
              </h3>
              <div className="api-module-methods">
                <code>Combat.attack()</code>
                <code>Combat.castSpell()</code>
                <code>Combat.calculateDamage()</code>
                <code>Combat.applyEffect()</code>
                <code>Combat.getCombatLog()</code>
                <code>Combat.resolveCombat()</code>
              </div>
              <p className="api-module-desc">
                Combat system with weapons, spells, damage calculation, and combat effects.
              </p>
            </div>

            <div className="api-module-card bertui-animated bertui-fadeInUp bertui-slow">
              <h3>
                Quest Module
              </h3>
              <div className="api-module-methods">
                <code>Quest.getAvailable()</code>
                <code>Quest.start()</code>
                <code>Quest.updateProgress()</code>
                <code>Quest.complete()</code>
                <code>Quest.getRewards()</code>
                <code>Quest.getLog()</code>
              </div>
              <p className="api-module-desc">
                Quest system with objectives, progress tracking, rewards, and quest logs.
              </p>
            </div>

            <div className="api-module-card bertui-animated bertui-fadeInUp bertui-slow bertui-delay-1s">
              <h3>
                Economy Module
              </h3>
              <div className="api-module-methods">
                <code>Economy.getBalance()</code>
                <code>Economy.transfer()</code>
                <code>Economy.addCurrency()</code>
                <code>Economy.removeCurrency()</code>
                <code>Economy.getMarketItems()</code>
                <code>Economy.trade()</code>
              </div>
              <p className="api-module-desc">
                Economy and trading system with currency management and market operations.
              </p>
            </div>

            <div className="api-module-card bertui-animated bertui-fadeInUp bertui-slow bertui-delay-2s">
              <h3>
                Social Module
              </h3>
              <div className="api-module-methods">
                <code>Social.addFriend()</code>
                <code>Social.removeFriend()</code>
                <code>Social.createParty()</code>
                <code>Social.inviteToParty()</code>
                <code>Social.createGuild()</code>
                <code>Social.getGuildMembers()</code>
              </div>
              <p className="api-module-desc">
                Social features including friends list, party system, and guild management.
              </p>
            </div>
          </div>
        </section>

        {/* Quick Reference */}
        <section id="reference" className="api-section bertui-animated bertui-fadeInUp bertui-delay-5s">
          <h2 className="bertui-animated bertui-fadeIn">
            <span className="section-icon bertui-animated bertui-bounceIn">
              📖
            </span>
            Quick Reference
          </h2>

          <h3 className="bertui-animated bertui-fadeIn bertui-fast">
            Common Patterns
          </h3>
          <div className="api-patterns">
            <div className="api-pattern bertui-animated bertui-fadeInLeft bertui-fast">
              <h4>
                Getting Player Data
              </h4>
              <div className="api-code-block">
                <pre><code>{`// Get player from cache first
let player = cache.get(\`player:\${playerId}\`);

// If not in cache, fetch from database
if (!player) {
  player = await database.players.findById(playerId);
  cache.add(\`player:\${playerId}\`, player);
}

return player;`}</code></pre>
              </div>
            </div>

            <div className="api-pattern bertui-animated bertui-fadeInRight bertui-fast bertui-delay-1s">
              <h4>
                Broadcasting to Players
              </h4>
              <div className="api-code-block">
                <pre><code>{`import { Events } from "../socket/server";

// Broadcast to all players
Events.Broadcast({
  type: "notification",
  message: "Server will restart in 5 minutes",
  timestamp: Date.now()
});

// Broadcast to specific map
const mapPlayers = Events.GetOnlineData()
  .filter(p => p.map === "forest");
  
mapPlayers.forEach(player => {
  player.send({
    type: "map_message",
    message: "A storm is approaching..."
  });
});`}</code></pre>
              </div>
            </div>

            <div className="api-pattern bertui-animated bertui-fadeInLeft bertui-slow">
              <h4>
                Error Handling
              </h4>
              <div className="api-code-block">
                <pre><code>{`try {
  const result = await someAsyncOperation();
  return { success: true, data: result };
} catch (error) {
  console.error("Operation failed:", error);
  
  // Send error to client
  Events.Broadcast({
    type: "error",
    error: {
      code: "OPERATION_FAILED",
      message: "The operation could not be completed"
    }
  });
  
  return { success: false, error: error.message };
}`}</code></pre>
              </div>
            </div>
          </div>

          <h3 className="bertui-animated bertui-fadeIn bertui-slow bertui-delay-2s">
            TypeScript Definitions
          </h3>
          <div className="api-code-block bertui-animated bertui-fadeIn bertui-slow bertui-delay-3s">
            <pre><code>{`// Common TypeScript interfaces
interface Player {
  id: number;
  name: string;
  level: number;
  experience: number;
  position: { x: number; y: number; };
  inventory: InventoryItem[];
  stats: PlayerStats;
}

interface Packet {
  type: string;
  data: any;
  timestamp: number;
  version: string;
}

interface CacheOptions {
  ttl?: number; // Time to live in seconds
  prefix?: string; // Cache key prefix
}

// Event listener type
type EventListener = (data: any) => void;`}</code></pre>
          </div>
        </section>

        {/* Next Steps */}
        <section className="api-section bertui-animated bertui-fadeInUp bertui-slower">
          <h2 className="bertui-animated bertui-fadeIn">
            <span className="section-icon bertui-animated bertui-tada bertui-infinite">
              🎯
            </span>
            Next Steps
          </h2>
          
          <div className="api-next-steps">
            <div className="api-next-step bertui-animated bertui-fadeInLeft">
              <h3>
                Event System
              </h3>
              <p>Learn about server lifecycle events and hooks.</p>
              <Link to="/events" className="api-next-link bertui-animated bertui-pulse bertui-infinite bertui-slow">
                Event System →
              </Link>
            </div>
            
            <div className="api-next-step bertui-animated bertui-fadeInUp">
              <h3>
                Commands Reference
              </h3>
              <p>Explore all available admin and player commands.</p>
              <Link to="/commands" className="api-next-link bertui-animated bertui-pulse bertui-infinite bertui-slow bertui-delay-1s">
                Commands Reference →
              </Link>
            </div>
            
            <div className="api-next-step bertui-animated bertui-fadeInRight">
              <h3>
                Getting Started
              </h3>
              <p>Start with the setup guide if you're new to Frostfire Forge.</p>
              <Link to="/getting-started" className="api-next-link bertui-animated bertui-pulse bertui-infinite bertui-slow bertui-delay-2s">
                Getting Started →
              </Link>
            </div>
          </div>
        </section>
      </div>

      {/* Navigation */}
      <div className="api-navigation">
        <Link to="/events" className="api-nav-link api-nav-prev bertui-animated bertui-fadeInLeft">
          ← Event System
        </Link>
        <Link to="/" className="api-nav-link api-nav-next bertui-animated bertui-fadeInRight">
          Home →
        </Link>
      </div>
    </div>
  );
}