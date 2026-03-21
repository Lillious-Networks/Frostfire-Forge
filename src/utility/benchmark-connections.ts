#!/usr/bin/env bun

import chalk from 'chalk';
import crypto from 'crypto';

interface BenchmarkConfig {
    connections: number;
    duration: number;
    websocketUrl: string;
    serverSecret: string;
    help: boolean;
}

function parseArgs(): BenchmarkConfig {
    const args = process.argv.slice(2);

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

const activeConnections = new Set<WebSocket>();
const connectionTimestamps = new Map<WebSocket, number>();

let testRunning = true;

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

function generateConnectionToken(config: BenchmarkConfig): string {
    const token = crypto.randomBytes(32).toString('hex');
    const timestamp = Date.now().toString();
    const expiresAt = (Date.now() + 60000).toString();

    const signature = crypto
        .createHmac('sha256', config.serverSecret)
        .update(`${token}:${timestamp}:${expiresAt}`)
        .digest('hex');

    const url = new URL(config.websocketUrl);
    url.searchParams.set('token', token);
    url.searchParams.set('timestamp', timestamp);
    url.searchParams.set('expiresAt', expiresAt);
    url.searchParams.set('signature', signature);

    return url.toString();
}

async function createConnection(index: number, config: BenchmarkConfig): Promise<void> {
    try {

        const wsUrl = generateConnectionToken(config);

        const ws = new WebSocket(wsUrl);

        ws.addEventListener('open', () => {
            stats.opened++;
            stats.active++;
            activeConnections.add(ws);

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

                        if (stats.latencies.length > 1000) {
                            stats.latencies.shift();
                        }
                    }
                }
            } catch (e: any) {
                console.error(chalk.red(`Error processing message for connection ${index}: ${e.message}`));
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

    const batchSize = 10;
    const batchDelay = 100;

    let lastUpdateTime = 0;
    const progressUpdateInterval = setInterval(() => {
        const now = Date.now();
        if (now - lastUpdateTime < 100) return;
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

        if ((i + 1) % batchSize === 0 && i + 1 < config.connections) {
            await new Promise(resolve => setTimeout(resolve, batchDelay));
        }
    }

    const startWaitTime = Date.now();
    const maxWaitTime = 60000;

    while (true) {
        const total = stats.opened + stats.failed;
        const elapsedWait = Date.now() - startWaitTime;

        if (total >= config.connections || elapsedWait >= maxWaitTime) {
            break;
        }

        await new Promise(resolve => setTimeout(resolve, 100));
    }

    clearInterval(progressUpdateInterval);

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

    await new Promise(resolve => setTimeout(resolve, config.duration * 1000));

    testRunning = false;
    clearInterval(progressInterval);

    const finalHoldingBar = chalk.green('█'.repeat(40));
    const connectionColor = stats.active === stats.opened ? chalk.green : chalk.yellow;
    process.stdout.write(`\r  ${chalk.bold('Holding:')} [${finalHoldingBar}] ${chalk.bold('100%')} ${chalk.white(config.duration + 's')}${chalk.gray('/')}${chalk.white(config.duration + 's')} │ Active: ${connectionColor(stats.active)}${chalk.gray('/')}${chalk.white(stats.opened)}\n`);
    console.log('');

    log('Closing connections...', 'info');
    for (const ws of activeConnections) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.close();
        }
    }

    await new Promise(resolve => setTimeout(resolve, 1000));

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

const config = parseArgs();

if (config.help) {
    showHelp();
    process.exit(0);
}

process.on('SIGINT', () => {
    console.log('\n\n' + chalk.yellow('⚠ Benchmark interrupted by user') + '\n');
    testRunning = false;

    for (const ws of activeConnections) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.close();
        }
    }

    process.exit(0);
});

runBenchmark(config).then(() => {
    process.exit(0);
}).catch((error) => {
    log(`Benchmark failed: ${error.message}`, 'error');
    process.exit(1);
});
