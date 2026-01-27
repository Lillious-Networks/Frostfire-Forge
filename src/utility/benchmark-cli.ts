#!/usr/bin/env bun
/**
 * CLI Benchmark Tool for Frostfire Forge
 *
 * Replicates the browser-based benchmark functionality as a command-line tool.
 * Tests WebSocket connections, simulates player movements, and measures server performance.
 *
 * Automatically reads configuration from environment variables (DOMAIN, WEB_SOCKET_URL, WEB_SOCKET_PORT).
 * Run with --env-file to specify environment file, or CLI arguments will override env vars.
 *
 * Usage:
 *   bun --env-file=.env.production src/utility/benchmark-cli.ts [options]
 *   bun --env-file=.env.development src/utility/benchmark-cli.ts [options]
 *
 * Options:
 *   --clients <number>     Number of concurrent clients (default: 50, no limit)
 *   --duration <number>    Test duration in seconds (default: 60, min: 10)
 *   --host <url>          Server host URL (overrides DOMAIN env var)
 *   --ws <url>            WebSocket URL (overrides WEB_SOCKET_URL:WEB_SOCKET_PORT)
 *   --help                Show this help message
 *
 * Examples:
 *   bun --env-file=.env.production src/utility/benchmark-cli.ts --clients 100 --duration 120
 *   bun --env-file=.env.local src/utility/benchmark-cli.ts --clients 50 --duration 60
 */

import chalk from 'chalk';

