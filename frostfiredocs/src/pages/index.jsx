// src/pages/index.jsx
import { Link } from 'bertui/router';
import '../styles/home.css';

export default function Home() {
  return (
    <div className="ff-home">
      {/* Hero Section */}
      <div className="ff-hero">
        <div className="ff-hero-content">
          <div className="ff-hero-left">
            <img 
              src="../images/teaser1.png" 
              alt="Game Teaser" 
              className="ff-hero-image ff-hero-image-left"
            />
          </div>
          
          <div className="ff-hero-center">
            
            {/* Logo between title and badges */}
            <img 
              src="../images/engine-logo-transparent.png" 
              alt="Frostfire Forge Logo" 
              className="ff-logo"
            />
            
            {/* Status Badges */}
            <div className="ff-badges">
              <span className="ff-badge ff-badge-warning">🚧 Work in Progress</span>
              <span className="ff-badge ff-badge-success">✓ Production Build</span>
              <span className="ff-badge ff-badge-info">v1.0.0</span>
            </div>

            {/* CTA Buttons */}
            <div className="ff-cta-buttons">
              <Link to="/getting-started" className="ff-btn ff-btn-primary">
                Get Started →
              </Link>
              <a 
                href="https://github.com/Lillious-Networks/Frostfire-Forge" 
                target="_blank" 
                rel="noopener noreferrer"
                className="ff-btn ff-btn-secondary"
              >
                View on GitHub
              </a>
            </div>
          </div>
          
          <div className="ff-hero-right">
            <img 
              src="../images/teaser1.png" 
              alt="Game Teaser" 
              className="ff-hero-image ff-hero-image-right"
            />
          </div>
        </div>
      </div>

      {/* Rest of your components remain the same */}
      {/* Features Grid */}
      <div className="ff-features">
        <h2 className="ff-section-title">Why Frostfire Forge?</h2>
        
        <div className="ff-features-grid">
          <FeatureCard
            icon="⚡"
            title="High Performance"
            description="Built on Bun runtime for lightning-fast execution and minimal overhead"
          />
          <FeatureCard
            icon="🌐"
            title="Real-time Multiplayer"
            description="WebSocket server with optimized packet handling for seamless gameplay"
          />
          <FeatureCard
            icon="💾"
            title="Flexible Database"
            description="Support for MySQL and SQLite with Redis caching for optimal performance"
          />
          <FeatureCard
            icon="🔒"
            title="Secure by Design"
            description="Built-in authentication, rate limiting, and permission systems"
          />
          <FeatureCard
            icon="🎮"
            title="Complete Game Systems"
            description="Player management, combat, quests, guilds, parties, and more"
          />
          <FeatureCard
            icon="🐳"
            title="Docker Ready"
            description="Pre-configured containers for development and production deployment"
          />
        </div>
      </div>

      {/* Tech Stack */}
      <div className="ff-tech-stack">
        <h2 className="ff-section-title">Built With Modern Technologies</h2>
        <div className="ff-tech-grid">
          <TechBadge name="Bun" />
          <TechBadge name="TypeScript" />
          <TechBadge name="MySQL" />
          <TechBadge name="Redis" />
          <TechBadge name="WebSockets" />
          <TechBadge name="Docker" />
          <TechBadge name="React" />
          <TechBadge name="OpenAI" />
        </div>
      </div>

      {/* Quick Links */}
      <div className="ff-quick-links">
        <h2 className="ff-section-title">Documentation</h2>
        <div className="ff-links-grid">
          <QuickLink
            to="/getting-started"
            icon="🚀"
            title="Getting Started"
            description="Quick setup guide for development and production"
          />
          <QuickLink
            to="/api"
            icon="📚"
            title="API Reference"
            description="Complete system API documentation"
          />
          <QuickLink
            to="/commands"
            icon="⌨️"
            title="Commands"
            description="Admin and player command reference"
          />
          <QuickLink
            to="/events"
            icon="⚡"
            title="Event System"
            description="Server lifecycle and event hooks"
          />
          <QuickLink
            to="/docker"
            icon="🐳"
            title="Docker Setup"
            description="Container deployment guide"
          />
          <QuickLink
            to="/environment"
            icon="⚙️"
            title="Environment Variables"
            description="Configuration options"
          />
          <QuickLink
            to="/functions"
            icon="X"
            title="Types of functions"
            description="Functions "
          />
        </div>
      </div>

      {/* Footer */}
      <footer className="ff-footer">
        <p>Built with ❤️ by the Frostfire Forge Team</p>
        <p className="ff-footer-links">
          <a href="https://github.com/Lillious-Networks/Frostfire-Forge" target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
          <span>•</span>
          <a href="https://discord.gg/4spUbuXBvZ" target="_blank" rel="noopener noreferrer">
            Discord
          </a>
          <p>
            Built for speed using <a href="https://bertui-docswebsite.vercel.app/" target="_blank" rel="noopener        noreferrer">BertUI</a>, the world's fastest ui Library.
          </p>
          

          <span>•</span>
          <span>MIT License</span>
        </p>
      </footer>
    </div>
  );
}

// Helper Components remain the same
function FeatureCard({ icon, title, description }) {
  return (
    <div className="ff-feature-card">
      <div className="ff-feature-icon">{icon}</div>
      <h3 className="ff-feature-title">{title}</h3>
      <p className="ff-feature-desc">{description}</p>
    </div>
  );
}

function TechBadge({ name }) {
  return <div className="ff-tech-badge">{name}</div>;
}

function QuickLink({ to, icon, title, description }) {
  return (
    <Link to={to} className="ff-quick-link">
      <div className="ff-quick-link-icon">{icon}</div>
      <div className="ff-quick-link-content">
        <h3 className="ff-quick-link-title">{title}</h3>
        <p className="ff-quick-link-desc">{description}</p>
      </div>
      <div className="ff-quick-link-arrow">→</div>
    </Link>
  );
}