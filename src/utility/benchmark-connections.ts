#!/usr/bin/env bun
/**
 * Connection Hold Tool for Frostfire Forge
 *
 * Opens and holds X number of WebSocket connections to stress-test connection capacity.
 * Does NOT create guest accounts or perform authentication - just opens
 * connections, sends one BENCHMARK packet to register, then holds them open.
 *
 * This tool is designed to test the server's ability to handle many concurrent
 * WebSocket connections without the overhead of player accounts, login, movement, etc.
 *
 * Usage:
 *   bun --env-file=.env.production src/utility/benchmark-connections.ts [options]
 *
 * Options:
 *   --connections <number>  Number of concurrent connections (default: 100)
 *   --duration <number>     How long to hold connections in seconds (default: 60, min: 10)
 *   --server-secret <key>  Shared secret for token generation
 *   --ws <url>             WebSocket URL (overrides environment detection)
 *   --help                 Show this help message
 *
 * Examples:
 *   # Hold 10,000 connections for 5 minutes
 *   bun --env-file=.env.production src/utility/benchmark-connections.ts --connections 10000 --duration 300
 *
 *   # Hold 500 connections indefinitely (use Ctrl+C to stop)
 *   bun --env-file=.env.local src/utility/benchmark-connections.ts --connections 500 --duration 999999
 */

import chalk from 'chalk';
import crypto from 'crypto';

// Configuration interface
interface BenchmarkConfig {
    connections: number;
    duration: number;
    websocketUrl: string;
    serverSecret: string;
    help: boolean;
}

// Parse command line arguments
function parseArgs(): BenchmarkConfig {
    const args = process.argv.slice(2);

    // Build default WebSocket URL based on environment
    const useSSL = process.env.WEB_SOCKET_USE_SSL === 'true';
    const host = process.env.PUBLIC_HOST || process.env.SERVER_HOST || 'localhost';
    const port = process.env.WEB_SOCKET_PORT || '3000';
    const protocol = useSSL ? 'wss' : 'ws';

    const config: BenchmarkConfig = {
        connections: 100,
        duration: 60,
        websocketUrl: `${protocol}://${host}:${port}`,
        serverSecret: process.env.GATEWAY_GAME_SERVER_SECRET || 'default-secret-change-me',
        help: false
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        switch (arg) {
            case '--connections':
                config.connections = Math.max(1, parseInt(args[++i]) || 100);
                break;
            case '--duration':
                config.duration = Math.max(10, parseInt(args[++i]) || 60);
                break;
            case '--server-secret':
                config.serverSecret = args[++i] || config.serverSecret;
                break;
            case '--ws':
                config.websocketUrl = args[++i] || config.websocketUrl;
                break;
            case '--help':
                config.help = true;
                break;
        }
    }

    return config;
}

// Show help message
function showHelp() {
    console.log(`
${chalk.bold.cyan('Frostfire Forge - Connection Hold Tool')}

${chalk.bold('Usage:')}
  bun --env-file=<env-file> src/utility/benchmark-connections.ts [options]

${chalk.bold('Options:')}
  --connections <number>  Number of concurrent connections (min: 1, default: 100)
  --duration <number>     How long to hold connections in seconds (min: 10, default: 60)
  --server-secret <key>  Shared secret for token generation
  --ws <url>             WebSocket URL (overrides environment detection)
  --help                 Show this help message

${chalk.bold('Environment Variables:')}
  WEB_SOCKET_PORT              WebSocket port (default: 3000)
  WEB_SOCKET_USE_SSL           Use SSL/TLS (wss://) for connections
  PUBLIC_HOST                  Public hostname for connections
  SERVER_HOST                  Server hostname (fallback if PUBLIC_HOST not set)
  GATEWAY_GAME_SERVER_SECRET   Shared secret for token signing

${chalk.bold('Examples:')}
  # Hold 10,000 connections for 5 minutes
  bun --env-file=.env.production src/utility/benchmark-connections.ts --connections 10000 --duration 300

  # Hold 1000 connections for default 60 seconds
  bun --env-file=.env.production src/utility/benchmark-connections.ts --connections 1000

  # Hold connections indefinitely (use Ctrl+C to stop)
  bun src/utility/benchmark-connections.ts --connections 500 --duration 999999

${chalk.bold('Notes:')}
  - This tool bypasses the gateway and connects directly to the game server
  - Opens WebSocket connections, sends one BENCHMARK packet, then holds them
  - No guest accounts created, no authentication, no movement simulation
  - Designed to stress-test raw connection capacity
  - Automatically generates connection tokens using GATEWAY_GAME_SERVER_SECRET
`);
}

