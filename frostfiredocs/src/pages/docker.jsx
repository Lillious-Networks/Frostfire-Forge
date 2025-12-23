// src/pages/docker.jsx
import { Link } from 'bertui/router';
import '../styles/docker.css';

export default function Docker() {
  return (
    <div className="docker-container">
      <header className="docker-header">
        <h1>
          <span className="docker-icon">🐳</span>
          Docker Deployment Guide
        </h1>
        <p className="docker-subtitle">
          Complete guide for containerized deployment of Frostfire Forge
        </p>
        
        <div className="docker-badges">
          <span className="docker-badge docker-badge-success">✓ Production Ready</span>
          <span className="docker-badge docker-badge-info">Multi-stage Build</span>
          <span className="docker-badge docker-badge-warning">Hot-reload Support</span>
        </div>
      </header>

      <div className="docker-content">
        {/* Quick Navigation */}
        <div className="docker-quick-nav">
          <a href="#prerequisites" className="docker-quick-link">🔧 Prerequisites</a>
          <a href="#quick-start" className="docker-quick-link">🚀 Quick Start</a>
          <a href="#development" className="docker-quick-link">💻 Development</a>
          <a href="#production" className="docker-quick-link">🚀 Production</a>
          <a href="#configuration" className="docker-quick-link">⚙️ Configuration</a>
        </div>

        {/* Overview */}
        <section className="docker-section docker-overview">
          <h2>Overview</h2>
          <p>
            Frostfire Forge provides comprehensive Docker support for both development and production environments. 
            The Docker setup includes multi-stage builds, hot-reload support for development, and optimized production images.
          </p>
          
          <div className="docker-features-grid">
            <div className="docker-feature">
              <div className="docker-feature-icon">🔧</div>
              <h3>Development</h3>
              <p>Source code mounted as volume for hot-reload during development</p>
            </div>
            <div className="docker-feature">
              <div className="docker-feature-icon">🚀</div>
              <h3>Production</h3>
              <p>Multi-stage builds with optimized dependencies and minimal image size</p>
            </div>
            <div className="docker-feature">
              <div className="docker-feature-icon">🔐</div>
              <h3>Environment Files</h3>
              <p>Automatic loading of .env files (.env.production, .env.development, .env.local)</p>
            </div>
            <div className="docker-feature">
              <div className="docker-feature-icon">📡</div>
              <h3>Ports</h3>
              <p>Ports exposed: 80 (HTTP), 443 (HTTPS), 3000 (Application)</p>
            </div>
          </div>
        </section>

        {/* Prerequisites */}
        <section id="prerequisites" className="docker-section">
          <h2>
            <span className="section-icon">🔧</span>
            Prerequisites
          </h2>
          
          <div className="docker-prereq">
            <h3>Required Software</h3>
            <div className="docker-prereq-list">
              <div className="docker-prereq-item">
                <h4>Docker</h4>
                <p>Docker Engine 20.10+ with Compose support</p>
                <a href="https://docs.docker.com/get-docker/" target="_blank" rel="noopener noreferrer" className="docker-download-link">
                  Download Docker ↗
                </a>
              </div>
              <div className="docker-prereq-item">
                <h4>Docker Compose</h4>
                <p>Compose V2 for multi-container applications</p>
                <a href="https://docs.docker.com/compose/install/" target="_blank" rel="noopener noreferrer" className="docker-download-link">
                  Install Compose ↗
                </a>
              </div>
              <div className="docker-prereq-item">
                <h4>Git</h4>
                <p>For cloning the repository</p>
                <a href="https://git-scm.com/downloads" target="_blank" rel="noopener noreferrer" className="docker-download-link">
                  Download Git ↗
                </a>
              </div>
            </div>
          </div>
        </section>

        {/* Quick Start with Pre-built Images */}
        <section id="quick-start" className="docker-section">
          <h2>
            <span className="section-icon">🚀</span>
            Quick Start with Pre-built Images
          </h2>
          
          <div className="docker-note docker-note-info">
            <p>
              The easiest way to get started is using our pre-built Docker images available on GitHub Container Registry.
            </p>
          </div>

          <div className="docker-step">
            <div className="docker-step-header">
              <span className="docker-step-number">1</span>
              <h3>Pull the Latest Image</h3>
            </div>
            <div className="docker-code-block">
              <div className="docker-code-header">
                <span>Terminal</span>
                <button className="docker-copy-btn" onClick={() => navigator.clipboard.writeText('docker pull ghcr.io/lillious-networks/frostfire-forge-local:latest')}>
                  Copy
                </button>
              </div>
              <pre><code>docker pull ghcr.io/lillious-networks/frostfire-forge-local:latest</code></pre>
            </div>
          </div>

          <div className="docker-step">
            <div className="docker-step-header">
              <span className="docker-step-number">2</span>
              <h3>Run the Container</h3>
            </div>
            <div className="docker-code-block">
              <div className="docker-code-header">
                <span>Terminal</span>
                <button className="docker-copy-btn" onClick={() => navigator.clipboard.writeText('docker run -p 80:80 -p 3000:3000 --name frostfire-forge-local ghcr.io/lillious-networks/frostfire-forge-local:latest')}>
                  Copy
                </button>
              </div>
              <pre><code>{`docker run -p 80:80 -p 3000:3000 \\
  --name frostfire-forge-local \\
  ghcr.io/lillious-networks/frostfire-forge-local:latest`}</code></pre>
            </div>
            <p className="docker-step-desc">
              This will start the container with HTTP on port 80 and the application on port 3000.
            </p>
          </div>

          <div className="docker-step">
            <div className="docker-step-header">
              <span className="docker-step-number">3</span>
              <h3>Access the Application</h3>
            </div>
            <ul className="docker-access-list">
              <li>
                <strong>Web Interface:</strong> <a href="http://localhost" target="_blank" rel="noopener noreferrer">http://localhost</a>
              </li>
              <li>
                <strong>WebSocket Server:</strong> <code>ws://localhost:3000</code>
              </li>
              <li>
                <strong>Default Login:</strong> <code>demo_user</code> / <code>Changeme123!</code>
              </li>
            </ul>
          </div>
        </section>

        {/* Development Environment */}
        <section id="development" className="docker-section">
          <h2>
            <span className="section-icon">💻</span>
            Development Environment
          </h2>
          
          <div className="docker-note docker-note-warning">
            <p>
              <strong>Development Features:</strong> Source code is mounted as a volume for hot-reload functionality.
              Changes to your code will automatically trigger server restarts.
            </p>
          </div>

          <div className="docker-commands">
            <div className="docker-command-card">
              <h3>Start Development Container</h3>
              <div className="docker-code-block">
                <pre><code>bun run docker:dev</code></pre>
              </div>
              <p>Starts the development container with hot-reload enabled</p>
            </div>

            <div className="docker-command-card">
              <h3>View Logs</h3>
              <div className="docker-code-block">
                <pre><code>bun run docker:dev:logs</code></pre>
              </div>
              <p>Shows real-time container logs</p>
            </div>

            <div className="docker-command-card">
              <h3>Stop Container</h3>
              <div className="docker-code-block">
                <pre><code>bun run docker:dev:down</code></pre>
              </div>
              <p>Stops and removes the development container</p>
            </div>

            <div className="docker-command-card">
              <h3>Rebuild Container</h3>
              <div className="docker-code-block">
                <pre><code>bun run docker:dev:build</code></pre>
              </div>
              <p>Rebuilds the development image with latest changes</p>
            </div>
          </div>

          <h3>Manual Docker Compose Commands</h3>
          <div className="docker-code-block">
            <div className="docker-code-header">
              <span>Start Development</span>
            </div>
            <pre><code>{`# Start development services
docker-compose -f docker-compose.dev.yml up

# Start in detached mode (background)
docker-compose -f docker-compose.dev.yml up -d

# View logs
docker-compose -f docker-compose.dev.yml logs -f

# Stop services
docker-compose -f docker-compose.dev.yml down

# Rebuild images
docker-compose -f docker-compose.dev.yml build`}</code></pre>
          </div>
        </section>

        {/* Production Environment */}
        <section id="production" className="docker-section">
          <h2>
            <span className="section-icon">🚀</span>
            Production Environment
          </h2>
          
          <div className="docker-note docker-note-success">
            <p>
              <strong>Production Features:</strong> Multi-stage builds with optimized dependencies,
              minimal image size, and production-ready configuration.
            </p>
          </div>

          <div className="docker-commands">
            <div className="docker-command-card">
              <h3>Start Production Container</h3>
              <div className="docker-code-block">
                <pre><code>bun run docker:prod</code></pre>
              </div>
              <p>Starts the production container with optimized settings</p>
            </div>

            <div className="docker-command-card">
              <h3>View Production Logs</h3>
              <div className="docker-code-block">
                <pre><code>bun run docker:prod:logs</code></pre>
              </div>
              <p>Shows production container logs</p>
            </div>

            <div className="docker-command-card">
              <h3>Stop Production Container</h3>
              <div className="docker-code-block">
                <pre><code>bun run docker:prod:down</code></pre>
              </div>
              <p>Stops and removes the production container</p>
            </div>

            <div className="docker-command-card">
              <h3>Rebuild Production</h3>
              <div className="docker-code-block">
                <pre><code>bun run docker:prod:build</code></pre>
              </div>
              <p>Rebuilds the production image</p>
            </div>
          </div>

          <h3>Production Deployment with Docker Compose</h3>
          <div className="docker-code-block">
            <div className="docker-code-header">
              <span>docker-compose.prod.yml</span>
            </div>
            <pre><code>{`version: '3.8'
services:
  frostfire-forge:
    image: ghcr.io/lillious-networks/frostfire-forge:latest
    container_name: frostfire-forge-prod
    ports:
      - "80:80"
      - "443:443"
      - "3000:3000"
    environment:
      - NODE_ENV=production
    volumes:
      - ./data:/app/data
      - ./logs:/app/logs
    restart: unless-stopped
    networks:
      - frostfire-network

  redis:
    image: redis:7-alpine
    container_name: frostfire-redis
    command: redis-server --requirepass \${REDIS_PASSWORD}
    volumes:
      - redis-data:/data
    restart: unless-stopped
    networks:
      - frostfire-network

volumes:
  redis-data:

networks:
  frostfire-network:
    driver: bridge`}</code></pre>
          </div>
        </section>

        {/* Configuration */}
        <section id="configuration" className="docker-section">
          <h2>
            <span className="section-icon">⚙️</span>
            Configuration
          </h2>

          <h3>Environment Variables</h3>
          <div className="docker-env-vars">
            <div className="docker-env-var">
              <code>CACHE</code>
              <span>"redis" | "memory"</span>
              <p>Cache engine to use (Redis recommended for production)</p>
            </div>
            <div className="docker-env-var">
              <code>REDIS_URL</code>
              <span>redis://default@redis:6379</span>
              <p>Redis connection URL (required if CACHE=redis)</p>
            </div>
            <div className="docker-env-var">
              <code>REDIS_PASSWORD</code>
              <span>your-redis-password</span>
              <p>Redis password for authentication</p>
            </div>
            <div className="docker-env-var">
              <code>DATABASE_ENGINE</code>
              <span>"mysql" | "sqlite"</span>
              <p>Database engine to use</p>
            </div>
          </div>

          <h3>Volume Mounts</h3>
          <div className="docker-volumes">
            <div className="docker-volume">
              <h4>Data Persistence</h4>
              <div className="docker-code-block">
                <pre><code>{`# Mount data directory
volumes:
  - ./data:/app/data

# Mount logs directory
volumes:
  - ./logs:/app/logs

# Mount configuration
volumes:
  - ./config:/app/config`}</code></pre>
              </div>
            </div>
          </div>

          <h3>Network Configuration</h3>
          <div className="docker-network">
            <p>By default, Docker Compose creates a bridge network for your services to communicate.</p>
            <div className="docker-code-block">
              <pre><code>{`# Custom network configuration
networks:
  frostfire-network:
    driver: bridge
    ipam:
      config:
        - subnet: 172.20.0.0/16`}</code></pre>
            </div>
          </div>
        </section>

        {/* Redis Configuration */}
        <section className="docker-section">
          <h2>
            <span className="section-icon">🗄️</span>
            Redis Configuration
          </h2>
          
          <div className="docker-note docker-note-important">
            <p>
              <strong>Important:</strong> If you set <code>CACHE=redis</code>, you must configure 
              <code>REDIS_URL</code> and <code>REDIS_PASSWORD</code> in your environment file.
            </p>
          </div>

          <div className="docker-redis-config">
            <h3>Docker Compose with Redis</h3>
            <div className="docker-code-block">
              <div className="docker-code-header">
                <span>docker-compose.yml with Redis</span>
              </div>
              <pre><code>{`version: '3.8'
services:
  app:
    image: frostfire-forge:latest
    environment:
      - CACHE=redis
      - REDIS_URL=redis://default:yourpassword@redis:6379
      - REDIS_PASSWORD=yourpassword
    depends_on:
      - redis
    ports:
      - "80:80"
      - "3000:3000"

  redis:
    image: redis:7-alpine
    command: redis-server --requirepass yourpassword
    volumes:
      - redis-data:/data
    ports:
      - "6379:6379"

volumes:
  redis-data:`}</code></pre>
            </div>
          </div>
        </section>

        {/* Troubleshooting */}
        <section className="docker-section">
          <h2>
            <span className="section-icon">🔧</span>
            Troubleshooting
          </h2>

          <div className="docker-troubleshooting">
            <div className="docker-issue">
              <h3>Container fails to start</h3>
              <p><strong>Solution:</strong> Check if ports 80, 443, or 3000 are already in use on your host machine.</p>
              <div className="docker-code-block">
                <pre><code>{`# Check for processes using ports
sudo lsof -i :80
sudo lsof -i :3000

# Or change the port mapping
docker run -p 8080:80 -p 3001:3000 ...`}</code></pre>
              </div>
            </div>

            <div className="docker-issue">
              <h3>Redis connection errors</h3>
              <p><strong>Solution:</strong> Ensure Redis container is running and credentials are correct.</p>
              <div className="docker-code-block">
                <pre><code>{`# Check Redis container status
docker ps | grep redis

# Test Redis connection
docker exec -it frostfire-redis redis-cli
AUTH yourpassword
PING`}</code></pre>
              </div>
            </div>

            <div className="docker-issue">
              <h3>Permission denied on volume mounts</h3>
              <p><strong>Solution:</strong> Ensure the host directories have proper permissions for the container user.</p>
              <div className="docker-code-block">
                <pre><code>{`# Set proper permissions
sudo chown -R 1000:1000 ./data ./logs

# Or use named volumes instead
volumes:
  - app-data:/app/data`}</code></pre>
              </div>
            </div>
          </div>
        </section>

        {/* Next Steps */}
        <section className="docker-section">
          <h2>
            <span className="section-icon">🎯</span>
            Next Steps
          </h2>
          
          <div className="docker-next-steps">
            <div className="docker-next-step">
              <h3>Environment Variables</h3>
              <p>Learn about all available configuration options for your deployment.</p>
              <Link to="/environment" className="docker-next-link">
                View Environment Variables →
              </Link>
            </div>
            
            <div className="docker-next-step">
              <h3>Production Deployment</h3>
              <p>Learn about best practices for deploying in production environments.</p>
              <Link to="/getting-started#production" className="docker-next-link">
                Production Guide →
              </Link>
            </div>
            
            <div className="docker-next-step">
              <h3>API Documentation</h3>
              <p>Explore the complete API reference for Frostfire Forge.</p>
              <Link to="/api" className="docker-next-link">
                API Documentation →
              </Link>
            </div>
          </div>
        </section>
      </div>

      {/* Navigation */}
      <div className="docker-navigation">
        <Link to="/getting-started" className="docker-nav-link docker-nav-prev">
          ← Getting Started
        </Link>
        <Link to="/environment" className="docker-nav-link docker-nav-next">
          Environment Variables →
        </Link>
      </div>
    </div>
  );
}