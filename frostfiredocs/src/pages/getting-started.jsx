// src/pages/getting-started.jsx
import { Link } from 'bertui/router';
import '../styles/getting-started.css';

export default function GettingStarted() {
  return (
    <div className="gs-container">
      <header className="gs-header">
        <div className="gs-logo-container">
          <img 
            src="../images/engine-logo-transparent.png" 
            alt="Frostfire Forge Logo" 
            className="gs-logo"
          />
        </div>
        <h1>Getting Started with Frostfire Forge</h1>
        <p className="gs-subtitle">Complete guide to set up and run your 2D MMO game server</p>
        
        <div className="gs-status-badges">
          <span className="gs-badge gs-badge-warning">🚧 Work in Progress</span>
          <span className="gs-badge gs-badge-success">✓ Production Ready</span>
          <span className="gs-badge gs-badge-info">v1.0.0</span>
        </div>
      </header>

      <div className="gs-content">
        {/* Quick Links */}
        <div className="gs-quick-links">
          <a href="#requirements" className="gs-quick-link">🔧 Requirements</a>
          <a href="#quick-start" className="gs-quick-link">🚀 Quick Start</a>
          <a href="#environment" className="gs-quick-link">⚙️ Environment</a>
          <a href="#docker" className="gs-quick-link">🐳 Docker</a>
          <a href="#commands" className="gs-quick-link">📜 Commands</a>
        </div>

        {/* Requirements Section */}
        <section id="requirements" className="gs-section">
          <h2>
            <span className="gs-section-icon">🔧</span>
            Requirements
          </h2>
          
          <div className="gs-note gs-note-important">
            <h3>Required Software</h3>
            <ul className="gs-requirements-list">
              <li>
                <strong>Bun</strong> - JavaScript runtime & package manager
                <a href="https://bun.sh/" target="_blank" rel="noopener noreferrer" className="gs-external-link">
                  Download ↗
                </a>
              </li>
              <li>
                <strong>MySQL</strong> - Database (or SQLite for development)
                <a href="https://www.mysql.com/downloads/" target="_blank" rel="noopener noreferrer" className="gs-external-link">
                  Download ↗
                </a>
              </li>
              <li>
                <strong>Docker</strong> (Optional) - For containerized deployment
                <a href="https://www.docker.com/" target="_blank" rel="noopener noreferrer" className="gs-external-link">
                  Download ↗
                </a>
              </li>
            </ul>
          </div>

          <div className="gs-note">
            <h4>System Requirements</h4>
            <ul className="gs-requirements-list">
              <li>Node.js 18+ or Bun runtime</li>
              <li>MySQL 8.0+ or SQLite 3</li>
              <li>1GB+ RAM (2GB+ recommended for production)</li>
              <li>100MB+ disk space</li>
              <li>Modern web browser for admin panel</li>
            </ul>
          </div>
        </section>

        {/* Quick Start Section */}
        <section id="quick-start" className="gs-section">
          <h2>
            <span className="gs-section-icon">🚀</span>
            Quick Start
          </h2>
          
          <div className="gs-install-methods">
            <div className="gs-method-tabs">
              <button className="gs-method-tab active" data-method="development">Development</button>
              <button className="gs-method-tab" data-method="production">Production</button>
              <button className="gs-method-tab" data-method="docker">Docker</button>
            </div>

            {/* Development Method */}
            <div className="gs-method-content active" id="development-method">
              <div className="gs-steps">
                <div className="gs-step">
                  <div className="gs-step-number">1</div>
                  <div className="gs-step-content">
                    <h3>Clone the Repository</h3>
                    <div className="gs-code-block">
                      <pre><code>git clone https://github.com/Lillious-Networks/Frostfire-Forge.git</code></pre>
                    </div>
                    <div className="gs-code-block">
                      <pre><code>cd Frostfire-Forge</code></pre>
                    </div>
                  </div>
                </div>

                <div className="gs-step">
                  <div className="gs-step-number">2</div>
                  <div className="gs-step-content">
                    <h3>Update Environment Configuration</h3>
                    <p>Configure your development environment variables in <code>.env.development</code></p>
                    <div className="gs-code-block">
                      <pre><code>cp .env.example .env.development</code></pre>
                    </div>
                    <div className="gs-code-block">
                      <pre><code># Edit .env.development with your settings</code></pre>
                    </div>
                  </div>
                </div>

                <div className="gs-step">
                  <div className="gs-step-number">3</div>
                  <div className="gs-step-content">
                    <h3>Run Setup Script</h3>
                    <div className="gs-code-block">
                      <pre><code>bun setup-development</code></pre>
                    </div>
                    <p>This will install dependencies and set up the database.</p>
                  </div>
                </div>

                <div className="gs-step">
                  <div className="gs-step-number">4</div>
                  <div className="gs-step-content">
                    <h3>Start Development Server</h3>
                    <div className="gs-code-block">
                      <pre><code>bun development</code></pre>
                    </div>
                    <p>Server will start on <code>http://localhost:3000</code></p>
                  </div>
                </div>

                <div className="gs-step">
                  <div className="gs-step-number">5</div>
                  <div className="gs-step-content">
                    <h3>Login with Default Credentials</h3>
                    <div className="gs-credentials">
                      <div className="gs-credential-item">
                        <strong>Username:</strong> <code>demo_user</code>
                      </div>
                      <div className="gs-credential-item">
                        <strong>Password:</strong> <code>Changeme123!</code>
                      </div>
                    </div>
                    <div className="gs-note gs-note-warning">
                      <strong>Important:</strong> Change the default password immediately!
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Production Method */}
            <div className="gs-method-content" id="production-method">
              <div className="gs-steps">
                <div className="gs-step">
                  <div className="gs-step-number">1</div>
                  <div className="gs-step-content">
                    <h3>Run Production Setup</h3>
                    <div className="gs-code-block">
                      <pre><code>bun setup-production</code></pre>
                    </div>
                  </div>
                </div>

                <div className="gs-step">
                  <div className="gs-step-number">2</div>
                  <div className="gs-step-content">
                    <h3>Update Production Environment</h3>
                    <p>Configure your production settings in <code>.env.production</code></p>
                    <div className="gs-code-block">
                      <pre><code>cp .env.example .env.production</code></pre>
                    </div>
                  </div>
                </div>

                <div className="gs-step">
                  <div className="gs-step-number">3</div>
                  <div className="gs-step-content">
                    <h3>Start Production Server</h3>
                    <div className="gs-code-block">
                      <pre><code>bun production</code></pre>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Docker Method */}
            <div className="gs-method-content" id="docker-method">
              <div className="gs-note">
                <h3>Docker Deployment</h3>
                <p>For containerized deployment using Docker and Docker Compose.</p>
              </div>

              <h4>Pull Pre-built Image</h4>
              <div className="gs-code-block">
                <pre><code>docker pull ghcr.io/lillious-networks/frostfire-forge-local:latest</code></pre>
              </div>
              
              <div className="gs-code-block">
                <pre><code>docker run -p 80:80 -p 3000:3000 --name frostfire-forge-local ghcr.io/lillious-networks/frostfire-forge-local:latest</code></pre>
              </div>

              <h4>Development with Docker</h4>
              <div className="gs-code-grid">
                <div className="gs-code-item">
                  <h5>Start Development</h5>
                  <div className="gs-code-block">
                    <pre><code>bun run docker:dev</code></pre>
                  </div>
                </div>
                <div className="gs-code-item">
                  <h5>View Logs</h5>
                  <div className="gs-code-block">
                    <pre><code>bun run docker:dev:logs</code></pre>
                  </div>
                </div>
                <div className="gs-code-item">
                  <h5>Stop Container</h5>
                  <div className="gs-code-block">
                    <pre><code>bun run docker:dev:down</code></pre>
                  </div>
                </div>
                <div className="gs-code-item">
                  <h5>Rebuild</h5>
                  <div className="gs-code-block">
                    <pre><code>bun run docker:dev:build</code></pre>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Environment Variables */}
        <section id="environment" className="gs-section">
          <h2>
            <span className="gs-section-icon">⚙️</span>
            Environment Variables
          </h2>
          
          <div className="gs-note gs-note-important">
            <h3>Required Variables</h3>
            <p>The following environment variables are required for production deployment:</p>
          </div>

          <div className="gs-env-variables">
            <div className="gs-env-group">
              <h4>Database Configuration</h4>
              <div className="gs-env-item">
                <code>DATABASE_ENGINE</code>
                <span>"mysql" | "sqlite"</span>
              </div>
              <div className="gs-env-item">
                <code>DATABASE_HOST</code>
                <span>Database server hostname</span>
              </div>
              <div className="gs-env-item">
                <code>DATABASE_NAME</code>
                <span>Database name</span>
              </div>
              <div className="gs-env-item">
                <code>DATABASE_PASSWORD</code>
                <span>Database password</span>
              </div>
            </div>

            <div className="gs-env-group">
              <h4>Server Configuration</h4>
              <div className="gs-env-item">
                <code>WEBSRV_PORT</code>
                <span>HTTP port (default: "80")</span>
              </div>
              <div className="gs-env-item">
                <code>WEBSRV_PORTSSL</code>
                <span>HTTPS port (default: "443")</span>
              </div>
              <div className="gs-env-item">
                <code>WEB_SOCKET_PORT</code>
                <span>WebSocket port (default: "3000")</span>
              </div>
            </div>

            <div className="gs-env-group">
              <h4>Caching</h4>
              <div className="gs-env-item">
                <code>CACHE</code>
                <span>"redis" | "memory"</span>
              </div>
              <div className="gs-env-item">
                <code>REDIS_URL</code>
                <span>Required if CACHE=redis</span>
              </div>
            </div>
          </div>

          <div className="gs-note">
            <h4>Example .env File</h4>
            <div className="gs-code-block">
              <pre><code>{`DATABASE_ENGINE="mysql"
DATABASE_HOST="localhost"
DATABASE_NAME="frostfire"
DATABASE_USER="root"
DATABASE_PASSWORD="your_password"
DATABASE_PORT="3306"

WEBSRV_PORT="80"
WEBSRV_USESSL="true"
SESSION_KEY="your_secret_key"

CACHE="redis"
REDIS_URL="redis://default@localhost:6379"`}</code></pre>
            </div>
          </div>
        </section>

        {/* Commands Reference */}
        <section id="commands" className="gs-section">
          <h2>
            <span className="gs-section-icon">📜</span>
            Commands Reference
          </h2>

          <div className="gs-commands">
            <h3>Admin Commands</h3>
            <div className="gs-command-grid">
              <div className="gs-command-card">
                <h4>/kick</h4>
                <div className="gs-command-code">
                  <code>/kick [username | id]</code>
                </div>
                <p className="gs-command-desc">Disconnect a player from the server</p>
                <div className="gs-command-meta">
                  <span className="gs-command-alias">Aliases: disconnect</span>
                  <span className="gs-command-perm">Permission: admin.kick</span>
                </div>
              </div>

              <div className="gs-command-card">
                <h4>/ban</h4>
                <div className="gs-command-code">
                  <code>/ban [username | id]</code>
                </div>
                <p className="gs-command-desc">Ban a player from the server</p>
                <div className="gs-command-meta">
                  <span className="gs-command-perm">Permission: admin.ban</span>
                </div>
              </div>

              <div className="gs-command-card">
                <h4>/warp</h4>
                <div className="gs-command-code">
                  <code>/warp [map]</code>
                </div>
                <p className="gs-command-desc">Teleport to a specific map</p>
                <div className="gs-command-meta">
                  <span className="gs-command-perm">Permission: admin.warp</span>
                </div>
              </div>

              <div className="gs-command-card">
                <h4>/shutdown</h4>
                <div className="gs-command-code">
                  <code>/shutdown</code>
                </div>
                <p className="gs-command-desc">Shutdown the server</p>
                <div className="gs-command-meta">
                  <span className="gs-command-perm">Permission: server.shutdown</span>
                </div>
              </div>
            </div>

            <h3>Player Commands</h3>
            <div className="gs-command-grid">
              <div className="gs-command-card">
                <h4>/whisper</h4>
                <div className="gs-command-code">
                  <code>/whisper [username] [message]</code>
                </div>
                <p className="gs-command-desc">Send a private message to another player</p>
                <div className="gs-command-meta">
                  <span className="gs-command-alias">Aliases: w</span>
                </div>
              </div>

              <div className="gs-command-card">
                <h4>/party</h4>
                <div className="gs-command-code">
                  <code>/party [message]</code>
                </div>
                <p className="gs-command-desc">Send message to party members</p>
                <div className="gs-command-meta">
                  <span className="gs-command-alias">Aliases: p</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Next Steps */}
        <section className="gs-section">
          <h2>
            <span className="gs-section-icon">🎯</span>
            Next Steps
          </h2>
          
          <div className="gs-next-steps">
            <div className="gs-next-step">
              <h3>📚 API Documentation</h3>
              <p>Explore the complete system API reference including player management, combat systems, world mechanics, and more.</p>
              <Link to="/api" className="gs-next-step-link">
                View API Docs →
              </Link>
            </div>
            
            <div className="gs-next-step">
              <h3>⚡ Event System</h3>
              <p>Learn about server lifecycle events, hooks, and how to extend functionality with custom listeners.</p>
              <Link to="/events" className="gs-next-step-link">
                Explore Events →
              </Link>
            </div>
            
            <div className="gs-next-step">
              <h3>🐳 Docker Deployment</h3>
              <p>Detailed guide for containerized deployment in production environments.</p>
              <Link to="/docker" className="gs-next-step-link">
                Docker Guide →
              </Link>
            </div>
          </div>
        </section>
      </div>

      {/* Navigation */}
      <div className="gs-navigation">
        <Link to="/" className="gs-nav-link gs-nav-prev">
          ← Back to Home
        </Link>
        <Link to="/api" className="gs-nav-link gs-nav-next">
          API Reference →
        </Link>
      </div>
    </div>
  );
}