// Packet encoding utility
const packet = {
    encode(data: string): Uint8Array {
        const encoder = new TextEncoder();
        return encoder.encode(data);
    },
    decode(data: ArrayBuffer): string {
        const decoder = new TextDecoder();
        return decoder.decode(data);
    }
};

// Connection statistics
interface ConnectionStats {
    opened: number;
    failed: number;
    closed: number;
    active: number;
    benchmarkPacketsSent: number;
    benchmarkPacketsReceived: number;
    latencies: number[];
}

const stats: ConnectionStats = {
    opened: 0,
    failed: 0,
    closed: 0,
    active: 0,
    benchmarkPacketsSent: 0,
    benchmarkPacketsReceived: 0,
    latencies: []
};

// Connection tracking
const activeConnections = new Set<WebSocket>();
const connectionTimestamps = new Map<WebSocket, number>();

// Test running flag
let testRunning = true;

// Logging utility
function log(message: string, level: 'info' | 'error' | 'success' | 'warn' = 'info') {
    const timestamp = chalk.gray(new Date().toLocaleTimeString());
    const prefix = {
        info: chalk.cyan('ℹ'),
        error: chalk.red('✖'),
        success: chalk.green('✓'),
        warn: chalk.yellow('⚠')
    }[level];
    console.log(`${timestamp} ${prefix} ${message}`);
}

// Generate connection token for direct connection
function generateConnectionToken(config: BenchmarkConfig): string {
    const token = crypto.randomBytes(32).toString('hex');
    const timestamp = Date.now().toString();
    const expiresAt = (Date.now() + 60000).toString(); // 60 second expiry

    // Create HMAC signature
    const signature = crypto
        .createHmac('sha256', config.serverSecret)
        .update(`${token}:${timestamp}:${expiresAt}`)
        .digest('hex');

    // Build URL with query parameters
    const url = new URL(config.websocketUrl);
    url.searchParams.set('token', token);
    url.searchParams.set('timestamp', timestamp);
    url.searchParams.set('expiresAt', expiresAt);
    url.searchParams.set('signature', signature);

    return url.toString();
}

// Create a single connection
async function createConnection(index: number, config: BenchmarkConfig): Promise<void> {
    try {
        // Generate token for direct connection to game server
        const wsUrl = generateConnectionToken(config);

        const ws = new WebSocket(wsUrl);

        ws.addEventListener('open', () => {
            stats.opened++;
            stats.active++;
            activeConnections.add(ws);

            // Send one BENCHMARK packet to register with server, then just hold the connection
            const sendTime = Date.now();
            connectionTimestamps.set(ws, sendTime);
            ws.send(Buffer.from(packet.encode(JSON.stringify({
                type: 'BENCHMARK',
                data: {
                    connectionId: index,
                    timestamp: sendTime
                }
            }))));

            stats.benchmarkPacketsSent++;
        });

        ws.addEventListener('message', (event: any) => {
            try {
                const message = JSON.parse(packet.decode(event.data));

                if (message.type === 'BENCHMARK') {
                    stats.benchmarkPacketsReceived++;

                    const sentTime = connectionTimestamps.get(ws);
                    if (sentTime) {
                        const latency = Date.now() - sentTime;
                        stats.latencies.push(latency);

                        // Keep only last 1000 latency samples
                        if (stats.latencies.length > 1000) {
                            stats.latencies.shift();
                        }
                    }
                }
            } catch (e) {
                // Ignore parse errors
            }
        });

        ws.addEventListener('error', (error) => {
            stats.failed++;
        });

        ws.addEventListener('close', () => {
            stats.closed++;
            stats.active = Math.max(0, stats.active - 1);
            activeConnections.delete(ws);
            connectionTimestamps.delete(ws);
        });

    } catch (error: any) {
        stats.failed++;
        log(`Connection ${index} failed: ${error.message}`, 'error');
    }
}

