// src/pages/docker.jsx
import { Link } from 'bertui/router';
import '../styles/docker.css';

export default function Docker() {
  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
  };

  return (
    <div className="docker-container">
      <header className="docker-header bertui-animated bertui-fadeInDown">
        <h1 className="bertui-animated bertui-fadeIn">
          <span className="docker-icon bertui-animated bertui-tada bertui-delay-1s">
            🐳
          </span>
          Docker Deployment Guide
        </h1>
        <p className="docker-subtitle bertui-animated bertui-fadeIn bertui-delay-2s">
          Complete guide for containerized deployment of Frostfire Forge
        </p>
        
        <div className="docker-badges">
          <span className="docker-badge docker-badge-success bertui-animated bertui-pulse bertui-infinite bertui-slow">
            ✓ Production Ready
          </span>
          <span className="docker-badge docker-badge-info bertui-animated bertui-pulse bertui-infinite bertui-slow bertui-delay-1s">
            Multi-stage Build
          </span>
          <span className="docker-badge docker-badge-warning bertui-animated bertui-pulse bertui-infinite bertui-slow bertui-delay-2s">
            Hot-reload Support
          </span>
        </div>
      </header>

      <div className="docker-content">
        {/* Quick Navigation */}
        <div className="docker-quick-nav bertui-animated bertui-fadeInUp">
          <a href="#prerequisites" className="docker-quick-link bertui-animated bertui-fadeInLeft">
            🔧 Prerequisites
          </a>
          <a href="#quick-start" className="docker-quick-link bertui-animated bertui-fadeInLeft bertui-delay-1s">
            🚀 Quick Start
          </a>
          <a href="#development" className="docker-quick-link bertui-animated bertui-fadeInLeft bertui-delay-2s">
            💻 Development
          </a>
          <a href="#production" className="docker-quick-link bertui-animated bertui-fadeInLeft bertui-delay-3s">
            🚀 Production
          </a>
          <a href="#configuration" className="docker-quick-link bertui-animated bertui-fadeInLeft bertui-delay-4s">
            ⚙️ Configuration
          </a>
        </div>

        {/* Overview */}
        <section className="docker-section docker-overview bertui-animated bertui-fadeInUp bertui-delay-1s">
          <h2 className="bertui-animated bertui-fadeIn">
            Overview
          </h2>
          <p className="bertui-animated bertui-fadeIn bertui-delay-2s">
            Frostfire Forge provides comprehensive Docker support for both development and production environments. 
            The Docker setup includes multi-stage builds, hot-reload support for development, and optimized production images.
          </p>
          
          <div className="docker-features-grid">
            <div className="docker-feature bertui-animated bertui-fadeInUp bertui-delay-3s">
              <div className="docker-feature-icon bertui-animated bertui-pulse bertui-infinite bertui-slow">
                🔧
              </div>
              <h3>Development</h3>
              <p>Source code mounted as volume for hot-reload during development</p>
            </div>
            <div className="docker-feature bertui-animated bertui-fadeInUp bertui-delay-4s">
              <div className="docker-feature-icon bertui-animated bertui-pulse bertui-infinite bertui-slow bertui-delay-1s">
                🚀
              </div>
              <h3>Production</h3>
              <p>Multi-stage builds with optimized dependencies and minimal image size</p>
            </div>
            <div className="docker-feature bertui-animated bertui-fadeInUp bertui-delay-5s">
              <div className="docker-feature-icon bertui-animated bertui-pulse bertui-infinite bertui-slow bertui-delay-2s">
                🔐
              </div>
              <h3>Environment Files</h3>
              <p>Automatic loading of .env files (.env.production, .env.development, .env.local)</p>
            </div>
            <div className="docker-feature bertui-animated bertui-fadeInUp bertui-fast">
              <div className="docker-feature-icon bertui-animated bertui-pulse bertui-infinite bertui-slow bertui-delay-3s">
                📡
              </div>
              <h3>Ports</h3>
              <p>Ports exposed: 80 (HTTP), 443 (HTTPS), 3000 (Application)</p>
            </div>
          </div>
        </section>

        {/* Prerequisites */}
        <section id="prerequisites" className="docker-section bertui-animated bertui-fadeInUp bertui-delay-2s">
          <h2 className="bertui-animated bertui-fadeIn">
            <span className="section-icon bertui-animated bertui-wobble">
              🔧
            </span>
            Prerequisites
          </h2>
          
          <div className="docker-prereq">
            <h3 className="bertui-animated bertui-fadeIn bertui-delay-3s">
              Required Software
            </h3>
            <div className="docker-prereq-list">
              <div className="docker-prereq-item bertui-animated bertui-fadeInLeft bertui-delay-3s">
                <h4>Docker</h4>
                <p>Docker Engine 20.10+ with Compose support</p>
                <a href="https://docs.docker.com/get-docker/" target="_blank" rel="noopener noreferrer" className="docker-download-link bertui-animated bertui-pulse bertui-infinite bertui-slow">
                  Download Docker ↗
                </a>
              </div>
              <div className="docker-prereq-item bertui-animated bertui-fadeInLeft bertui-delay-4s">
                <h4>Docker Compose</h4>
                <p>Compose V2 for multi-container applications</p>
                <a href="https://docs.docker.com/compose/install/" target="_blank" rel="noopener noreferrer" className="docker-download-link bertui-animated bertui-pulse bertui-infinite bertui-slow bertui-delay-1s">
                  Install Compose ↗
                </a>
              </div>
              <div className="docker-prereq-item bertui-animated bertui-fadeInLeft bertui-delay-5s">
                <h4>Git</h4>
                <p>For cloning the repository</p>
                <a href="https://git-scm.com/downloads" target="_blank" rel="noopener noreferrer" className="docker-download-link bertui-animated bertui-pulse bertui-infinite bertui-slow bertui-delay-2s">
                  Download Git ↗
                </a>
              </div>
            </div>
          </div>
        </section>

        {/* Quick Start with Pre-built Images */}
        <section id="quick-start" className="docker-section bertui-animated bertui-fadeInUp bertui-delay-3s">
          <h2 className="bertui-animated bertui-fadeIn">
            <span className="section-icon bertui-animated bertui-bounce">
              🚀
            </span>
            Quick Start with Pre-built Images
          </h2>
          
          <div className="docker-note docker-note-info bertui-animated bertui-pulse">
            <p>
              ℹ️ The easiest way to get started is using our pre-built Docker images available on GitHub Container Registry.
            </p>
          </div>

          <div className="docker-step bertui-animated bertui-fadeInUp bertui-fast">
            <div className="docker-step-header">
              <span className="docker-step-number bertui-animated bertui-pulse bertui-infinite bertui-slow">1</span>
              <h3>Pull the Latest Image</h3>
            </div>
            <div className="docker-code-block">
              <div className="docker-code-header">
                <span>Terminal</span>
                <button 
                  className="docker-copy-btn bertui-animated bertui-pulse bertui-infinite bertui-slow" 
                  onClick={() => copyToClipboard('docker pull ghcr.io/lillious-networks/frostfire-forge-local:latest')}
                >
                  Copy
                </button>
              </div>
              <pre><code>docker pull ghcr.io/lillious-networks/frostfire-forge-local:latest</code></pre>
            </div>
          </div>

          <div className="docker-step bertui-animated bertui-fadeInUp bertui-fast bertui-delay-1s">
            <div className="docker-step-header">
              <span className="docker-step-number bertui-animated bertui-pulse bertui-infinite bertui-slow bertui-delay-1s">2</span>
              <h3>Run the Container</h3>
            </div>
            <div className="docker-code-block">
              <div className="docker-code-header">
                <span>Terminal</span>
                <button 
                  className="docker-copy-btn bertui-animated bertui-pulse bertui-infinite bertui-slow bertui-delay-1s"
                  onClick={() => copyToClipboard('docker run -p 80:80 -p 3000:3000 --name frostfire-forge-local ghcr.io/lillious-networks/frostfire-forge-local:latest')}
                >
                  Copy
                </button>
              </div>
              <pre><code>{`docker run -p 80:80 -p 3000:3000 \\
  --name frostfire-forge-local \\
  ghcr.io/lillious-networks/frostfire-forge-local:latest`}</code></pre>
            </div>
            <p className="docker-step-desc bertui-animated bertui-fadeIn bertui-fast bertui-delay-2s">
              This will start the container with HTTP on port 80 and the application on port 3000.
            </p>
          </div>

          <div className="docker-step bertui-animated bertui-fadeInUp bertui-slow">
            <div className="docker-step-header">
              <span className="docker-step-number bertui-animated bertui-pulse bertui-infinite bertui-slow bertui-delay-2s">3</span>
              <h3>Access the Application</h3>
            </div>
            <ul className="docker-access-list">
              <li className="bertui-animated bertui-fadeInLeft bertui-slow">
                <strong>Web Interface:</strong> <a href="http://localhost" target="_blank" rel="noopener noreferrer" className="bertui-animated bertui-pulse bertui-infinite bertui-slow">http://localhost</a>
              </li>
              <li className="bertui-animated bertui-fadeInLeft bertui-slow bertui-delay-1s">
                <strong>WebSocket Server:</strong> <code>ws://localhost:3000</code>
              </li>
              <li className="bertui-animated bertui-fadeInLeft bertui-slow bertui-delay-2s">
                <strong>Default Login:</strong> <code>demo_user</code> / <code>Changeme123!</code>
              </li>
            </ul>
          </div>
        </section>

        {/* Development Environment */}
        <section id="development" className="docker-section bertui-animated bertui-fadeInUp bertui-delay-4s">
          <h2 className="bertui-animated bertui-fadeIn">
            <span className="section-icon bertui-animated bertui-flash">
              💻
            </span>
            Development Environment
          </h2>
          
          <div className="docker-note docker-note-warning bertui-animated bertui-pulse">
            <p>
              ⚠️
              <strong>Development Features:</strong> Source code is mounted as a volume for hot-reload functionality.
              Changes to your code will automatically trigger server restarts.
            </p>
          </div>

          <div className="docker-commands">
            <div className="docker-command-card bertui-animated bertui-fadeInUp bertui-fast">
              <h3>Start Development Container</h3>
              <div className="docker-code-block">
                <pre><code>bun run docker:dev</code></pre>
              </div>
              <p>Starts the development container with hot-reload enabled</p>
            </div>

            <div className="docker-command-card bertui-animated bertui-fadeInUp bertui-fast bertui-delay-1s">
              <h3>View Logs</h3>
              <div className="docker-code-block">
                <pre><code>bun run docker:dev:logs</code></pre>
              </div>
              <p>Shows real-time container logs</p>
            </div>

            <div className="docker-command-card bertui-animated bertui-fadeInUp bertui-fast bertui-delay-2s">
              <h3>Stop Container</h3>
              <div className="docker-code-block">
                <pre><code>bun run docker:dev:down</code></pre>
              </div>
              <p>Stops and removes the development container</p>
            </div>

            <div className="docker-command-card bertui-animated bertui-fadeInUp bertui-slow">
              <h3>Rebuild Container</h3>
              <div className="docker-code-block">
                <pre><code>bun run docker:dev:build</code></pre>
              </div>
              <p>Rebuilds the development image with latest changes</p>
            </div>
          </div>

          <h3 className="bertui-animated bertui-fadeIn bertui-slow bertui-delay-1s">
            Manual Docker Compose Commands
          </h3>
          <div className="docker-code-block bertui-animated bertui-fadeIn bertui-slow bertui-delay-2s">
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
        <section id="production" className="docker-section bertui-animated bertui-fadeInUp bertui-delay-5s">
          <h2 className="bertui-animated bertui-fadeIn">
            <span className="section-icon bertui-animated bertui-bounceIn">
              🚀
            </span>
            Production Environment
          </h2>
          
          <div className="docker-note docker-note-success bertui-animated bertui-pulse">
            <p>
              ✅
              <strong>Production Features:</strong> Multi-stage builds with optimized dependencies,
              minimal image size, and production-ready configuration.
            </p>
          </div>

          <div className="docker-commands">
            <div className="docker-command-card bertui-animated bertui-fadeInUp bertui-fast">
              <h3>Start Production Container</h3>
              <div className="docker-code-block">
                <pre><code>bun run docker:prod</code></pre>
              </div>
              <p>Starts the production container with optimized settings</p>
            </div>

            <div className="docker-command-card bertui-animated bertui-fadeInUp bertui-fast bertui-delay-1s">
              <h3>View Production Logs</h3>
              <div className="docker-code-block">
                <pre><code>bun run docker:prod:logs</code></pre>
              </div>
              <p>Shows production container logs</p>
            </div>

            <div className="docker-command-card bertui-animated bertui-fadeInUp bertui-fast bertui-delay-2s">
              <h3>Stop Production Container</h3>
              <div className="docker-code-block">
                <pre><code>bun run docker:prod:down</code></pre>
              </div>
              <p>Stops and removes the production container</p>
            </div>

            <div className="docker-command-card bertui-animated bertui-fadeInUp bertui-slow">
              <h3>Rebuild Production</h3>
              <div className="docker-code-block">
                <pre><code>bun run docker:prod:build</code></pre>
              </div>
              <p>Rebuilds the production image</p>
            </div>
          </div>

          <h3 className="bertui-animated bertui-fadeIn bertui-slow bertui-delay-1s">
            Production Deployment with Docker Compose
          </h3>
          <div className="docker-code-block bertui-animated bertui-fadeIn bertui-slow bertui-delay-2s">
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
        <section id="configuration" className="docker-section bertui-animated bertui-fadeInUp bertui-slower">
          <h2 className="bertui-animated bertui-fadeIn">
            <span className="section-icon bertui-animated bertui-wiggle">
              ⚙️
            </span>
            Configuration
          </h2>

          <h3 className="bertui-animated bertui-fadeIn bertui-fast">
            Environment Variables
          </h3>
          <div className="docker-env-vars">
            <div className="docker-env-var bertui-animated bertui-fadeInLeft bertui-fast">
              <code>CACHE</code>
              <span>"redis" | "memory"</span>
              <p>Cache engine to use (Redis recommended for production)</p>
            </div>
            <div className="docker-env-var bertui-animated bertui-fadeInLeft bertui-fast bertui-delay-1s">
              <code>REDIS_URL</code>
              <span>redis://default@redis:6379</span>
              <p>Redis connection URL (required if CACHE=redis)</p>
            </div>
            <div className="docker-env-var bertui-animated bertui-fadeInLeft bertui-slow">
              <code>REDIS_PASSWORD</code>
              <span>your-redis-password</span>
              <p>Redis password for authentication</p>
            </div>
            <div className="docker-env-var bertui-animated bertui-fadeInRight bertui-slow">
              <code>DATABASE_ENGINE</code>
              <span>"mysql" | "sqlite"</span>
              <p>Database engine to use</p>
            </div>
          </div>

          <h3 className="bertui-animated bertui-fadeIn bertui-slow bertui-delay-1s">
            Volume Mounts
          </h3>
          <div className="docker-volumes">
            <div className="docker-volume bertui-animated bertui-fadeInUp bertui-slow">
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

          <h3 className="bertui-animated bertui-fadeIn bertui-slow bertui-delay-2s">
            Network Configuration
          </h3>
          <div className="docker-network">
            <p className="bertui-animated bertui-fadeIn bertui-slow bertui-delay-3s">
              By default, Docker Compose creates a bridge network for your services to communicate.
            </p>
            <div className="docker-code-block bertui-animated bertui-fadeIn bertui-slow bertui-delay-4s">
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
        <section className="docker-section bertui-animated bertui-fadeInUp bertui-slowest">
          <h2 className="bertui-animated bertui-fadeIn">
            <span className="section-icon bertui-animated bertui-flash bertui-infinite">
              🗄️
            </span>
            Redis Configuration
          </h2>
          
          <div className="docker-note docker-note-important bertui-animated bertui-pulse">
            <p>
              ⚠️
              <strong>Important:</strong> If you set <code>CACHE=redis</code>, you must configure 
              <code>REDIS_URL</code> and <code>REDIS_PASSWORD</code> in your environment file.
            </p>
          </div>

          <div className="docker-redis-config">
            <h3 className="bertui-animated bertui-fadeIn bertui-fast">
              Docker Compose with Redis
            </h3>
            <div className="docker-code-block bertui-animated bertui-fadeIn bertui-fast">
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
        <section className="docker-section bertui-animated bertui-fadeInUp bertui-slow">
          <h2 className="bertui-animated bertui-fadeIn">
            <span className="section-icon bertui-animated bertui-wobble">
              🔧
            </span>
            Troubleshooting
          </h2>

          <div className="docker-troubleshooting">
            <div className="docker-issue bertui-animated bertui-fadeInLeft bertui-fast">
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

            <div className="docker-issue bertui-animated bertui-fadeInRight bertui-fast bertui-delay-1s">
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

            <div className="docker-issue bertui-animated bertui-fadeInLeft bertui-slow">
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
        <section className="docker-section bertui-animated bertui-fadeInUp bertui-slower">
          <h2 className="bertui-animated bertui-fadeIn">
            <span className="section-icon bertui-animated bertui-tada bertui-infinite">
              🎯
            </span>
            Next Steps
          </h2>
          
          <div className="docker-next-steps">
            <div className="docker-next-step bertui-animated bertui-fadeInLeft">
              <h3>Environment Variables</h3>
              <p>Learn about all available configuration options for your deployment.</p>
              <Link to="/environment" className="docker-next-link bertui-animated bertui-pulse bertui-infinite bertui-slow">
                View Environment Variables →
              </Link>
            </div>
            
            <div className="docker-next-step bertui-animated bertui-fadeInUp">
              <h3>Production Deployment</h3>
              <p>Learn about best practices for deploying in production environments.</p>
              <Link to="/getting-started#production" className="docker-next-link bertui-animated bertui-pulse bertui-infinite bertui-slow bertui-delay-1s">
                Production Guide →
              </Link>
            </div>
            
            <div className="docker-next-step bertui-animated bertui-fadeInRight">
              <h3>API Documentation</h3>
              <p>Explore the complete API reference for Frostfire Forge.</p>
              <Link to="/api" className="docker-next-link bertui-animated bertui-pulse bertui-infinite bertui-slow bertui-delay-2s">
                API Documentation →
              </Link>
            </div>
          </div>
        </section>
      </div>

      {/* Navigation */}
      <div className="docker-navigation">
        <Link to="/getting-started" className="docker-nav-link docker-nav-prev bertui-animated bertui-fadeInLeft">
          ← Getting Started
        </Link>
        <Link to="/environment" className="docker-nav-link docker-nav-next bertui-animated bertui-fadeInRight">
          Environment Variables →
        </Link>
      </div>
    </div>
  );
}