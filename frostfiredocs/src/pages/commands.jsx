// src/pages/commands.jsx
import { Link } from 'bertui/router';
import '../styles/commands.css';

export default function Commands() {
  return (
    <div className="cmd-container">
      <header className="cmd-header bertui-animated bertui-fadeInDown">
        <h1 className="bertui-animated bertui-fadeIn">
          <span className="cmd-icon bertui-animated bertui-tada bertui-delay-1s">
            📜
          </span>
          Commands Reference
        </h1>
        <p className="cmd-subtitle bertui-animated bertui-fadeIn bertui-delay-2s">
          Complete guide to admin and player commands in Frostfire Forge
        </p>
        
        <div className="cmd-badges">
          <span className="cmd-badge cmd-badge-admin bertui-animated bertui-pulse bertui-infinite bertui-slow">
            👑 Admin Commands
          </span>
          <span className="cmd-badge cmd-badge-player bertui-animated bertui-pulse bertui-infinite bertui-slow bertui-delay-1s">
            🎮 Player Commands
          </span>
          <span className="cmd-badge cmd-badge-permission bertui-animated bertui-pulse bertui-infinite bertui-slow bertui-delay-2s">
            🔒 Permission System
          </span>
        </div>
      </header>

      <div className="cmd-content">
        {/* Quick Navigation */}
        <div className="cmd-quick-nav bertui-animated bertui-fadeInUp">
          <a href="#admin" className="cmd-quick-link bertui-animated bertui-fadeInLeft">
            👑 Admin
          </a>
          <a href="#player" className="cmd-quick-link bertui-animated bertui-fadeInLeft bertui-delay-1s">
            🎮 Player
          </a>
          <a href="#permissions" className="cmd-quick-link bertui-animated bertui-fadeInLeft bertui-delay-2s">
            🔒 Permissions
          </a>
          <a href="#usage" className="cmd-quick-link bertui-animated bertui-fadeInLeft bertui-delay-3s">
            💡 Usage Guide
          </a>
        </div>

        {/* Introduction */}
        <section className="cmd-section bertui-animated bertui-fadeInUp bertui-delay-1s">
          <h2 className="bertui-animated bertui-fadeIn">
            Introduction
          </h2>
          <p className="bertui-animated bertui-fadeIn bertui-delay-2s">
            Frostfire Forge features a powerful command system with role-based permissions.
            Commands are executed in-game using the <code>/</code> prefix.
          </p>
          
          <div className="cmd-note cmd-note-info bertui-animated bertui-pulse">
            <h3>Command Syntax</h3>
            <p>
              <strong>Square brackets [ ]</strong> indicate required parameters<br/>
              <strong>Angle brackets &lt; &gt;</strong> indicate optional parameters<br/>
              <strong>Pipe |</strong> indicates alternative options
            </p>
          </div>
        </section>

        {/* Admin Commands */}
        <section id="admin" className="cmd-section bertui-animated bertui-fadeInUp bertui-delay-2s">
          <h2 className="bertui-animated bertui-fadeIn">
            <span className="section-icon bertui-animated bertui-wobble">
              👑
            </span>
            Admin Commands
          </h2>
          
          <div className="cmd-note cmd-note-warning bertui-animated bertui-pulse">
            <p>
              ⚠️
              <strong>Warning:</strong> Admin commands require specific permissions.
              Use responsibly and only grant admin access to trusted users.
            </p>
          </div>

          <div className="cmd-category">
            <h3 className="bertui-animated bertui-fadeIn bertui-delay-3s">
              Player Management
            </h3>
            <div className="cmd-grid">
              {/* Kick Command */}
              <div className="cmd-card cmd-card-admin bertui-animated bertui-fadeInUp bertui-delay-3s">
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
              <div className="cmd-card cmd-card-admin bertui-animated bertui-fadeInUp bertui-delay-4s">
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
              <div className="cmd-card cmd-card-admin bertui-animated bertui-fadeInUp bertui-delay-5s">
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
              <div className="cmd-card cmd-card-admin bertui-animated bertui-fadeInUp bertui-fast">
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

            <h3 className="bertui-animated bertui-fadeIn bertui-fast bertui-delay-1s">
              Server Management
            </h3>
            <div className="cmd-grid">
              {/* Shutdown Command */}
              <div className="cmd-card cmd-card-admin bertui-animated bertui-fadeInUp bertui-fast bertui-delay-1s">
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
              <div className="cmd-card cmd-card-admin bertui-animated bertui-fadeInUp bertui-fast bertui-delay-2s">
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
              <div className="cmd-card cmd-card-admin bertui-animated bertui-fadeInUp bertui-fast bertui-delay-3s">
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

            <h3 className="bertui-animated bertui-fadeIn bertui-slow">
              Game World Management
            </h3>
            <div className="cmd-grid">
              {/* Warp Command */}
              <div className="cmd-card cmd-card-admin bertui-animated bertui-fadeInUp bertui-slow">
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
              <div className="cmd-card cmd-card-admin bertui-animated bertui-fadeInUp bertui-slow bertui-delay-1s">
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
              <div className="cmd-card cmd-card-admin bertui-animated bertui-fadeInUp bertui-slow bertui-delay-2s">
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
              <div className="cmd-card cmd-card-admin bertui-animated bertui-fadeInUp bertui-slow bertui-delay-3s">
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
        <section id="player" className="cmd-section bertui-animated bertui-fadeInUp bertui-delay-3s">
          <h2 className="bertui-animated bertui-fadeIn">
            <span className="section-icon bertui-animated bertui-bounce">
              🎮
            </span>
            Player Commands
          </h2>
          
          <div className="cmd-note cmd-note-info bertui-animated bertui-pulse">
            <p>
              ℹ️ These commands are available to all players and require no special permissions.
            </p>
          </div>

          <div className="cmd-grid">
            {/* Whisper Command */}
            <div className="cmd-card cmd-card-player bertui-animated bertui-fadeInUp bertui-fast">
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
            <div className="cmd-card cmd-card-player bertui-animated bertui-fadeInUp bertui-fast bertui-delay-1s">
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
        <section id="permissions" className="cmd-section bertui-animated bertui-fadeInUp bertui-delay-4s">
          <h2 className="bertui-animated bertui-fadeIn">
            <span className="section-icon bertui-animated bertui-flash">
              🔒
            </span>
            Permission System
          </h2>
          
          <div className="cmd-note cmd-note-important bertui-animated bertui-pulse">
            <p>
              ⚠️
              <strong>Important:</strong> The permission system controls access to commands and features.
              Use the <code>/permission</code> command to manage player permissions.
            </p>
          </div>

          {/* Permission Command */}
          <div className="cmd-card cmd-card-admin cmd-card-featured bertui-animated bertui-fadeInUp bertui-fast">
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
                <div className="cmd-mode bertui-animated bertui-fadeInLeft bertui-fast">
                  <h6>add</h6>
                  <p>Add permissions to a player</p>
                  <span className="cmd-mode-perm">
                    Permission: permission.add | permission.*
                  </span>
                </div>
                <div className="cmd-mode bertui-animated bertui-fadeInLeft bertui-fast bertui-delay-1s">
                  <h6>remove</h6>
                  <p>Remove permissions from a player</p>
                  <span className="cmd-mode-perm">
                    Permission: permission.remove | permission.*
                  </span>
                </div>
                <div className="cmd-mode bertui-animated bertui-fadeInLeft bertui-fast bertui-delay-2s">
                  <h6>set</h6>
                  <p>Set player's permissions (overwrites existing)</p>
                  <span className="cmd-mode-perm">
                    Permission: permission.add | permission.*
                  </span>
                </div>
                <div className="cmd-mode bertui-animated bertui-fadeInRight bertui-slow">
                  <h6>clear</h6>
                  <p>Clear all permissions from a player</p>
                  <span className="cmd-mode-perm">
                    Permission: permission.remove | permission.*
                  </span>
                </div>
                <div className="cmd-mode bertui-animated bertui-fadeInRight bertui-slow bertui-delay-1s">
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
                <div className="cmd-example bertui-animated bertui-fadeInUp bertui-slow">
                  <code>/permission add Player1 admin.kick admin.ban</code>
                  <span>Adds kick and ban permissions to Player1</span>
                </div>
                <div className="cmd-example bertui-animated bertui-fadeInUp bertui-slow bertui-delay-1s">
                  <code>/permission remove Player1 admin.ban</code>
                  <span>Removes ban permission from Player1</span>
                </div>
                <div className="cmd-example bertui-animated bertui-fadeInUp bertui-slow bertui-delay-2s">
                  <code>/permission list Player1</code>
                  <span>Lists all permissions for Player1</span>
                </div>
              </div>
            </div>
          </div>

          <h3 className="bertui-animated bertui-fadeIn bertui-slow bertui-delay-3s">
            Common Permission Groups
          </h3>
          <div className="cmd-permission-groups">
            <div className="cmd-perm-group bertui-animated bertui-fadeInLeft bertui-slow">
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
            
            <div className="cmd-perm-group bertui-animated bertui-fadeInUp bertui-slow">
              <h4>server.*</h4>
              <p>Server management access</p>
              <div className="cmd-perm-list">
                <code>server.shutdown</code>
                <code>server.restart</code>
                <code>server.notify</code>
                <code>server.admin</code>
              </div>
            </div>
            
            <div className="cmd-perm-group bertui-animated bertui-fadeInRight bertui-slow">
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
        <section id="usage" className="cmd-section bertui-animated bertui-fadeInUp bertui-delay-5s">
          <h2 className="bertui-animated bertui-fadeIn">
            <span className="section-icon bertui-animated bertui-bounceIn">
              💡
            </span>
            Usage Guide
          </h2>

          <div className="cmd-usage-guide">
            <h3 className="bertui-animated bertui-fadeIn bertui-fast">
              How to Use Commands
            </h3>
            <div className="cmd-steps">
              <div className="cmd-step bertui-animated bertui-fadeInLeft bertui-fast">
                <div className="cmd-step-number bertui-animated bertui-pulse bertui-infinite bertui-slow">
                  1
                </div>
                <div className="cmd-step-content">
                  <h4>Open Chat</h4>
                  <p>Press the chat key (usually <code>Enter</code> or <code>T</code>) to open the chat window.</p>
                </div>
              </div>
              
              <div className="cmd-step bertui-animated bertui-fadeInRight bertui-fast bertui-delay-1s">
                <div className="cmd-step-number bertui-animated bertui-pulse bertui-infinite bertui-slow bertui-delay-1s">
                  2
                </div>
                <div className="cmd-step-content">
                  <h4>Type Command</h4>
                  <p>Type <code>/</code> followed by the command name and parameters.</p>
                  <div className="cmd-code-block">
                    <pre><code>/kick PlayerName</code></pre>
                  </div>
                </div>
              </div>
              
              <div className="cmd-step bertui-animated bertui-fadeInLeft bertui-slow">
                <div className="cmd-step-number bertui-animated bertui-pulse bertui-infinite bertui-slow bertui-delay-2s">
                  3
                </div>
                <div className="cmd-step-content">
                  <h4>Execute</h4>
                  <p>Press <code>Enter</code> to execute the command.</p>
                </div>
              </div>
            </div>

            <h3 className="bertui-animated bertui-fadeIn bertui-slow bertui-delay-2s">
              Command Examples
            </h3>
            <div className="cmd-example-grid">
              <div className="cmd-example-card bertui-animated bertui-fadeInUp bertui-slow">
                <h4>Basic Usage</h4>
                <div className="cmd-code-block">
                  <pre><code>/kick JohnDoe</code></pre>
                </div>
                <p>Kicks player "JohnDoe" from the server</p>
              </div>
              
              <div className="cmd-example-card bertui-animated bertui-fadeInUp bertui-slow bertui-delay-1s">
                <h4>Using Player ID</h4>
                <div className="cmd-code-block">
                  <pre><code>/ban 12345</code></pre>
                </div>
                <p>Bans player with ID "12345"</p>
              </div>
              
              <div className="cmd-example-card bertui-animated bertui-fadeInUp bertui-slow bertui-delay-2s">
                <h4>With Options</h4>
                <div className="cmd-code-block">
                  <pre><code>/notify map Server restarting in 5 minutes!</code></pre>
                </div>
                <p>Sends notification to all players on current map</p>
              </div>
            </div>

            <div className="cmd-note cmd-note-warning bertui-animated bertui-pulse bertui-slow bertui-delay-3s">
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
        <section className="cmd-section bertui-animated bertui-fadeInUp bertui-slower">
          <h2 className="bertui-animated bertui-fadeIn">
            <span className="section-icon bertui-animated bertui-tada bertui-infinite">
              🎯
            </span>
            Next Steps
          </h2>
          
          <div className="cmd-next-steps">
            <div className="cmd-next-step bertui-animated bertui-fadeInLeft">
              <h3>Event System</h3>
              <p>Learn about server lifecycle events and how to extend functionality.</p>
              <Link to="/events" className="cmd-next-link bertui-animated bertui-pulse bertui-infinite bertui-slow">
                Event System →
              </Link>
            </div>
            
            <div className="cmd-next-step bertui-animated bertui-fadeInUp">
              <h3>API Documentation</h3>
              <p>Explore the complete system API for advanced customization.</p>
              <Link to="/api" className="cmd-next-link bertui-animated bertui-pulse bertui-infinite bertui-slow bertui-delay-1s">
                API Documentation →
              </Link>
            </div>
            
            <div className="cmd-next-step bertui-animated bertui-fadeInRight">
              <h3>Getting Started</h3>
              <p>If you're new to Frostfire Forge, start with the setup guide.</p>
              <Link to="/getting-started" className="cmd-next-link bertui-animated bertui-pulse bertui-infinite bertui-slow bertui-delay-2s">
                Getting Started →
              </Link>
            </div>
          </div>
        </section>
      </div>

      {/* Navigation */}
      <div className="cmd-navigation">
        <Link to="/environment" className="cmd-nav-link cmd-nav-prev bertui-animated bertui-fadeInLeft">
          ← Environment Variables
        </Link>
        <Link to="/events" className="cmd-nav-link cmd-nav-next bertui-animated bertui-fadeInRight">
          Event System →
        </Link>
      </div>
    </div>
  );
}