// Main benchmark function
async function runBenchmark(config: BenchmarkConfig) {
    console.log('\n' + chalk.bold.cyan('━'.repeat(70)));
    console.log(chalk.bold.cyan('  Frostfire Forge - Connection Hold Test'));
    console.log(chalk.bold.cyan('━'.repeat(70)) + '\n');

    console.log(`  ${chalk.bold('Connections:')} ${chalk.white(config.connections)}`);
    console.log(`  ${chalk.bold('Duration:')}    ${chalk.white(config.duration + 's')}`);
    console.log(`  ${chalk.bold('Mode:')}        ${chalk.cyan('Direct')} ${chalk.gray('(bypassing gateway)')}`);
    console.log(`  ${chalk.bold('Target:')}      ${chalk.blue(config.websocketUrl)}`);

    console.log('\n' + chalk.gray('─'.repeat(70)) + '\n');

    log('Opening connections...', 'info');

    // Create all connections (staggered to avoid overwhelming the server)
    const batchSize = 10; // Create 10 connections at a time
    const batchDelay = 100; // 100ms between batches

    // Start a progress update interval
    let lastUpdateTime = 0;
    const progressUpdateInterval = setInterval(() => {
        const now = Date.now();
        if (now - lastUpdateTime < 100) return; // Throttle updates
        lastUpdateTime = now;

        const total = stats.opened + stats.failed;
        if (total < config.connections) {
            const percentage = Math.round((total / config.connections) * 100);
            const bar = chalk.cyan('█'.repeat(Math.floor(percentage / 2))) + chalk.gray('░'.repeat(50 - Math.floor(percentage / 2)));
            const failedDisplay = stats.failed > 0 ? chalk.red(` -${stats.failed} failed`) : '';
            process.stdout.write(`\r  ${chalk.bold.cyan('Connecting:')} [${bar}] ${chalk.bold(percentage + '%')} ${chalk.white(stats.opened)}${chalk.gray('/')}${chalk.white(config.connections)}${failedDisplay}`);
        }
    }, 100);

    for (let i = 0; i < config.connections; i++) {
        createConnection(i, config);

        // Stagger connection creation
        if ((i + 1) % batchSize === 0 && i + 1 < config.connections) {
            await new Promise(resolve => setTimeout(resolve, batchDelay));
        }
    }

    // Wait for ALL connections to establish (or timeout)
    const startWaitTime = Date.now();
    const maxWaitTime = 60000; // Max 60 seconds

    while (true) {
        const total = stats.opened + stats.failed;
        const elapsedWait = Date.now() - startWaitTime;

        // Stop if ALL connections are done (opened or failed) or max wait time
        if (total >= config.connections || elapsedWait >= maxWaitTime) {
            break;
        }

        await new Promise(resolve => setTimeout(resolve, 100));
    }

    clearInterval(progressUpdateInterval);

    // Final connection status
    const finalPercentage = Math.round((stats.opened / config.connections) * 100);
    const finalBar = stats.opened === config.connections
        ? chalk.green('█'.repeat(50))
        : chalk.yellow('█'.repeat(Math.floor(finalPercentage / 2))) + chalk.gray('░'.repeat(50 - Math.floor(finalPercentage / 2)));
    const failedDisplay = stats.failed > 0 ? chalk.red(` -${stats.failed} failed`) : '';
    process.stdout.write(`\r  ${chalk.bold.green('Connected:')} [${finalBar}] ${chalk.bold(finalPercentage + '%')} ${chalk.white(stats.opened)}${chalk.gray('/')}${chalk.white(config.connections)}${failedDisplay}\n`);

    console.log('');
    log(`Opened ${stats.opened}/${config.connections} connections (${stats.failed} failed)`, stats.failed > 0 ? 'warn' : 'success');

    if (stats.opened === 0) {
        log('No connections established. Exiting.', 'error');
        return;
    }

    log(`Holding ${stats.opened} connections for ${config.duration} seconds...`, 'info');
    console.log('');

    // Simple progress tracking - just show time and active connections
    let elapsedSeconds = 0;
    const progressInterval = setInterval(() => {
        if (!testRunning) {
            clearInterval(progressInterval);
            return;
        }
        elapsedSeconds++;

        const percentage = Math.min(100, Math.round((elapsedSeconds / config.duration) * 100));
        const filledLength = Math.round((40 * elapsedSeconds) / config.duration);
        const bar = chalk.green('█'.repeat(filledLength)) + chalk.gray('░'.repeat(40 - filledLength));

        const connectionColor = stats.active === stats.opened ? chalk.green : chalk.yellow;
        const timeDisplay = chalk.white(`${elapsedSeconds}s`) + chalk.gray('/') + chalk.white(`${config.duration}s`);

        process.stdout.write(`\r  ${chalk.bold('Holding:')} [${bar}] ${chalk.bold(percentage + '%')} ${timeDisplay} │ Active: ${connectionColor(stats.active)}${chalk.gray('/')}${chalk.white(stats.opened)}`);
    }, 1000);

    // Wait for test duration
    await new Promise(resolve => setTimeout(resolve, config.duration * 1000));

    testRunning = false;
    clearInterval(progressInterval);

    // Draw final progress
    const finalHoldingBar = chalk.green('█'.repeat(40));
    const connectionColor = stats.active === stats.opened ? chalk.green : chalk.yellow;
    process.stdout.write(`\r  ${chalk.bold('Holding:')} [${finalHoldingBar}] ${chalk.bold('100%')} ${chalk.white(config.duration + 's')}${chalk.gray('/')}${chalk.white(config.duration + 's')} │ Active: ${connectionColor(stats.active)}${chalk.gray('/')}${chalk.white(stats.opened)}\n`);
    console.log('');

    // Close all connections
    log('Closing connections...', 'info');
    for (const ws of activeConnections) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.close();
        }
    }

    // Wait a bit for close events
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Display results
    console.log('\n' + chalk.bold.green('━'.repeat(70)));
    console.log(chalk.bold.green('  Connection Test Complete'));
    console.log(chalk.bold.green('━'.repeat(70)) + '\n');

    console.log(`  ${chalk.bold('Total Duration:')} ${chalk.white(config.duration + 's')}`);
    console.log(`\n  ${chalk.bold('Connection Statistics:')}`);
    console.log(`    ${chalk.bold('Total Attempted:')} ${chalk.white(config.connections)}`);
    console.log(`    ${chalk.bold('Opened:')}         ${chalk.green(stats.opened)}`);
    console.log(`    ${chalk.bold('Failed:')}         ${stats.failed > 0 ? chalk.red(stats.failed) : chalk.green('0')}`);

    if (stats.active === stats.opened) {
        console.log(`    ${chalk.bold('Active at End:')}  ${chalk.green(stats.active)} ${chalk.green('✓ All connections held')}`);
    } else {
        const disconnected = stats.opened - stats.active;
        console.log(`    ${chalk.bold('Active at End:')}  ${chalk.yellow(stats.active)} ${chalk.yellow('(' + disconnected + ' disconnected)')}`);
    }

    console.log('\n' + chalk.gray('━'.repeat(70)) + '\n');
}

// Main execution
const config = parseArgs();

if (config.help) {
    showHelp();
    process.exit(0);
}

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
    console.log('\n\n' + chalk.yellow('⚠ Benchmark interrupted by user') + '\n');
    testRunning = false;

    // Close all connections
    for (const ws of activeConnections) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.close();
        }
    }

    process.exit(0);
});

// Run the benchmark
runBenchmark(config).then(() => {
    process.exit(0);
}).catch((error) => {
    log(`Benchmark failed: ${error.message}`, 'error');
    process.exit(1);
});
