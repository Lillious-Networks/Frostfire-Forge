// src/pages/events.jsx
import { Link } from 'bertui/router';
import '../styles/events.css';

export default function Events() {
  return (
    <div className="events-container">
      <header className="events-header">
        <h1>
          <span className="events-icon">⚡</span>
          Event System
        </h1>
        <p className="events-subtitle">
          Complete guide to server lifecycle events and hooks in Frostfire Forge
        </p>
        
        <div className="events-badges">
          <span className="events-badge events-badge-hook">🪝 Lifecycle Hooks</span>
          <span className="events-badge events-badge-real">🔄 Real-time Events</span>
          <span className="events-badge events-badge-api">📡 Event API</span>
        </div>
      </header>

      <div className="events-content">
        {/* Quick Navigation */}
        <div className="events-quick-nav">
          <a href="#overview" className="events-quick-link">📋 Overview</a>
          <a href="#lifecycle" className="events-quick-link">🔄 Lifecycle</a>
          <a href="#realtime" className="events-quick-link">⚡ Real-time</a>
          <a href="#api" className="events-quick-link">📡 API Reference</a>
          <a href="#examples" className="events-quick-link">💡 Examples</a>
        </div>

        {/* Overview */}
        <section id="overview" className="events-section">
          <h2>
            <span className="section-icon">📋</span>
            Overview
          </h2>
          
          <p>
            Frostfire Forge features a powerful event system that allows you to hook into server lifecycle events,
            monitor real-time activities, and extend functionality through custom event listeners.
          </p>
          
          <div className="events-note events-note-info">
            <h3>Event System Architecture</h3>
            <p>
              The event system uses a pub/sub pattern where events are emitted by the server core
              and can be listened to by any module or plugin. Events are fully typed and provide
              relevant data payloads.
            </p>
          </div>

          <div className="events-features">
            <div className="events-feature">
              <div className="events-feature-icon">🔄</div>
              <h3>Lifecycle Events</h3>
              <p>Hook into server startup, updates, and shutdown sequences</p>
            </div>
            <div className="events-feature">
              <div className="events-feature-icon">👥</div>
              <h3>Player Events</h3>
              <p>Monitor player connections, disconnections, and activities</p>
            </div>
            <div className="events-feature">
              <div className="events-feature-icon">⚡</div>
              <h3>Real-time Events</h3>
              <p>Receive events at fixed intervals for game logic updates</p>
            </div>
            <div className="events-feature">
              <div className="events-feature-icon">🔧</div>
              <h3>Custom Events</h3>
              <p>Create and emit your own custom events for plugins</p>
            </div>
          </div>
        </section>

        {/* Lifecycle Events */}
        <section id="lifecycle" className="events-section">
          <h2>
            <span className="section-icon">🔄</span>
            Lifecycle Events
          </h2>
          
          <div className="events-note events-note-important">
            <p>
              <strong>Important:</strong> Lifecycle events follow a specific order during server startup and shutdown.
              Understanding this order is crucial for proper plugin initialization.
            </p>
          </div>

          <div className="events-lifecycle">
            <div className="events-lifecycle-step">
              <div className="events-step-number">1</div>
              <div className="events-step-content">
                <h3>onAwake</h3>
                <div className="events-code-block">
                  <pre><code>{`Listener.on("onAwake", (data) => {
  console.log("Server is waking up");
});`}</code></pre>
                </div>
                <p className="events-event-desc">
                  Fires immediately after the server starts, before any initialization.
                  Use for early setup that doesn't depend on other systems.
                </p>
              </div>
            </div>

            <div className="events-lifecycle-step">
              <div className="events-step-number">2</div>
              <div className="events-step-content">
                <h3>onStart</h3>
                <div className="events-code-block">
                  <pre><code>{`Listener.on("onStart", (data) => {
  console.log("Server is starting");
});`}</code></pre>
                </div>
                <p className="events-event-desc">
                  Fires immediately after <code>onAwake</code>, once core systems are initialized.
                  Use for main initialization logic.
                </p>
              </div>
            </div>

            <div className="events-lifecycle-step">
              <div className="events-step-number">3</div>
              <div className="events-step-content">
                <h3>onUpdate</h3>
                <div className="events-code-block">
                  <pre><code>{`Listener.on("onUpdate", (data) => {
  console.log("Update tick");
});`}</code></pre>
                </div>
                <p className="events-event-desc">
                  Fires immediately after <code>onStart</code> every 60 frames (approx. 1 second at 60 FPS).
                  Use for game logic that needs frequent updates.
                </p>
                <div className="events-event-meta">
                  <span className="events-meta-item">
                    <strong>Frequency:</strong> Every 60 frames
                  </span>
                  <span className="events-meta-item">
                    <strong>Use Case:</strong> Game logic, AI updates
                  </span>
                </div>
              </div>
            </div>

            <div className="events-lifecycle-step">
              <div className="events-step-number">4</div>
              <div className="events-step-content">
                <h3>onFixedUpdate</h3>
                <div className="events-code-block">
                  <pre><code>{`Listener.on("onFixedUpdate", (data) => {
  console.log("Fixed update tick");
});`}</code></pre>
                </div>
                <p className="events-event-desc">
                  Fires immediately after <code>onStart</code> every 100ms (10 times per second).
                  Use for physics and network updates that need consistent timing.
                </p>
                <div className="events-event-meta">
                  <span className="events-meta-item">
                    <strong>Frequency:</strong> Every 100ms
                  </span>
                  <span className="events-meta-item">
                    <strong>Use Case:</strong> Physics, network sync
                  </span>
                </div>
              </div>
            </div>

            <div className="events-lifecycle-step">
              <div className="events-step-number">5</div>
              <div className="events-step-content">
                <h3>onSave</h3>
                <div className="events-code-block">
                  <pre><code>{`Listener.on("onSave", (data) => {
  console.log("Auto-save triggered");
});`}</code></pre>
                </div>
                <p className="events-event-desc">
                  Fires every 1 minute for automatic data persistence.
                  Use for saving game state, player data, or other persistent information.
                </p>
                <div className="events-event-meta">
                  <span className="events-meta-item">
                    <strong>Frequency:</strong> Every 1 minute
                  </span>
                  <span className="events-meta-item">
                    <strong>Use Case:</strong> Data persistence, backups
                  </span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Real-time Events */}
        <section id="realtime" className="events-section">
          <h2>
            <span className="section-icon">⚡</span>
            Real-time Events
          </h2>
          
          <p>
            These events provide real-time monitoring of server activities and player interactions.
          </p>

          <div className="events-grid">
            <div className="events-card">
              <div className="events-card-header">
                <h3>onConnection</h3>
              </div>
              <div className="events-code-block">
                <pre><code>{`Listener.on("onConnection", (data) => {
  console.log(\`New connection: \${data}\`);
});`}</code></pre>
              </div>
              <p className="events-event-desc">
                Fires when a new WebSocket connection is established.
              </p>
              <div className="events-event-meta">
                <span className="events-meta-item">
                  <strong>Data:</strong> Connection ID and metadata
                </span>
                <span className="events-meta-item">
                  <strong>Use Case:</strong> Connection logging, welcome messages
                </span>
              </div>
            </div>

            <div className="events-card">
              <div className="events-card-header">
                <h3>onDisconnect</h3>
              </div>
              <div className="events-code-block">
                <pre><code>{`Listener.on("onDisconnect", (data) => {
  console.log(\`Disconnected: \${data}\`);
});`}</code></pre>
              </div>
              <p className="events-event-desc">
                Fires when a WebSocket connection is closed or lost.
              </p>
              <div className="events-event-meta">
                <span className="events-meta-item">
                  <strong>Data:</strong> Connection ID and reason
                </span>
                <span className="events-meta-item">
                  <strong>Use Case:</strong> Cleanup, disconnect logging
                </span>
              </div>
            </div>

            <div className="events-card">
              <div className="events-card-header">
                <h3>onServerTick</h3>
              </div>
              <div className="events-code-block">
                <pre><code>{`Listener.on("onServerTick", (data) => {
  console.log(\`Server tick: \${data}\`);
});`}</code></pre>
              </div>
              <p className="events-event-desc">
                Fires every 1 second for general server maintenance tasks.
              </p>
              <div className="events-event-meta">
                <span className="events-meta-item">
                  <strong>Frequency:</strong> Every 1 second
                </span>
                <span className="events-meta-item">
                  <strong>Use Case:</strong> Maintenance, cleanup, monitoring
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* API Reference */}
        <section id="api" className="events-section">
          <h2>
            <span className="section-icon">📡</span>
            API Reference
          </h2>
          
          <div className="events-note events-note-info">
            <p>
              The Events API provides methods to interact with the event system, emit custom events,
              and manage event listeners programmatically.
            </p>
          </div>

          <h3>Importing the Event System</h3>
          <div className="events-code-block">
            <pre><code>{`// Import the Listener module
import { Listener } from "../socket/server";

// Or import specific event types
import { Events } from "../socket/server";`}</code></pre>
          </div>

          <h3>Event Methods</h3>
          <div className="events-methods">
            <div className="events-method-card">
              <div className="events-method-header">
                <h4>Listener.on()</h4>
                <span className="events-method-signature">on(event: string, callback: Function)</span>
              </div>
              <p className="events-method-desc">
                Register a callback function for a specific event.
              </p>
              <div className="events-code-block">
                <pre><code>{`Listener.on("onConnection", (connectionData) => {
  // Handle new connection
});`}</code></pre>
              </div>
            </div>

            <div className="events-method-card">
              <div className="events-method-header">
                <h4>Listener.off()</h4>
                <span className="events-method-signature">off(event: string, callback: Function)</span>
              </div>
              <p className="events-method-desc">
                Remove a specific callback from an event.
              </p>
              <div className="events-code-block">
                <pre><code>{`const handler = (data) => console.log(data);
Listener.on("onUpdate", handler);
// Later...
Listener.off("onUpdate", handler);`}</code></pre>
              </div>
            </div>

            <div className="events-method-card">
              <div className="events-method-header">
                <h4>Listener.emit()</h4>
                <span className="events-method-signature">emit(event: string, data?: any)</span>
              </div>
              <p className="events-method-desc">
                Emit a custom event with optional data payload.
              </p>
              <div className="events-code-block">
                <pre><code>{`// Emit a custom event
Listener.emit("playerLevelUp", {
  playerId: 123,
  newLevel: 50,
  timestamp: Date.now()
});`}</code></pre>
              </div>
            </div>

            <div className="events-method-card">
              <div className="events-method-header">
                <h4>Listener.removeAll()</h4>
                <span className="events-method-signature">removeAll(event: string)</span>
              </div>
              <p className="events-method-desc">
                Remove all listeners for a specific event.
              </p>
              <div className="events-code-block">
                <pre><code>{`// Remove all onUpdate listeners
Listener.removeAll("onUpdate");`}</code></pre>
              </div>
            </div>
          </div>

          <h3>Events Utility Methods</h3>
          <div className="events-code-block">
            <pre><code>{`// Import Events utility
import { Events } from "../socket/server";

// Get online player count
const onlineCount = Events.GetOnlineCount();

// Get detailed online data
const onlineData = Events.GetOnlineData();

// Broadcast message to all clients
Events.Broadcast({
  type: "notification",
  message: "Server restart in 5 minutes"
});

// Get client request data
const requests = Events.GetClientRequests();

// Get rate-limited clients
const limitedClients = Events.GetRateLimitedClients();`}</code></pre>
          </div>
        </section>

        {/* Examples */}
        <section id="examples" className="events-section">
          <h2>
            <span className="section-icon">💡</span>
            Examples
          </h2>

          <div className="events-examples">
            <div className="events-example-card">
              <h3>Example 1: Welcome Message</h3>
              <p>Send a welcome message to players when they connect.</p>
              <div className="events-code-block">
                <pre><code>{`Listener.on("onConnection", (connectionData) => {
  const { playerId, playerName } = connectionData;
  
  // Send welcome message
  Events.Broadcast({
    type: "chat",
    message: \`Welcome \${playerName} to the server!\`,
    sender: "System"
  });
  
  // Log connection
  console.log(\`Player connected: \${playerName} (ID: \${playerId})\`);
});`}</code></pre>
              </div>
            </div>

            <div className="events-example-card">
              <h3>Example 2: Auto-save System</h3>
              <p>Implement an auto-save system using the onSave event.</p>
              <div className="events-code-block">
                <pre><code>{`Listener.on("onSave", () => {
  const onlinePlayers = Events.GetOnlineData();
  
  onlinePlayers.forEach(player => {
    // Save player data
    savePlayerData(player.id, {
      position: player.position,
      inventory: player.inventory,
      stats: player.stats,
      lastSave: Date.now()
    });
  });
  
  console.log(\`Auto-saved \${onlinePlayers.length} players\`);
});

async function savePlayerData(playerId, data) {
  // Implementation for saving player data
  // to database or file system
}`}</code></pre>
              </div>
            </div>

            <div className="events-example-card">
              <h3>Example 3: Custom Event System</h3>
              <p>Create and use custom events for game mechanics.</p>
              <div className="events-code-block">
                <pre><code>{`// Define custom event listeners
Listener.on("playerLevelUp", (data) => {
  const { playerId, newLevel, oldLevel } = data;
  
  // Broadcast achievement
  Events.Broadcast({
    type: "achievement",
    message: \`Player reached level \${newLevel}!\`,
    playerId: playerId
  });
  
  // Grant level-up rewards
  grantLevelRewards(playerId, newLevel);
});

// Emit custom event when player levels up
function onPlayerLevelUp(playerId, newLevel, oldLevel) {
  Listener.emit("playerLevelUp", {
    playerId,
    newLevel,
    oldLevel,
    timestamp: Date.now()
  });
}`}</code></pre>
              </div>
            </div>

            <div className="events-example-card">
              <h3>Example 4: Server Monitoring</h3>
              <p>Monitor server health and performance.</p>
              <div className="events-code-block">
                <pre><code>{`Listener.on("onServerTick", () => {
  const onlineCount = Events.GetOnlineCount();
  const memoryUsage = process.memoryUsage();
  
  // Log server stats every minute
  if (Date.now() % 60000 < 1000) { // Every minute
    console.log(\`Server Stats - Online: \${onlineCount}, Memory: \${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB\`);
  }
  
  // Alert if player count is too high
  if (onlineCount > 1000) {
    console.warn("High player count detected!");
  }
});`}</code></pre>
              </div>
            </div>
          </div>

          <h3>Best Practices</h3>
          <div className="events-best-practices">
            <div className="events-practice">
              <h4>📝 Use Descriptive Event Names</h4>
              <p>Use clear, descriptive names for custom events (e.g., <code>playerQuestCompleted</code> instead of <code>questDone</code>).</p>
            </div>
            <div className="events-practice">
              <h4>⚡ Keep Event Handlers Lightweight</h4>
              <p>Event handlers should execute quickly. Defer heavy operations to background tasks.</p>
            </div>
            <div className="events-practice">
              <h4>🔧 Clean Up Listeners</h4>
              <p>Always remove event listeners when they're no longer needed to prevent memory leaks.</p>
            </div>
            <div className="events-practice">
              <h4>📊 Use Event Data Wisely</h4>
              <p>Include only necessary data in event payloads to minimize network and memory usage.</p>
            </div>
          </div>
        </section>

        {/* Next Steps */}
        <section className="events-section">
          <h2>
            <span className="section-icon">🎯</span>
            Next Steps
          </h2>
          
          <div className="events-next-steps">
            <div className="events-next-step">
              <h3>API Documentation</h3>
              <p>Explore the complete system API for advanced customization.</p>
              <Link to="/api" className="events-next-link">
                API Documentation →
              </Link>
            </div>
            
            <div className="events-next-step">
              <h3>Packet Types</h3>
              <p>Learn about authorized packet types for client-server communication.</p>
              <Link to="/api#packets" className="events-next-link">
                Packet Types →
              </Link>
            </div>
            
            <div className="events-next-step">
              <h3>Caching System</h3>
              <p>Understand how to use the caching system for optimal performance.</p>
              <Link to="/api#caching" className="events-next-link">
                Caching System →
              </Link>
            </div>
          </div>
        </section>
      </div>

      {/* Navigation */}
      <div className="events-navigation">
        <Link to="/commands" className="events-nav-link events-nav-prev">
          ← Commands Reference
        </Link>
        <Link to="/api" className="events-nav-link events-nav-next">
          API Documentation →
        </Link>
      </div>
    </div>
  );
}