// Parse command line arguments
function parseArgs() {
    const args = process.argv.slice(2);

    // Get defaults from environment variables
    const defaultHost = process.env.DOMAIN || 'http://localhost:80';
    let wsBaseUrl = process.env.WEB_SOCKET_URL || 'ws://localhost';
    const wsPort = process.env.WEB_SOCKET_PORT || '3000';

    // Convert http:// to ws:// and https:// to wss:// for WebSocket URLs
    if (wsBaseUrl.startsWith('http://')) {
        wsBaseUrl = wsBaseUrl.replace('http://', 'ws://');
    } else if (wsBaseUrl.startsWith('https://')) {
        wsBaseUrl = wsBaseUrl.replace('https://', 'wss://');
    }

    // Build default WebSocket URL from environment
    let defaultWebsocketUrl = wsBaseUrl;
    if (!defaultWebsocketUrl.includes(':') || defaultWebsocketUrl.split(':').length < 3) {
        // Only add port if not already in URL
        defaultWebsocketUrl = `${wsBaseUrl}:${wsPort}`;
    }

    const config = {
        clients: 50,
        duration: 60,
        host: defaultHost,
        websocketUrl: defaultWebsocketUrl,
        help: false
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        switch (arg) {
            case '--clients':
                config.clients = Math.max(1, parseInt(args[++i]) || 50);
                break;
            case '--duration':
                config.duration = Math.max(10, parseInt(args[++i]) || 60);
                break;
            case '--host':
                config.host = args[++i] || defaultHost;
                break;
            case '--ws':
                config.websocketUrl = args[++i] || defaultWebsocketUrl;
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
Frostfire Forge - CLI Benchmark Tool

Usage:
  bun --env-file=<env-file> src/utility/benchmark-cli.ts [options]

Options:
  --clients <number>     Number of concurrent clients (min: 1, default: 50, no limit)
  --duration <number>    Test duration in seconds (min: 10, default: 60, no limit)
  --host <url>          Server host URL (overrides DOMAIN env var)
  --ws <url>            WebSocket URL (overrides WEB_SOCKET_URL:WEB_SOCKET_PORT)
  --help                Show this help message

Environment Variables:
  DOMAIN                Server host URL (e.g., http://beta.forge.lillious.com)
  WEB_SOCKET_URL        WebSocket base URL (e.g., ws://beta.forge.lillious.com)
  WEB_SOCKET_PORT       WebSocket port (e.g., 3000)

Examples:
  bun --env-file=.env.production src/utility/benchmark-cli.ts --clients 100 --duration 120
  bun --env-file=.env.local src/utility/benchmark-cli.ts --clients 50 --duration 60
  bun --env-file=.env.development src/utility/benchmark-cli.ts
`);
}

// Packet encoding/decoding utilities
const packet = {
    decode(data: ArrayBuffer): string {
        const decoder = new TextDecoder();
        return decoder.decode(data);
    },
    encode(data: string): Uint8Array {
        const encoder = new TextEncoder();
        return encoder.encode(data);
    }
};

// Latency tracking
interface LatencyStats {
    samples: number[];
    lastSyncTimes: Map<any, number>;
}

const latencyStats: LatencyStats = {
    samples: [],
    lastSyncTimes: new Map()
};

// WebSocket interval tracking
const websocketIntervals = new Map<any, { timeSync: any }>();

// Pending timeouts for movement simulation
const pendingTimeouts = new Map<any, Set<any>>();

// Flag to stop the benchmark
let stopped = false;

// Logging function
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

// Progress bar with connection status
function drawProgress(current: number, total: number, activeConnections: number, totalConnections: number, latency: any, barLength: number = 40) {
    const percentage = Math.min(100, Math.round((current / total) * 100));
    const filledLength = Math.round((barLength * current) / total);

    // Color the progress bar based on percentage
    let barColor = chalk.green;
    if (percentage < 33) barColor = chalk.yellow;
    else if (percentage < 66) barColor = chalk.cyan;

    const filledBar = barColor('█'.repeat(filledLength));
    const emptyBar = chalk.gray('░'.repeat(barLength - filledLength));
    const bar = filledBar + emptyBar;

    // Connection status with colors
    const connectionRatio = activeConnections / totalConnections;
    let connectionColor = chalk.green;
    if (connectionRatio < 0.8) connectionColor = chalk.yellow;
    if (connectionRatio < 0.5) connectionColor = chalk.red;

    const connectionStatus = connectionColor(`${activeConnections}/${totalConnections}`);

    // Time display
    const timeDisplay = chalk.white(`${current}s`) + chalk.gray('/') + chalk.white(`${total}s`);

    // Latency display with color coding
    let latencyDisplay = '';
    if (latency.count > 0) {
        let latencyColor = chalk.green;
        if (latency.avg > 100) latencyColor = chalk.yellow;
        if (latency.avg > 200) latencyColor = chalk.red;

        latencyDisplay = ` │ Latency: ${latencyColor(latency.avg + 'ms')} ${chalk.gray(`(${latency.min}-${latency.max}ms)`)}`;
    } else {
        latencyDisplay = ` │ ${chalk.gray('Waiting for latency data...')}`;
    }

    process.stdout.write(`\r  ${chalk.bold('Progress:')} [${bar}] ${chalk.bold(percentage + '%')} ${timeDisplay} │ Clients: ${connectionStatus}${latencyDisplay}`);
}

// Start TIME_SYNC to keep connection alive and track latency
function startKeepAlive(websocket: any) {
    const sendTimeSync = () => {
        if (stopped || websocket.readyState !== 1) { // 1 = OPEN
            const intervals = websocketIntervals.get(websocket);
            if (intervals?.timeSync) clearInterval(intervals.timeSync);
            return;
        }

        const sendTime = Date.now();
        latencyStats.lastSyncTimes.set(websocket, sendTime);

        websocket.send(packet.encode(JSON.stringify({
            type: "TIME_SYNC",
            data: sendTime
        })));
    };

    // Send first TIME_SYNC immediately
    sendTimeSync();

    // Then send TIME_SYNC every 5 seconds
    const timeSyncInterval = setInterval(sendTimeSync, 5000);

    const intervals = websocketIntervals.get(websocket) || { timeSync: null };
    intervals.timeSync = timeSyncInterval;
    websocketIntervals.set(websocket, intervals);
}

// Start movement simulation
function startMovementSimulation(websocket: any, initialDelay: number = 0) {
    const directions = ['up', 'down', 'left', 'right', 'upleft', 'upright', 'downleft', 'downright'];

    if (!pendingTimeouts.has(websocket)) {
        pendingTimeouts.set(websocket, new Set());
    }

    const scheduleNextMovement = () => {
        if (stopped || websocket.readyState !== 1) return;

        const moveDuration = 1000 + Math.floor(Math.random() * 3000);
        const holdTime = 1000 + Math.floor(Math.random() * 3000);

        const randomDirection = directions[Math.floor(Math.random() * directions.length)];
        websocket.send(packet.encode(JSON.stringify({
            type: "MOVEXY",
            data: randomDirection
        })));

        const abortTimeout = setTimeout(() => {
            if (stopped || websocket.readyState !== 1) {
                pendingTimeouts.get(websocket)?.delete(abortTimeout);
                return;
            }

            websocket.send(packet.encode(JSON.stringify({
                type: "MOVEXY",
                data: "abort"
            })));

            pendingTimeouts.get(websocket)?.delete(abortTimeout);

            const nextMoveTimeout = setTimeout(() => {
                if (stopped || websocket.readyState !== 1) {
                    pendingTimeouts.get(websocket)?.delete(nextMoveTimeout);
                    return;
                }

                pendingTimeouts.get(websocket)?.delete(nextMoveTimeout);
                scheduleNextMovement();
            }, holdTime);

            pendingTimeouts.get(websocket)?.add(nextMoveTimeout);
        }, moveDuration);

        pendingTimeouts.get(websocket)?.add(abortTimeout);
    };

    const startTimeout = setTimeout(() => {
        if (stopped || websocket.readyState !== 1) {
            pendingTimeouts.get(websocket)?.delete(startTimeout);
            return;
        }

        pendingTimeouts.get(websocket)?.delete(startTimeout);
        scheduleNextMovement();
    }, initialDelay);

    pendingTimeouts.get(websocket)?.add(startTimeout);
}

// Create clients
async function createClients(amount: number, host: string, websocketUrl: string): Promise<any[]> {
    const allWebsockets: any[] = [];
    const loggedInWebsockets: any[] = [];

    return new Promise(async (resolve) => {
        let openedCount = 0;
        let loggedInCount = 0;
        let loginTimeout: any = null;
        let lastUpdateTime = 0;

        const updateConnectionStatus = () => {
            const now = Date.now();
            if (now - lastUpdateTime < 250) return;
            lastUpdateTime = now;

            if (!stopped) {
                const openRatio = openedCount / amount;
                const loginRatio = loggedInCount / amount;

                if (openedCount < amount) {
                    const openPercentage = Math.round(openRatio * 100);
                    const bar = chalk.cyan('█'.repeat(Math.floor(openPercentage / 2))) + chalk.gray('░'.repeat(50 - Math.floor(openPercentage / 2)));
                    process.stdout.write(`\r  ${chalk.bold.cyan('Connecting:')} [${bar}] ${chalk.bold(openPercentage + '%')} ${chalk.white(openedCount)}${chalk.gray('/')}${chalk.white(amount)} clients`);
                } else if (loggedInCount < amount) {
                    const loginPercentage = Math.round(loginRatio * 100);
                    const bar = chalk.green('█'.repeat(Math.floor(loginPercentage / 2))) + chalk.gray('░'.repeat(50 - Math.floor(loginPercentage / 2)));
                    process.stdout.write(`\r  ${chalk.bold.green('Logging in:')} [${bar}] ${chalk.bold(loginPercentage + '%')} ${chalk.white(loggedInCount)}${chalk.gray('/')}${chalk.white(amount)} clients`);
                }
            }
        };

        const startLoginTimeout = () => {
            loginTimeout = setTimeout(() => {
                if (loggedInCount < amount) {
                    // Clear the progress line before logging timeout
                    process.stdout.write('\r' + ' '.repeat(120) + '\r');
                    log(`Login timeout: ${loggedInCount}/${amount} clients logged in`, 'warn');

                    allWebsockets.forEach(ws => {
                        if (!loggedInWebsockets.includes(ws) && ws.readyState === 1) {
                            ws.close();
                        }
                    });

                    log(`${loggedInCount}/${amount} clients logged in - proceeding`, 'info');
                    resolve(loggedInWebsockets);
                }
            }, 30000);
        };

        // Create clients with controlled staggering in batches
        const clientPromises = [];
        const batchSize = 2; // Create 2 clients at a time
        const batchDelay = 500; // 500ms between batches (very conservative for high counts)

        for (let i = 0; i < amount; i++) {
            const clientPromise = (async () => {
                // Add delay based on batch (every 2 clients waits 500ms)
                const batchIndex = Math.floor(i / batchSize);
                if (batchIndex > 0) {
                    await new Promise(resolve => setTimeout(resolve, batchIndex * batchDelay));
                }

                try {
                const response = await fetch(`${host}/guest-login`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'User-Agent': 'Frostfire-Forge-Benchmark-CLI/1.0'
                    }
                });

                if (response.status !== 301) {
                    const body = await response.json();
                    log(`Failed to create guest account: ${body.message}`, 'error');
                    return;
                }

                const body = await response.json();
                const token = body.token;
                if (!token) {
                    log('No token received from guest login', 'error');
                    return;
                }

                const websocket = new WebSocket(websocketUrl, {
                    headers: {
                        'User-Agent': 'Frostfire-Forge-Benchmark-CLI/1.0'
                    }
                });

                websocket.addEventListener('open', () => {
                    allWebsockets.push(websocket);
                    openedCount++;
                    updateConnectionStatus();

                    websocket.send(packet.encode(JSON.stringify({
                        type: "AUTH",
                        data: token,
                        language: "en"
                    })));

                    if (openedCount === amount && !stopped) {
                        startLoginTimeout();
                    }
                });

                const loginHandler = (event: any) => {
                    try {
                        const message = JSON.parse(packet.decode(event.data));
                        if (message.type === 'LOAD_MAP') {
                            loggedInCount++;
                            loggedInWebsockets.push(websocket);

                            updateConnectionStatus();
                            websocket.removeEventListener('message', loginHandler);

                            startKeepAlive(websocket);

                            const randomDelay = Math.floor(Math.random() * 10000);
                            startMovementSimulation(websocket, randomDelay);

                            if (loggedInCount === amount) {
                                clearTimeout(loginTimeout);
                                // Force final progress update to 100% before logging success
                                const finalBar = chalk.green('█'.repeat(50));
                                process.stdout.write(`\r  ${chalk.bold.green('Logging in:')} [${finalBar}] ${chalk.bold('100%')} ${chalk.white(amount)}${chalk.gray('/')}${chalk.white(amount)} clients\n`);
                                log(`All ${amount} clients logged in and moving`, 'success');
                                resolve(loggedInWebsockets);
                            }
                        }
                    } catch (e) {
                        // Ignore parse errors
                    }
                };
                websocket.addEventListener('message', loginHandler);

                websocket.addEventListener('error', () => {
                    log(`WebSocket connection error during login`, 'error');
                });

                websocket.addEventListener('close', (event: any) => {
                    if (loggedInCount < amount) {
                        log(`Client disconnected during login (Code: ${event.code})`, 'error');
                    }
                });
                } catch (error: any) {
                    log(`Error creating guest account: ${error.message}`, 'error');
                }
            })();

            clientPromises.push(clientPromise);
        }

        // Wait for all client creation attempts to complete
        await Promise.all(clientPromises);
    });
}

// Get latency statistics
function getLatencyStats() {
    if (latencyStats.samples.length === 0) {
        return { avg: 0, min: 0, max: 0, count: 0 };
    }
    const avg = Math.round(latencyStats.samples.reduce((a, b) => a + b, 0) / latencyStats.samples.length);
    const min = Math.round(Math.min(...latencyStats.samples));
    const max = Math.round(Math.max(...latencyStats.samples));
    return { avg, min, max, count: latencyStats.samples.length };
}

// Clean up websocket
function cleanupWebsocket(ws: any) {
    const intervals = websocketIntervals.get(ws);
    if (intervals?.timeSync) clearInterval(intervals.timeSync);
    websocketIntervals.delete(ws);

    const timeouts = pendingTimeouts.get(ws);
    if (timeouts) {
        timeouts.forEach(timeoutId => clearTimeout(timeoutId));
        pendingTimeouts.delete(ws);
    }

    latencyStats.lastSyncTimes.delete(ws);

    if (ws.readyState === 1) {
        ws.close();
    }
}

// Main benchmark function
async function runBenchmark(config: ReturnType<typeof parseArgs>) {
    console.log('\n' + chalk.bold.cyan('━'.repeat(60)));
    console.log(chalk.bold.cyan('  Frostfire Forge CLI Benchmark'));
    console.log(chalk.bold.cyan('━'.repeat(60)) + '\n');

    console.log(`  ${chalk.bold('Clients:')}  ${chalk.white(config.clients)}`);
    console.log(`  ${chalk.bold('Duration:')} ${chalk.white(config.duration + 's')}`);
    console.log(`  ${chalk.bold('Host:')}     ${chalk.blue(config.host)}`);
    console.log(`  ${chalk.bold('WS URL:')}   ${chalk.blue(config.websocketUrl)}`);

    // Show environment info
    if (process.env.DOMAIN || process.env.WEB_SOCKET_URL) {
        console.log('\n  ' + chalk.dim('Environment:'));
        if (process.env.DOMAIN) console.log(`  ${chalk.dim('DOMAIN:')} ${chalk.dim(process.env.DOMAIN)}`);
        if (process.env.WEB_SOCKET_URL) console.log(`  ${chalk.dim('WEB_SOCKET_URL:')} ${chalk.dim(process.env.WEB_SOCKET_URL)}`);
        if (process.env.WEB_SOCKET_PORT) console.log(`  ${chalk.dim('WEB_SOCKET_PORT:')} ${chalk.dim(process.env.WEB_SOCKET_PORT)}`);
    }
    console.log('\n' + chalk.gray('─'.repeat(60)) + '\n');

    log('Starting benchmark...', 'info');

    const startTime = Date.now();

    log(`Creating ${config.clients} guest accounts...`, 'info');
    const websockets = await createClients(config.clients, config.host, config.websocketUrl);
    const actualClientCount = websockets.length;

    console.log(''); // Add newline after connection progress

    if (stopped || actualClientCount === 0) {
        log('Benchmark aborted or no clients connected', 'error');
        return;
    }

    if (actualClientCount < config.clients) {
        log(`${actualClientCount}/${config.clients} clients logged in (${config.clients - actualClientCount} failed)`, 'warn');
    } else {
        log(`All ${actualClientCount} clients logged in`, 'success');
    }

    // Set up message handlers for latency tracking
    websockets.forEach((websocket: any) => {
        websocket.addEventListener('message', (event: any) => {
            try {
                const message = JSON.parse(packet.decode(event.data));
                if (message.type === 'TIME_SYNC') {
                    const sentTime = latencyStats.lastSyncTimes.get(websocket);
                    if (sentTime) {
                        const receiveTime = Date.now();
                        const latency = receiveTime - sentTime;
                        latencyStats.samples.push(latency);
                        if (latencyStats.samples.length > actualClientCount * 100) {
                            latencyStats.samples.shift();
                        }
                    }
                }
            } catch (e) {
                // Ignore parse errors
            }
        });

        websocket.addEventListener('close', (event: any) => {
            if (!stopped) {
                log(`Client disconnected (Code: ${event.code})`, 'warn');
            }
            cleanupWebsocket(websocket);
        });
    });

    log('Starting test timer in 3 seconds...', 'info');
    await new Promise(resolve => setTimeout(resolve, 3000));

    console.log('');
    log('Benchmark running...', 'info');
    console.log('');

    let elapsedSeconds = 0;
    const progressInterval = setInterval(() => {
        if (stopped) {
            clearInterval(progressInterval);
            return;
        }
        elapsedSeconds++;

        let activeConnections = 0;
        websockets.forEach((ws: any) => {
            if (ws.readyState === 1) activeConnections++;
        });

        const latency = getLatencyStats();

        // Clear previous line and draw progress
        process.stdout.write('\x1b[2K\r');
        drawProgress(elapsedSeconds, config.duration, activeConnections, actualClientCount, latency);
    }, 1000);

    // Wait for benchmark duration
    await new Promise(resolve => setTimeout(resolve, config.duration * 1000));

    stopped = true;
    clearInterval(progressInterval);

    // Draw final 100% progress before showing results
    let finalActiveConnections = 0;
    websockets.forEach((ws: any) => {
        if (ws.readyState === 1) finalActiveConnections++;
    });
    const finalLatencyDuringTest = getLatencyStats();
    process.stdout.write('\x1b[2K\r');
    drawProgress(config.duration, config.duration, finalActiveConnections, actualClientCount, finalLatencyDuringTest);
    console.log(''); // Add newline after final progress

    const endTime = Date.now();
    const totalTime = ((endTime - startTime) / 1000).toFixed(2);

    // Close all connections
    websockets.forEach((ws: any) => cleanupWebsocket(ws));

    const finalLatency = getLatencyStats();

    // Display results
    console.log('\n\n' + chalk.bold.green('━'.repeat(60)));
    console.log(chalk.bold.green('  Benchmark Complete'));
    console.log(chalk.bold.green('━'.repeat(60)) + '\n');

    console.log(`  ${chalk.bold('Test Duration:')} ${chalk.white(totalTime + 's')}`);

    if (actualClientCount < config.clients) {
        console.log(`  ${chalk.yellow('⚠')} Started with ${chalk.yellow(actualClientCount + '/' + config.clients)} clients ${chalk.gray('(' + (config.clients - actualClientCount) + ' failed to log in)')}`);
    }

    if (finalActiveConnections === actualClientCount) {
        console.log(`  ${chalk.green('✓')} All ${chalk.green(actualClientCount)} clients remained connected`);
    } else {
        const disconnected = actualClientCount - finalActiveConnections;
        console.log(`  ${chalk.yellow('⚠')} ${chalk.yellow(finalActiveConnections + '/' + actualClientCount)} clients connected at end ${chalk.gray('(' + disconnected + ' disconnected)')}`);
    }

    if (finalLatency.count > 0) {
        console.log(`\n  ${chalk.bold('Latency Statistics:')}`);

        // Color code average latency
        let avgColor = chalk.green;
        if (finalLatency.avg > 100) avgColor = chalk.yellow;
        if (finalLatency.avg > 200) avgColor = chalk.red;

        console.log(`    ${chalk.bold('Average:')} ${avgColor(finalLatency.avg + 'ms')}`);
        console.log(`    ${chalk.bold('Minimum:')} ${chalk.green(finalLatency.min + 'ms')}`);

        let maxColor = chalk.green;
        if (finalLatency.max > 200) maxColor = chalk.yellow;
        if (finalLatency.max > 500) maxColor = chalk.red;

        console.log(`    ${chalk.bold('Maximum:')} ${maxColor(finalLatency.max + 'ms')}`);
        console.log(`    ${chalk.bold('Samples:')} ${chalk.white(finalLatency.count.toLocaleString())}`);
    } else {
        console.log(`\n  ${chalk.yellow('⚠')} No latency data collected`);
    }

    console.log('\n' + chalk.gray('━'.repeat(60)) + '\n');
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
    stopped = true;
    process.exit(0);
});

// Run the benchmark
runBenchmark(config).then(() => {
    process.exit(0);
}).catch((error) => {
    log(`Benchmark failed: ${error.message}`, 'error');
    process.exit(1);
});
