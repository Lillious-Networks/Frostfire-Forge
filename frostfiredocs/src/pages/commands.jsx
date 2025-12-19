// src/pages/commands.jsx
import { Link } from 'bertui/router';
import '../styles/commands.css';

export default function Commands() {
  return (
    <div className="cmd-container">
      <header className="cmd-header">
        <h1>
          <span className="cmd-icon">📜</span>
          Commands Reference
        </h1>
        <p className="cmd-subtitle">
          Complete guide to admin and player commands in Frostfire Forge
        </p>
        
        <div className="cmd-badges">
          <span className="cmd-badge cmd-badge-admin">👑 Admin Commands</span>
          <span className="cmd-badge cmd-badge-player">🎮 Player Commands</span>
          <span className="cmd-badge cmd-badge-permission">🔒 Permission System</span>
        </div>
      </header>

      <div className="cmd-content">
        {/* Quick Navigation */}
        <div className="cmd-quick-nav">
          <a href="#admin" className="cmd-quick-link">👑 Admin</a>
          <a href="#player" className="cmd-quick-link">🎮 Player</a>
          <a href="#permissions" className="cmd-quick-link">🔒 Permissions</a>
          <a href="#usage" className="cmd-quick-link">💡 Usage Guide</a>
        </div>

        {/* Introduction */}
        <section className="cmd-section">
          <h2>Introduction</h2>
          <p>
            Frostfire Forge features a powerful command system with role-based permissions.
            Commands are executed in-game using the <code>/</code> prefix.
          </p>
          
          <div className="cmd-note cmd-note-info">
            <h3>Command Syntax</h3>
            <p>
              <strong>Square brackets [ ]</strong> indicate required parameters<br/>
              <strong>Angle brackets &lt; &gt;</strong> indicate optional parameters<br/>
              <strong>Pipe |</strong> indicates alternative options
            </p>
          </div>
        </section>

        {/* Admin Commands */}
        <section id="admin" className="cmd-section">
          <h2>
            <span className="section-icon">👑</span>
            Admin Commands
          </h2>
          
          <div className="cmd-note cmd-note-warning">
            <p>
              <strong>Warning:</strong> Admin commands require specific permissions.
              Use responsibly and only grant admin access to trusted users.
            </p>
          </div>

          <div className="cmd-category">
            <h3>Player Management</h3>
            <div className="cmd-grid">
              {/* Kick Command */}
              <div className="cmd-card cmd-card-admin">
                <div className="cmd-card-header">
                  <h4>/kick</h4>
                  <span className="cmd-alias">Aliases: disconnect</span>
                </div>
                <div className="cmd-syntax">
                  <code>/kick [username | id]</code>
                </div>
                <p className="cmd-description">
                  Disconnect a player from the server.
                </p>
                <div className="cmd-meta">
                  <span className="cmd-permission">
                    <strong>Permission:</strong> admin.kick | admin.*
                  </span>
                </div>
              </div>

              {/* Ban Command */}
              <div className="cmd-card cmd-card-admin">
                <div className="cmd-card-header">
                  <h4>/ban</h4>
                </div>
                <div className="cmd-syntax">
                  <code>/ban [username | id]</code>
                </div>
                <p className="cmd-description">
                  Ban a player from the server.
                </p>
                <div className="cmd-meta">
                  <span className="cmd-permission">
                    <strong>Permission:</strong> admin.ban | admin.*
                  </span>
                </div>
              </div>

              {/* Unban Command */}
              <div className="cmd-card cmd-card-admin">
                <div className="cmd-card-header">
                  <h4>/unban</h4>
                </div>
                <div className="cmd-syntax">
                  <code>/unban [username | id]</code>
                </div>
                <p className="cmd-description">
                  Remove a player's ban from the server.
                </p>
                <div className="cmd-meta">
                  <span className="cmd-permission">
                    <strong>Permission:</strong> admin.unban | admin.*
                  </span>
                </div>
              </div>

              {/* Admin Command */}
              <div className="cmd-card cmd-card-admin">
                <div className="cmd-card-header">
                  <h4>/admin</h4>
                  <span className="cmd-alias">Aliases: setadmin</span>
                </div>
                <div className="cmd-syntax">
                  <code>/admin [username | id]</code>
                </div>
                <p className="cmd-description">
                  Toggle admin status for a player.
                </p>
                <div className="cmd-meta">
                  <span className="cmd-permission">
                    <strong>Permission:</strong> server.admin | server.*
                  </span>
                </div>
              </div>
            </div>

            <h3>Server Management</h3>
            <div className="cmd-grid">
              {/* Shutdown Command */}
              <div className="cmd-card cmd-card-admin">
                <div className="cmd-card-header">
                  <h4>/shutdown</h4>
                </div>
                <div className="cmd-syntax">
                  <code>/shutdown</code>
                </div>
                <p className="cmd-description">
                  Immediately shutdown the server.
                </p>
                <div className="cmd-meta">
                  <span className="cmd-permission">
                    <strong>Permission:</strong> server.shutdown | server.*
                  </span>
                </div>
              </div>

              {/* Restart Command */}
              <div className="cmd-card cmd-card-admin">
                <div className="cmd-card-header">
                  <h4>/restart</h4>
                </div>
                <div className="cmd-syntax">
                  <code>/restart</code>
                </div>
                <p className="cmd-description">
                  Schedule server restart in 15 minutes.
                </p>
                <div className="cmd-meta">
                  <span className="cmd-permission">
                    <strong>Permission:</strong> server.restart
                  </span>
                </div>
              </div>

              {/* Notify Command */}
              <div className="cmd-card cmd-card-admin">
                <div className="cmd-card-header">
                  <h4>/notify</h4>
                  <span className="cmd-alias">Aliases: notify</span>
                </div>
                <div className="cmd-syntax">
                  <code>/notify [audience?] [message]</code>
                </div>
                <p className="cmd-description">
                  Send message to specific audience. Defaults to "all".
                </p>
                <div className="cmd-meta">
                  <span className="cmd-permission">
                    <strong>Permission:</strong> server.notify | server.*
                  </span>
                  <div className="cmd-options">
                    <strong>Audience:</strong> all (default) | map | admins
                  </div>
                </div>
              </div>
            </div>

            <h3>Game World Management</h3>
            <div className="cmd-grid">
              {/* Warp Command */}
              <div className="cmd-card cmd-card-admin">
                <div className="cmd-card-header">
                  <h4>/warp</h4>
                </div>
                <div className="cmd-syntax">
                  <code>/warp [map]</code>
                </div>
                <p className="cmd-description">
                  Teleport to a specific map location.
                </p>
                <div className="cmd-meta">
                  <span className="cmd-permission">
                    <strong>Permission:</strong> admin.warp | admin.*
                  </span>
                </div>
              </div>

              {/* Reloadmap Command */}
              <div className="cmd-card cmd-card-admin">
                <div className="cmd-card-header">
                  <h4>/reloadmap</h4>
                </div>
                <div className="cmd-syntax">
                  <code>/reloadmap [map]</code>
                </div>
                <p className="cmd-description">
                  Reload a specific map from disk.
                </p>
                <div className="cmd-meta">
                  <span className="cmd-permission">
                    <strong>Permission:</strong> admin.reloadmap | admin.*
                  </span>
                </div>
              </div>

              {/* Summon Command */}
              <div className="cmd-card cmd-card-admin">
                <div className="cmd-card-header">
                  <h4>/summon</h4>
                </div>
                <div className="cmd-syntax">
                  <code>/summon [username | id]</code>
                </div>
                <p className="cmd-description">
                  Teleport a player to your location.
                </p>
                <div className="cmd-meta">
                  <span className="cmd-permission">
                    <strong>Permission:</strong> admin.summon | admin.*
                  </span>
                </div>
              </div>

              {/* Respawn Command */}
              <div className="cmd-card cmd-card-admin">
                <div className="cmd-card-header">
                  <h4>/respawn</h4>
                </div>
                <div className="cmd-syntax">
                  <code>/respawn [username | id]</code>
                </div>
                <p className="cmd-description">
                  Respawn a player at spawn point.
                </p>
                <div className="cmd-meta">
                  <span className="cmd-permission">
                    <strong>Permission:</strong> admin.respawn | admin.*
                  </span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Player Commands */}
        <section id="player" className="cmd-section">
          <h2>
            <span className="section-icon">🎮</span>
            Player Commands
          </h2>
          
          <div className="cmd-note cmd-note-info">
            <p>
              These commands are available to all players and require no special permissions.
            </p>
          </div>

          <div className="cmd-grid">
            {/* Whisper Command */}
            <div className="cmd-card cmd-card-player">
              <div className="cmd-card-header">
                <h4>/whisper</h4>
                <span className="cmd-alias">Aliases: w</span>
              </div>
              <div className="cmd-syntax">
                <code>/whisper [username] [message]</code>
              </div>
              <p className="cmd-description">
                Send a private message to another player.
              </p>
              <div className="cmd-meta">
                <span className="cmd-usage">
                  <strong>Example:</strong> <code>/w John Hello there!</code>
                </span>
              </div>
            </div>

            {/* Party Command */}
            <div className="cmd-card cmd-card-player">
              <div className="cmd-card-header">
                <h4>/party</h4>
                <span className="cmd-alias">Aliases: p</span>
              </div>
              <div className="cmd-syntax">
                <code>/party [message]</code>
              </div>
              <p className="cmd-description">
                Send a message to all party members.
              </p>
              <div className="cmd-meta">
                <span className="cmd-requirement">
                  <strong>Requirement:</strong> Must be in a party
                </span>
                <span className="cmd-usage">
                  <strong>Example:</strong> <code>/p Let's attack the boss!</code>
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* Permission System */}
        <section id="permissions" className="cmd-section">
          <h2>
            <span className="section-icon">🔒</span>
            Permission System
          </h2>
          
          <div className="cmd-note cmd-note-important">
            <p>
              <strong>Important:</strong> The permission system controls access to commands and features.
              Use the <code>/permission</code> command to manage player permissions.
            </p>
          </div>

          {/* Permission Command */}
          <div className="cmd-card cmd-card-admin cmd-card-featured">
            <div className="cmd-card-header">
              <h4>/permission</h4>
              <span className="cmd-alias">Aliases: permissions</span>
            </div>
            <div className="cmd-syntax">
              <code>/permission [mode] [username | id] [permissions?]</code>
            </div>
            <p className="cmd-description">
              Manage player permissions with different modes.
            </p>
            
            <div className="cmd-meta">
              <span className="cmd-permission">
                <strong>Base Permission:</strong> admin.permission | admin.*
              </span>
            </div>

            <div className="cmd-modes">
              <h5>Available Modes:</h5>
              <div className="cmd-mode-grid">
                <div className="cmd-mode">
                  <h6>add</h6>
                  <p>Add permissions to a player</p>
                  <span className="cmd-mode-perm">
                    Permission: permission.add | permission.*
                  </span>
                </div>
                <div className="cmd-mode">
                  <h6>remove</h6>
                  <p>Remove permissions from a player</p>
                  <span className="cmd-mode-perm">
                    Permission: permission.remove | permission.*
                  </span>
                </div>
                <div className="cmd-mode">
                  <h6>set</h6>
                  <p>Set player's permissions (overwrites existing)</p>
                  <span className="cmd-mode-perm">
                    Permission: permission.add | permission.*
                  </span>
                </div>
                <div className="cmd-mode">
                  <h6>clear</h6>
                  <p>Clear all permissions from a player</p>
                  <span className="cmd-mode-perm">
                    Permission: permission.remove | permission.*
                  </span>
                </div>
                <div className="cmd-mode">
                  <h6>list</h6>
                  <p>List player's current permissions</p>
                  <span className="cmd-mode-perm">
                    Permission: permission.list | permission.*
                  </span>
                </div>
              </div>
            </div>

            <div className="cmd-examples">
              <h5>Usage Examples:</h5>
              <div className="cmd-example-group">
                <div className="cmd-example">
                  <code>/permission add Player1 admin.kick admin.ban</code>
                  <span>Adds kick and ban permissions to Player1</span>
                </div>
                <div className="cmd-example">
                  <code>/permission remove Player1 admin.ban</code>
                  <span>Removes ban permission from Player1</span>
                </div>
                <div className="cmd-example">
                  <code>/permission list Player1</code>
                  <span>Lists all permissions for Player1</span>
                </div>
              </div>
            </div>
          </div>

          <h3>Common Permission Groups</h3>
          <div className="cmd-permission-groups">
            <div className="cmd-perm-group">
              <h4>admin.*</h4>
              <p>Full administrator access including all admin commands</p>
              <div className="cmd-perm-list">
                <code>admin.kick</code>
                <code>admin.ban</code>
                <code>admin.warp</code>
                <code>admin.summon</code>
                <code>admin.reloadmap</code>
                <code>admin.respawn</code>
                <code>admin.permission</code>
              </div>
            </div>
            
            <div className="cmd-perm-group">
              <h4>server.*</h4>
              <p>Server management access</p>
              <div className="cmd-perm-list">
                <code>server.shutdown</code>
                <code>server.restart</code>
                <code>server.notify</code>
                <code>server.admin</code>
              </div>
            </div>
            
            <div className="cmd-perm-group">
              <h4>permission.*</h4>
              <p>Permission management access</p>
              <div className="cmd-perm-list">
                <code>permission.add</code>
                <code>permission.remove</code>
                <code>permission.list</code>
              </div>
            </div>
          </div>
        </section>

        {/* Usage Guide */}
        <section id="usage" className="cmd-section">
          <h2>
            <span className="section-icon">💡</span>
            Usage Guide
          </h2>

          <div className="cmd-usage-guide">
            <h3>How to Use Commands</h3>
            <div className="cmd-steps">
              <div className="cmd-step">
                <div className="cmd-step-number">1</div>
                <div className="cmd-step-content">
                  <h4>Open Chat</h4>
                  <p>Press the chat key (usually <code>Enter</code> or <code>T</code>) to open the chat window.</p>
                </div>
              </div>
              
              <div className="cmd-step">
                <div className="cmd-step-number">2</div>
                <div className="cmd-step-content">
                  <h4>Type Command</h4>
                  <p>Type <code>/</code> followed by the command name and parameters.</p>
                  <div className="cmd-code-block">
                    <pre><code>/kick PlayerName</code></pre>
                  </div>
                </div>
              </div>
              
              <div className="cmd-step">
                <div className="cmd-step-number">3</div>
                <div className="cmd-step-content">
                  <h4>Execute</h4>
                  <p>Press <code>Enter</code> to execute the command.</p>
                </div>
              </div>
            </div>

            <h3>Command Examples</h3>
            <div className="cmd-example-grid">
              <div className="cmd-example-card">
                <h4>Basic Usage</h4>
                <div className="cmd-code-block">
                  <pre><code>/kick JohnDoe</code></pre>
                </div>
                <p>Kicks player "JohnDoe" from the server</p>
              </div>
              
              <div className="cmd-example-card">
                <h4>Using Player ID</h4>
                <div className="cmd-code-block">
                  <pre><code>/ban 12345</code></pre>
                </div>
                <p>Bans player with ID "12345"</p>
              </div>
              
              <div className="cmd-example-card">
                <h4>With Options</h4>
                <div className="cmd-code-block">
                  <pre><code>/notify map Server restarting in 5 minutes!</code></pre>
                </div>
                <p>Sends notification to all players on current map</p>
              </div>
            </div>

            <div className="cmd-note cmd-note-warning">
              <h3>Common Issues</h3>
              <p>
                <strong>Permission Denied:</strong> You don't have the required permission for that command.<br/>
                <strong>Player Not Found:</strong> The specified username or ID doesn't exist.<br/>
                <strong>Invalid Syntax:</strong> Check the command syntax and parameters.
              </p>
            </div>
          </div>
        </section>

        {/* Next Steps */}
        <section className="cmd-section">
          <h2>
            <span className="section-icon">🎯</span>
            Next Steps
          </h2>
          
          <div className="cmd-next-steps">
            <div className="cmd-next-step">
              <h3>Event System</h3>
              <p>Learn about server lifecycle events and how to extend functionality.</p>
              <Link to="/events" className="cmd-next-link">
                Event System →
              </Link>
            </div>
            
            <div className="cmd-next-step">
              <h3>API Documentation</h3>
              <p>Explore the complete system API for advanced customization.</p>
              <Link to="/api" className="cmd-next-link">
                API Documentation →
              </Link>
            </div>
            
            <div className="cmd-next-step">
              <h3>Getting Started</h3>
              <p>If you're new to Frostfire Forge, start with the setup guide.</p>
              <Link to="/getting-started" className="cmd-next-link">
                Getting Started →
              </Link>
            </div>
          </div>
        </section>
      </div>

      {/* Navigation */}
      <div className="cmd-navigation">
        <Link to="/environment" className="cmd-nav-link cmd-nav-prev">
          ← Environment Variables
        </Link>
        <Link to="/events" className="cmd-nav-link cmd-nav-next">
          Event System →
        </Link>
      </div>
    </div>
  );
}