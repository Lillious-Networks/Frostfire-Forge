import { Link } from 'bertui/router';
import '../styles/home.css';
import * as icons from "bertui-icons";

export const render = "server";

export const meta = {
  title: "Frostfire Forge - Modern 2D MMO Game Engine",
  description: "High-performance 2D MMO game engine built with Bun, TypeScript, and modern web technologies",
  keywords: "mmo, game engine, 2d, bun, typescript, react, multiplayer"
};

export default function Home() {
  return (
    <div className="ff-home">
      {/* Hero Section */}
      <div className="ff-hero">
        <div className="ff-hero-content">
          <div className="ff-hero-left bertui-animated bertui-fadeInLeft">
            <img 
              src="../images/teaser1.png" 
              alt="Game Teaser" 
              className="ff-hero-image ff-hero-image-left"
            />
          </div>
          
          <div className="ff-hero-center bertui-animated bertui-zoomIn">
            {/* Logo */}
            <img 
              src="../images/engine-logo-transparent.png" 
              alt="Frostfire Forge Logo" 
              className="ff-logo bertui-animated bertui-fadeInDown"
            />
            
            {/* Status Badges */}
            <div className="ff-badges bertui-animated bertui-fadeIn bertui-delay-1s">
              <div className="ff-badge ff-badge-warning bertui-animated bertui-pulse bertui-infinite">
                <icons.Anchor size={16} color="orange" />
                Work in Progress
              </div>
              <div className="ff-badge ff-badge-success">
                <icons.Sparkle size={16} color="green" />
                Production Build
              </div>
              <div className="ff-badge ff-badge-info">
                <icons.Info size={16} color="skyblue" />
                v1.0.0
              </div>
            </div>

            {/* CTA Buttons */}
            <div className="ff-cta-buttons bertui-animated bertui-fadeInUp bertui-delay-1s">
              <Link to="/getting-started" className="ff-btn ff-btn-primary bertui-animated bertui-pulse bertui-infinite">
                <icons.Rocket size={24} />
                Get Started
                <icons.ArrowRight size={24} />
              </Link>
              <a 
                href="https://github.com/Lillious-Networks/Frostfire-Forge" 
                target="_blank" 
                rel="noopener noreferrer"
                className="ff-btn ff-btn-secondary"
              >
                <icons.GitBranch size={24} />
                View on GitHub
              </a>
            </div>
          </div>
          
          <div className="ff-hero-right bertui-animated bertui-fadeInRight">
            <img 
              src="../images/teaser1.png" 
              alt="Game Teaser" 
              className="ff-hero-image ff-hero-image-right"
            />
          </div>
        </div>
      </div>

      {/* Features Grid */}
      <div className="ff-features bertui-animated bertui-fadeInUp">
        <h2 className="ff-section-title">
          <icons.Star size={32} color="orange" className="bertui-animated bertui-tada bertui-infinite bertui-slow" />
          Why Frostfire Forge?
        </h2>
        
        <div className="ff-features-grid">
          <FeatureCard
            Icon={icons.Zap}
            title="High Performance"
            description="Built on Bun runtime for lightning-fast execution and minimal overhead"
            animClass="bertui-animated bertui-fadeInUp bertui-delay-1s"
          />
          <FeatureCard
            Icon={icons.Globe}
            title="Real-time Multiplayer"
            description="WebSocket server with optimized packet handling for seamless gameplay"
            animClass="bertui-animated bertui-fadeInUp bertui-delay-2s"
          />
          <FeatureCard
            Icon={icons.Database}
            title="Flexible Database"
            description="Support for MySQL and SQLite with Redis caching for optimal performance"
            animClass="bertui-animated bertui-fadeInUp bertui-delay-3s"
          />
          <FeatureCard
            Icon={icons.Shield}
            title="Secure by Design"
            description="Built-in authentication, rate limiting, and permission systems"
            animClass="bertui-animated bertui-fadeInUp bertui-delay-4s"
          />
          <FeatureCard
            Icon={icons.Gamepad}
            title="Complete Game Systems"
            description="Player management, combat, quests, guilds, parties, and more"
            animClass="bertui-animated bertui-fadeInUp bertui-delay-5s"
          />
          <FeatureCard
            Icon={icons.Package}
            title="Deployment Ready"
            description="Pre-configured setups for development and production deployment"
            animClass="bertui-animated bertui-fadeInUp bertui-fast"
          />
        </div>
      </div>

      {/* Tech Stack */}
      <div className="ff-tech-stack bertui-animated bertui-fadeIn">
        <h2 className="ff-section-title">
          <icons.Cpu size={32} color="skyblue" />
          Built With Modern Technologies
        </h2>
        <div className="ff-tech-grid">
          <TechBadge name="Bun" Icon={icons.Server} delay="bertui-delay-1s" />
          <TechBadge name="TypeScript" Icon={icons.FileCode} delay="bertui-delay-2s" />
          <TechBadge name="MySQL" Icon={icons.Database} delay="bertui-delay-3s" />
          <TechBadge name="Redis" Icon={icons.HardDrive} delay="bertui-delay-4s" />
          <TechBadge name="WebSockets" Icon={icons.Network} delay="bertui-delay-5s" />
          <TechBadge name="Docker" Icon={icons.Package} delay="bertui-fast" />
          <TechBadge name="React" Icon={icons.Code} delay="bertui-slow" />
          <TechBadge name="OpenAI" Icon={icons.Cloud} delay="bertui-slower" />
        </div>
      </div>

      {/* Quick Links */}
      <div className="ff-quick-links">
        <h2 className="ff-section-title bertui-animated bertui-fadeIn">
          <icons.Book size={32} color="royalblue" />
          Documentation
        </h2>
        <div className="ff-links-grid">
          <QuickLink to="/getting-started" Icon={icons.Rocket} title="Getting Started" description="Quick setup guide" anim="bertui-animated bertui-fadeInLeft" />
          <QuickLink to="/api" Icon={icons.Book} title="API Reference" description="System documentation" anim="bertui-animated bertui-fadeInRight" />
          <QuickLink to="/commands" Icon={icons.Terminal} title="Commands" description="Command reference" anim="bertui-animated bertui-fadeInLeft" />
          <QuickLink to="/events" Icon={icons.Zap} title="Event System" description="Server lifecycle hooks" anim="bertui-animated bertui-fadeInRight" />
          <QuickLink to="/docker" Icon={icons.Package} title="Docker Setup" description="Deployment guide" anim="bertui-animated bertui-fadeInLeft" />
          <QuickLink to="/environment" Icon={icons.Settings} title="Environment" description="Config options" anim="bertui-animated bertui-fadeInRight" />
          <QuickLink to="/functions" Icon={icons.Code} title="System Functions" description="Core API reference" anim="bertui-animated bertui-fadeInUp" />
        </div>
      </div>

      {/* Footer */}
      <footer className="ff-footer bertui-animated bertui-fadeIn">
        <p>
          <icons.Heart size={24} color="red" className="bertui-animated bertui-heartBeat bertui-infinite" />
          Built by the Frostfire Forge Team
        </p>
        <p className="ff-footer-links">
          <a href="https://github.com/Lillious-Networks/Frostfire-Forge" target="_blank" rel="noopener noreferrer">
            <icons.GitBranch size={16} /> GitHub
          </a>
          <span>•</span>
          <a href="https://discord.gg/4spUbuXBvZ" target="_blank" rel="noopener noreferrer">
            <icons.User size={16} /> Discord
          </a>
          <span>•</span>
          <span>
            <icons.Zap size={16} /> Built with <a href="https://bertui-docswebsite.vercel.app/">BertUI</a>
          </span>
          <span>•</span>
          <span>
            <icons.ShieldCheck size={16} /> MIT License
          </span>
        </p>
      </footer>
    </div>
  );
}

function FeatureCard({ Icon, title, description, animClass }) {
  return (
    <div className={`ff-feature-card ${animClass}`}>
      <Icon size={32} className="bertui-animated bertui-pulse bertui-infinite bertui-slow" />
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}

function TechBadge({ name, Icon, delay }) {
  return (
    <div className={`ff-tech-badge bertui-animated bertui-zoomIn ${delay}`}>
      <Icon size={16} />
      {name}
    </div>
  );
}

function QuickLink({ to, Icon, title, description, anim }) {
  return (
    <Link to={to} className={`ff-quick-link ${anim}`}>
      <div className="ff-quick-link-icon">
        <Icon size={32} />
      </div>
      <div className="ff-quick-link-content">
        <h3 className="ff-quick-link-title">{title}</h3>
        <p className="ff-quick-link-desc">{description}</p>
      </div>
      <div className="ff-quick-link-arrow">
        <icons.ChevronRight size={24} />
      </div>
    </Link>
  );
}