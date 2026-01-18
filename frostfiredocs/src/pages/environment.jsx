// src/pages/environment.jsx
import { Link } from 'bertui/router';
import '../styles/environment.css';

export default function Environment() {
  const copyAllToClipboard = () => {
    const configText = `DATABASE_ENGINE="mysql"
DATABASE_HOST="localhost"
DATABASE_NAME="frostfire"
DATABASE_PASSWORD="your_db_password"
DATABASE_PORT="3306"
DATABASE_USER="your_db_user"
SQL_SSL_MODE="DISABLED"

EMAIL_PASSWORD="your_email_password"
EMAIL_SERVICE="mail.example.com"
EMAIL_USER="your_email@example.com"
EMAIL_TEST="your_test_email@example.com"

WEBSRV_PORT="80"
WEBSRV_PORTSSL="443"
WEBSRV_USESSL="true"
SESSION_KEY="your_session_secret_key"

GOOGLE_TRANSLATE_API_KEY="your_google_api_key"
OPENAI_API_KEY="your_openai_api_key"
TRANSLATION_SERVICE="google_translate"
OPEN_AI_MODEL="gpt-4"

WEB_SOCKET_URL="wss://yourdomain.com"
WEB_SOCKET_PORT="3000"
DOMAIN="https://yourdomain.com"
GAME_NAME="Your Game Name"

CACHE="redis"
REDIS_URL="redis://default@redis:6379"

VERSION="1.0.0"`;
    navigator.clipboard.writeText(configText);
  };

  return (
    <div className="env-container">
      <header className="env-header bertui-animated bertui-fadeInDown">
        <h1 className="bertui-animated bertui-fadeIn">
          <span className="env-icon bertui-animated bertui-tada bertui-delay-1s">
            ⚙️
          </span>
          Environment Variables
        </h1>
        <p className="env-subtitle bertui-animated bertui-fadeIn bertui-delay-2s">
          Complete configuration guide for Frostfire Forge
        </p>
        
        <div className="env-badges">
          <span className="env-badge env-badge-important bertui-animated bertui-pulse bertui-infinite bertui-slow">
            ⚠️ Required for Production
          </span>
          <span className="env-badge env-badge-success bertui-animated bertui-pulse bertui-infinite bertui-slow bertui-delay-1s">
            ✓ Development Ready
          </span>
          <span className="env-badge env-badge-info bertui-animated bertui-pulse bertui-infinite bertui-slow bertui-delay-2s">
            Multiple Environments
          </span>
        </div>
      </header>

      <div className="env-content">
        {/* Quick Navigation */}
        <div className="env-quick-nav bertui-animated bertui-fadeInUp">
          <a href="#overview" className="env-quick-link bertui-animated bertui-fadeInLeft">
            📋 Overview
          </a>
          <a href="#database" className="env-quick-link bertui-animated bertui-fadeInLeft bertui-delay-1s">
            🗄️ Database
          </a>
          <a href="#server" className="env-quick-link bertui-animated bertui-fadeInLeft bertui-delay-2s">
            🌐 Server
          </a>
          <a href="#email" className="env-quick-link bertui-animated bertui-fadeInLeft bertui-delay-3s">
            📧 Email
          </a>
          <a href="#cache" className="env-quick-link bertui-animated bertui-fadeInLeft bertui-delay-4s">
            ⚡ Cache
          </a>
          <a href="#api" className="env-quick-link bertui-animated bertui-fadeInLeft bertui-delay-5s">
            🔑 API Keys
          </a>
          <a href="#quick-reference" className="env-quick-link bertui-animated bertui-fadeInLeft bertui-fast">
            🚀 Quick Ref
          </a>
        </div>

        {/* Overview */}
        <section id="overview" className="env-section bertui-animated bertui-fadeInUp bertui-delay-1s">
          <h2 className="bertui-animated bertui-fadeIn">
            <span className="section-icon bertui-animated bertui-wobble">
              📋
            </span>
            Overview
          </h2>
          
          <div className="env-note env-note-important bertui-animated bertui-pulse">
            <p>
              ⚠️
              <strong>Important:</strong> The following environment variables are required for production deployment.
              Make sure to configure them properly before running in production.
            </p>
          </div>

          <div className="env-note env-note-info bertui-animated bertui-pulse bertui-delay-1s">
            <h3>Environment Files</h3>
            <p>Frostfire Forge supports multiple environment configurations:</p>
            <div className="env-file-list">
              <div className="env-file bertui-animated bertui-fadeInLeft bertui-fast">
                <strong>.env.development</strong>
                <span>Development environment settings</span>
              </div>
              <div className="env-file bertui-animated bertui-fadeInLeft bertui-fast bertui-delay-1s">
                <strong>.env.production</strong>
                <span>Production environment settings</span>
              </div>
              <div className="env-file bertui-animated bertui-fadeInLeft bertui-slow">
                <strong>.env.local</strong>
                <span>Local override settings (highest priority)</span>
              </div>
            </div>
          </div>

          <h3 className="bertui-animated bertui-fadeIn bertui-slow bertui-delay-1s">
            Creating Environment Files
          </h3>
          <div className="env-code-block bertui-animated bertui-fadeIn bertui-slow bertui-delay-2s">
            <div className="env-code-header">
              <span>Terminal Commands</span>
            </div>
            <pre><code>{`# Copy example file for development
cp .env.example .env.development

# Copy example file for production
cp .env.example .env.production

# Edit the files with your settings
nano .env.development
nano .env.production`}</code></pre>
          </div>
        </section>

        {/* Database Configuration */}
        <section id="database" className="env-section bertui-animated bertui-fadeInUp bertui-delay-2s">
          <h2 className="bertui-animated bertui-fadeIn">
            <span className="section-icon bertui-animated bertui-bounce">
              🗄️
            </span>
            Database Configuration
          </h2>
          
          <p className="bertui-animated bertui-fadeIn bertui-delay-3s">
            Configure your database connection settings for MySQL or SQLite.
          </p>

          <div className="env-variable-list">
            <div className="env-variable-card env-variable-required bertui-animated bertui-fadeInUp bertui-delay-3s">
              <div className="env-variable-header">
                <h3>DATABASE_ENGINE</h3>
                <span className="env-required bertui-animated bertui-pulse bertui-infinite bertui-slow">Required</span>
              </div>
              <div className="env-variable-values">
                <code>"mysql"</code>
                <span className="env-value-separator">or</span>
                <code>"sqlite"</code>
              </div>
              <p className="env-variable-desc">
                Database engine to use. Use "sqlite" for development and "mysql" for production.
              </p>
            </div>

            <div className="env-variable-card env-variable-required bertui-animated bertui-fadeInUp bertui-delay-4s">
              <div className="env-variable-header">
                <h3>DATABASE_HOST</h3>
                <span className="env-required bertui-animated bertui-pulse bertui-infinite bertui-slow">Required for MySQL</span>
              </div>
              <code>your_db_host</code>
              <p className="env-variable-desc">
                Database server hostname or IP address.
              </p>
            </div>

            <div className="env-variable-card env-variable-required bertui-animated bertui-fadeInUp bertui-delay-5s">
              <div className="env-variable-header">
                <h3>DATABASE_NAME</h3>
                <span className="env-required bertui-animated bertui-pulse bertui-infinite bertui-slow">Required</span>
              </div>
              <code>your_db_name</code>
              <p className="env-variable-desc">
                Name of the database to connect to.
              </p>
            </div>

            <div className="env-variable-card env-variable-required bertui-animated bertui-fadeInUp bertui-fast">
              <div className="env-variable-header">
                <h3>DATABASE_USER</h3>
                <span className="env-required bertui-animated bertui-pulse bertui-infinite bertui-slow">Required for MySQL</span>
              </div>
              <code>your_db_user</code>
              <p className="env-variable-desc">
                Database username for authentication.
              </p>
            </div>

            <div className="env-variable-card env-variable-required bertui-animated bertui-fadeInUp bertui-fast bertui-delay-1s">
              <div className="env-variable-header">
                <h3>DATABASE_PASSWORD</h3>
                <span className="env-required bertui-animated bertui-pulse bertui-infinite bertui-slow">Required for MySQL</span>
              </div>
              <code>your_db_password</code>
              <p className="env-variable-desc">
                Database password for authentication.
              </p>
            </div>

            <div className="env-variable-card bertui-animated bertui-fadeInUp bertui-fast bertui-delay-2s">
              <div className="env-variable-header">
                <h3>DATABASE_PORT</h3>
                <span className="env-optional">Optional</span>
              </div>
              <code>"3306"</code>
              <p className="env-variable-desc">
                Database server port (default: 3306 for MySQL).
              </p>
            </div>

            <div className="env-variable-card bertui-animated bertui-fadeInUp bertui-slow">
              <div className="env-variable-header">
                <h3>SQL_SSL_MODE</h3>
                <span className="env-optional">Optional</span>
              </div>
              <div className="env-variable-values">
                <code>"DISABLED"</code>
                <span className="env-value-separator">or</span>
                <code>"ENABLED"</code>
              </div>
              <p className="env-variable-desc">
                SSL mode for database connection. Use "ENABLED" for secure connections.
              </p>
            </div>
          </div>

          <h3 className="bertui-animated bertui-fadeIn bertui-slow bertui-delay-1s">
            Example Database Configuration
          </h3>
          <div className="env-code-block bertui-animated bertui-fadeIn bertui-slow bertui-delay-2s">
            <div className="env-code-header">
              <span>For MySQL</span>
            </div>
            <pre><code>{`DATABASE_ENGINE="mysql"
DATABASE_HOST="localhost"
DATABASE_NAME="frostfire"
DATABASE_USER="root"
DATABASE_PASSWORD="your_secure_password"
DATABASE_PORT="3306"
SQL_SSL_MODE="DISABLED"`}</code></pre>
          </div>

          <div className="env-code-block bertui-animated bertui-fadeIn bertui-slow bertui-delay-3s">
            <div className="env-code-header">
              <span>For SQLite (Development)</span>
            </div>
            <pre><code>{`DATABASE_ENGINE="sqlite"
DATABASE_NAME="frostfire.db"
# Other database variables can be omitted for SQLite`}</code></pre>
          </div>
        </section>

        {/* Server Configuration */}
        <section id="server" className="env-section bertui-animated bertui-fadeInUp bertui-delay-3s">
          <h2 className="bertui-animated bertui-fadeIn">
            <span className="section-icon bertui-animated bertui-flash">
              🌐
            </span>
            Server Configuration
          </h2>
          
          <p className="bertui-animated bertui-fadeIn bertui-delay-4s">
            Configure your web server and application settings.
          </p>

          <div className="env-variable-list">
            <div className="env-variable-card bertui-animated bertui-fadeInLeft bertui-fast">
              <div className="env-variable-header">
                <h3>WEBSRV_PORT</h3>
                <span className="env-optional">Optional</span>
              </div>
              <code>"80"</code>
              <p className="env-variable-desc">
                HTTP port for web server (default: 80).
              </p>
            </div>

            <div className="env-variable-card bertui-animated bertui-fadeInLeft bertui-fast bertui-delay-1s">
              <div className="env-variable-header">
                <h3>WEBSRV_PORTSSL</h3>
                <span className="env-optional">Optional</span>
              </div>
              <code>"443"</code>
              <p className="env-variable-desc">
                HTTPS port for secure web server (default: 443).
              </p>
            </div>

            <div className="env-variable-card bertui-animated bertui-fadeInLeft bertui-fast bertui-delay-2s">
              <div className="env-variable-header">
                <h3>WEBSRV_USESSL</h3>
                <span className="env-optional">Optional</span>
              </div>
              <div className="env-variable-values">
                <code>"true"</code>
                <span className="env-value-separator">or</span>
                <code>"false"</code>
              </div>
              <p className="env-variable-desc">
                Enable SSL/TLS for web server.
              </p>
            </div>

            <div className="env-variable-card env-variable-required bertui-animated bertui-fadeInRight bertui-slow">
              <div className="env-variable-header">
                <h3>SESSION_KEY</h3>
                <span className="env-required bertui-animated bertui-pulse bertui-infinite bertui-slow">Required</span>
              </div>
              <code>your_session_secret_key</code>
              <p className="env-variable-desc">
                Secret key for session encryption. Use a strong, random string.
              </p>
            </div>

            <div className="env-variable-card bertui-animated bertui-fadeInRight bertui-slow bertui-delay-1s">
              <div className="env-variable-header">
                <h3>WEB_SOCKET_URL</h3>
                <span className="env-optional">Optional</span>
              </div>
              <code>wss://yourdomain.com</code>
              <p className="env-variable-desc">
                WebSocket server URL for client connections.
              </p>
            </div>

            <div className="env-variable-card bertui-animated bertui-fadeInRight bertui-slow bertui-delay-2s">
              <div className="env-variable-header">
                <h3>WEB_SOCKET_PORT</h3>
                <span className="env-optional">Optional</span>
              </div>
              <code>"3000"</code>
              <p className="env-variable-desc">
                WebSocket server port (default: 3000).
              </p>
            </div>

            <div className="env-variable-card bertui-animated bertui-fadeInLeft bertui-slower">
              <div className="env-variable-header">
                <h3>DOMAIN</h3>
                <span className="env-optional">Optional</span>
              </div>
              <code>https://yourdomain.com</code>
              <p className="env-variable-desc">
                Your game server's domain name.
              </p>
            </div>

            <div className="env-variable-card bertui-animated bertui-fadeInLeft bertui-slower bertui-delay-1s">
              <div className="env-variable-header">
                <h3>GAME_NAME</h3>
                <span className="env-optional">Optional</span>
              </div>
              <code>"Your Game Name"</code>
              <p className="env-variable-desc">
                Display name for your game.
              </p>
            </div>
          </div>
        </section>

        {/* Email Configuration */}
        <section id="email" className="env-section bertui-animated bertui-fadeInUp bertui-delay-4s">
          <h2 className="bertui-animated bertui-fadeIn">
            <span className="section-icon bertui-animated bertui-bounceIn">
              📧
            </span>
            Email Configuration
          </h2>
          
          <p className="bertui-animated bertui-fadeIn bertui-delay-5s">
            Configure email settings for notifications and user verification.
          </p>

          <div className="env-variable-list">
            <div className="env-variable-card env-variable-required bertui-animated bertui-fadeInUp bertui-fast">
              <div className="env-variable-header">
                <h3>EMAIL_SERVICE</h3>
                <span className="env-required bertui-animated bertui-pulse bertui-infinite bertui-slow">Required</span>
              </div>
              <code>mail.example.com</code>
              <p className="env-variable-desc">
                SMTP server hostname for email service.
              </p>
            </div>

            <div className="env-variable-card env-variable-required bertui-animated bertui-fadeInUp bertui-fast bertui-delay-1s">
              <div className="env-variable-header">
                <h3>EMAIL_USER</h3>
                <span className="env-required bertui-animated bertui-pulse bertui-infinite bertui-slow">Required</span>
              </div>
              <code>your_email@example.com</code>
              <p className="env-variable-desc">
                Email address for sending emails.
              </p>
            </div>

            <div className="env-variable-card env-variable-required bertui-animated bertui-fadeInUp bertui-fast bertui-delay-2s">
              <div className="env-variable-header">
                <h3>EMAIL_PASSWORD</h3>
                <span className="env-required bertui-animated bertui-pulse bertui-infinite bertui-slow">Required</span>
              </div>
              <code>your_email_password</code>
              <p className="env-variable-desc">
                Password for email authentication.
              </p>
            </div>

            <div className="env-variable-card bertui-animated bertui-fadeInUp bertui-slow">
              <div className="env-variable-header">
                <h3>EMAIL_TEST</h3>
                <span className="env-optional">Optional</span>
              </div>
              <code>your_test_email@example.com</code>
              <p className="env-variable-desc">
                Test email address for development and testing.
              </p>
            </div>
          </div>
        </section>

        {/* Cache Configuration */}
        <section id="cache" className="env-section bertui-animated bertui-fadeInUp bertui-delay-5s">
          <h2 className="bertui-animated bertui-fadeIn">
            <span className="section-icon bertui-animated bertui-wiggle">
              ⚡
            </span>
            Cache Configuration
          </h2>
          
          <div className="env-note env-note-info bertui-animated bertui-pulse">
            <p>
              ℹ️ Configure caching system for optimal performance. Redis is recommended for production.
            </p>
          </div>

          <div className="env-variable-list">
            <div className="env-variable-card env-variable-required bertui-animated bertui-fadeInUp bertui-fast">
              <div className="env-variable-header">
                <h3>CACHE</h3>
                <span className="env-required bertui-animated bertui-pulse bertui-infinite bertui-slow">Required</span>
              </div>
              <div className="env-variable-values">
                <code>"redis"</code>
                <span className="env-value-separator">or</span>
                <code>"memory"</code>
              </div>
              <p className="env-variable-desc">
                Cache engine to use. "redis" for production, "memory" for development.
              </p>
            </div>

            <div className="env-variable-card bertui-animated bertui-fadeInUp bertui-fast bertui-delay-1s">
              <div className="env-variable-header">
                <h3>REDIS_URL</h3>
                <span className="env-conditional">Conditional</span>
              </div>
              <code>redis://default@redis:6379</code>
              <p className="env-variable-desc">
                Redis connection URL (required if CACHE=redis).
              </p>
            </div>

            <div className="env-variable-card bertui-animated bertui-fadeInUp bertui-slow">
              <div className="env-variable-header">
                <h3>REDIS_PASSWORD</h3>
                <span className="env-conditional">Conditional</span>
              </div>
              <code>your_redis_password</code>
              <p className="env-variable-desc">
                Redis password for authentication (required if Redis is secured).
              </p>
            </div>
          </div>

          <h3 className="bertui-animated bertui-fadeIn bertui-slow bertui-delay-1s">
            Cache Configuration Examples
          </h3>
          <div className="env-code-block bertui-animated bertui-fadeIn bertui-slow bertui-delay-2s">
            <div className="env-code-header">
              <span>With Redis</span>
            </div>
            <pre><code>{`CACHE="redis"
REDIS_URL="redis://default:password@localhost:6379"
REDIS_PASSWORD="your_secure_password"`}</code></pre>
          </div>

          <div className="env-code-block bertui-animated bertui-fadeIn bertui-slow bertui-delay-3s">
            <div className="env-code-header">
              <span>With Memory (Development)</span>
            </div>
            <pre><code>{`CACHE="memory"
# Redis variables can be omitted`}</code></pre>
          </div>
        </section>

        {/* API Keys and Services */}
        <section id="api" className="env-section bertui-animated bertui-fadeInUp bertui-slower">
          <h2 className="bertui-animated bertui-fadeIn">
            <span className="section-icon bertui-animated bertui-flash bertui-infinite">
              🔑
            </span>
            API Keys and Services
          </h2>
          
          <p className="bertui-animated bertui-fadeIn bertui-fast">
            Configure third-party services and API keys for enhanced features.
          </p>

          <div className="env-variable-list">
            <div className="env-variable-card bertui-animated bertui-fadeInLeft bertui-fast">
              <div className="env-variable-header">
                <h3>TRANSLATION_SERVICE</h3>
                <span className="env-optional">Optional</span>
              </div>
              <div className="env-variable-values">
                <code>"google_translate"</code>
                <span className="env-value-separator">or</span>
                <code>"openai"</code>
              </div>
              <p className="env-variable-desc">
                Translation service to use for in-game text translation.
              </p>
            </div>

            <div className="env-variable-card bertui-animated bertui-fadeInLeft bertui-fast bertui-delay-1s">
              <div className="env-variable-header">
                <h3>GOOGLE_TRANSLATE_API_KEY</h3>
                <span className="env-conditional">Conditional</span>
              </div>
              <code>your_google_api_key</code>
              <p className="env-variable-desc">
                Google Translate API key (required if TRANSLATION_SERVICE="google_translate").
              </p>
            </div>

            <div className="env-variable-card bertui-animated bertui-fadeInLeft bertui-fast bertui-delay-2s">
              <div className="env-variable-header">
                <h3>OPENAI_API_KEY</h3>
                <span className="env-conditional">Conditional</span>
              </div>
              <code>your_openai_api_key</code>
              <p className="env-variable-desc">
                OpenAI API key (required if TRANSLATION_SERVICE="openai").
              </p>
            </div>

            <div className="env-variable-card bertui-animated bertui-fadeInRight bertui-slow">
              <div className="env-variable-header">
                <h3>OPEN_AI_MODEL</h3>
                <span className="env-optional">Optional</span>
              </div>
              <code>"gpt-4"</code>
              <p className="env-variable-desc">
                OpenAI model to use (default: "gpt-4").
              </p>
            </div>
          </div>
        </section>

        {/* Quick Reference */}
        <section id="quick-reference" className="env-section bertui-animated bertui-fadeInUp bertui-slow">
          <h2 className="bertui-animated bertui-fadeIn">
            <span className="section-icon bertui-animated bertui-tada bertui-infinite">
              🚀
            </span>
            Quick Reference
          </h2>
          
          <div className="env-note env-note-success bertui-animated bertui-pulse">
            <p>
              ✅ Here's a complete example configuration file with all recommended settings for production.
            </p>
          </div>

          <div className="env-code-block env-code-block-large bertui-animated bertui-fadeIn bertui-slow bertui-delay-1s">
            <div className="env-code-header">
              <span>Complete .env.production Example</span>
              <button 
                className="env-copy-btn bertui-animated bertui-pulse bertui-infinite bertui-slow"
                onClick={copyAllToClipboard}
              >
                Copy All
              </button>
            </div>
            <pre><code>{`DATABASE_ENGINE="mysql"
DATABASE_HOST="localhost"
DATABASE_NAME="frostfire"
DATABASE_PASSWORD="your_db_password"
DATABASE_PORT="3306"
DATABASE_USER="your_db_user"
SQL_SSL_MODE="DISABLED"

EMAIL_PASSWORD="your_email_password"
EMAIL_SERVICE="mail.example.com"
EMAIL_USER="your_email@example.com"
EMAIL_TEST="your_test_email@example.com"

WEBSRV_PORT="80"
WEBSRV_PORTSSL="443"
WEBSRV_USESSL="true"
SESSION_KEY="your_session_secret_key"

GOOGLE_TRANSLATE_API_KEY="your_google_api_key"
OPENAI_API_KEY="your_openai_api_key"
TRANSLATION_SERVICE="google_translate"
OPEN_AI_MODEL="gpt-4"

WEB_SOCKET_URL="wss://yourdomain.com"
WEB_SOCKET_PORT="3000"
DOMAIN="https://yourdomain.com"
GAME_NAME="Your Game Name"

CACHE="redis"
REDIS_URL="redis://default@redis:6379"

VERSION="1.0.0"`}</code></pre>
          </div>

          <h3 className="bertui-animated bertui-fadeIn bertui-slow bertui-delay-2s">
            Development Configuration
          </h3>
          <div className="env-code-block bertui-animated bertui-fadeIn bertui-slow bertui-delay-3s">
            <div className="env-code-header">
              <span>Minimal .env.development Example</span>
            </div>
            <pre><code>{`DATABASE_ENGINE="sqlite"
DATABASE_NAME="frostfire.db"

EMAIL_TEST="test@example.com"

WEBSRV_PORT="80"
WEBSRV_USESSL="false"
SESSION_KEY="dev_session_key_123"

WEB_SOCKET_PORT="3000"
DOMAIN="http://localhost"
GAME_NAME="Frostfire Forge Dev"

CACHE="memory"

VERSION="1.0.0-dev"`}</code></pre>
          </div>
        </section>

        {/* Next Steps */}
        <section className="env-section bertui-animated bertui-fadeInUp bertui-slower">
          <h2 className="bertui-animated bertui-fadeIn">
            <span className="section-icon bertui-animated bertui-tada">
              🎯
            </span>
            Next Steps
          </h2>
          
          <div className="env-next-steps">
            <div className="env-next-step bertui-animated bertui-fadeInLeft">
              <h3>Getting Started</h3>
              <p>Follow the step-by-step guide to set up your Frostfire Forge instance.</p>
              <Link to="/getting-started" className="env-next-link bertui-animated bertui-pulse bertui-infinite bertui-slow">
                Getting Started Guide →
              </Link>
            </div>
            
            <div className="env-next-step bertui-animated bertui-fadeInUp">
              <h3>Docker Deployment</h3>
              <p>Learn how to deploy using Docker containers for easy management.</p>
              <Link to="/docker" className="env-next-link bertui-animated bertui-pulse bertui-infinite bertui-slow bertui-delay-1s">
                Docker Guide →
              </Link>
            </div>
            
            <div className="env-next-step bertui-animated bertui-fadeInRight">
              <h3>Commands Reference</h3>
              <p>Explore all available admin and player commands.</p>
              <Link to="/commands" className="env-next-link bertui-animated bertui-pulse bertui-infinite bertui-slow bertui-delay-2s">
                Commands Reference →
              </Link>
            </div>
          </div>
        </section>
      </div>

      {/* Navigation */}
      <div className="env-navigation">
        <Link to="/docker" className="env-nav-link env-nav-prev bertui-animated bertui-fadeInLeft">
          ← Docker Setup
        </Link>
        <Link to="/commands" className="env-nav-link env-nav-next bertui-animated bertui-fadeInRight">
          Commands Reference →
        </Link>
      </div>
    </div>
  );
}