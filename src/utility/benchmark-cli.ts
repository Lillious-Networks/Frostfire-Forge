#!/usr/bin/env bun

import chalk from 'chalk';
import crypto from 'crypto';

function parseArgs() {
    const args = process.argv.slice(2);

    const wsPort = process.env.WEB_SOCKET_PORT || '3000';
    const gatewayEnabled = process.env.GATEWAY_ENABLED === 'true';
    const defaultGatewayUrl = process.env.GATEWAY_URL || 'http://localhost:9999';

    const useSSL = process.env.WEB_SOCKET_USE_SSL === 'true';
    const defaultWebsocketUrl = `${useSSL ? 'wss' : 'ws'}://localhost:${wsPort}`;

    const httpHost = process.env.PUBLIC_HOST || process.env.SERVER_HOST || 'localhost';
    const httpProtocol = useSSL ? 'https' : 'http';
    const defaultHost = `${httpProtocol}://${httpHost}`;

    let effectiveHost = defaultHost;
    if (gatewayEnabled && defaultGatewayUrl) {

        const gatewayHostUrl = new URL(defaultGatewayUrl);
        effectiveHost = `${gatewayHostUrl.protocol}//${gatewayHostUrl.hostname}`;
    }

    const config = {
        clients: 50,
        duration: 60,
        websocketUrl: defaultWebsocketUrl,
        host: effectiveHost,
        gatewayEnabled: gatewayEnabled,
        gatewayUrl: defaultGatewayUrl,
        realmId: undefined as string | undefined,
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
            case '--ws':
                config.websocketUrl = args[++i] || defaultWebsocketUrl;
                break;
            case '--host':
                config.host = args[++i] || effectiveHost;
                break;
            case '--gateway':
                config.gatewayEnabled = true;
                break;
            case '--gateway-url':
                config.gatewayUrl = args[++i] || defaultGatewayUrl;
                config.gatewayEnabled = true;
                break;
            case '--realm':
                config.realmId = args[++i];
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
Frostfire Forge - CLI Benchmark Tool

Usage:
  bun --env-file=<env-file> src/utility/benchmark-cli.ts [options]

Options:
  --clients <number>     Number of concurrent clients (min: 1, default: 50, no limit)
  --duration <number>    Test duration in seconds (min: 10, default: 60, no limit)
  --host <url>          HTTP host URL for API calls (guest-login, etc.)
  --ws <url>            WebSocket URL (default: ws://localhost:3000 or wss:// if SSL enabled)
  --gateway             Enable gateway load balancer routing
  --gateway-url <url>   Gateway HTTP URL (default from GATEWAY_URL env or http://localhost:9999)
  --realm <id>          Specific realm/server ID to benchmark (optional)
  --help                Show this help message

Environment Variables:
  WEB_SOCKET_PORT       WebSocket port (default: 3000)
  WEB_SOCKET_USE_SSL    Use SSL for WebSocket (true/false)
  GATEWAY_ENABLED       Enable gateway routing (true/false)
  GATEWAY_URL           Gateway HTTP URL (e.g., http://localhost:9999)

Examples:
  # Direct connection with automatic realm selection (distributes clients across all realms)
  bun --env-file=.env.production src/utility/benchmark-cli.ts --clients 100 --duration 120

  # Benchmark a specific realm
  bun --env-file=.env.production src/utility/benchmark-cli.ts --clients 50 --realm server-1

  # Connect through gateway
  bun --env-file=.env.local src/utility/benchmark-cli.ts --clients 50 --gateway

  # Connect through gateway with custom URL
  bun --env-file=.env.local src/utility/benchmark-cli.ts --clients 100 --gateway-url ws://gateway.example.com:9000
`);
}

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

interface LatencyStats {
    samples: number[];
    lastSyncTimes: Map<any, number>;
}

const latencyStats: LatencyStats = {
    samples: [],
    lastSyncTimes: new Map()
};

const websocketIntervals = new Map<any, { timeSync: any }>();

const pendingTimeouts = new Map<any, Set<any>>();

let stopped = false;

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

async function fetchAvailableServers(host: string, isGateway: boolean): Promise<any[]> {
    try {

        const endpoint = isGateway ? '/status' : '/api/gateway/servers';
        const response = await fetch(`${host}${endpoint}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Frostfire-Forge-Benchmark-CLI/1.0'
            },
            signal: AbortSignal.timeout(10000)
        });

        if (!response.ok) {
            throw new Error(`Server list fetch failed: ${response.status}`);
        }

        const data = await response.json();
        return data.servers || [];
    } catch (error: any) {
        log(`Failed to fetch server list: ${error.message}`, 'warn');
        return [];
    }
}

function drawProgress(current: number, total: number, activeConnections: number, totalConnections: number, latency: any, barLength: number = 40) {
    const percentage = Math.min(100, Math.round((current / total) * 100));
    const filledLength = Math.round((barLength * current) / total);

    let barColor = chalk.green;
    if (percentage < 33) barColor = chalk.yellow;
    else if (percentage < 66) barColor = chalk.cyan;

    const filledBar = barColor('█'.repeat(filledLength));
    const emptyBar = chalk.gray('░'.repeat(barLength - filledLength));
    const bar = filledBar + emptyBar;

    const connectionRatio = activeConnections / totalConnections;
    let connectionColor = chalk.green;
    if (connectionRatio < 0.8) connectionColor = chalk.yellow;
    if (connectionRatio < 0.5) connectionColor = chalk.red;

    const connectionStatus = connectionColor(`${activeConnections}/${totalConnections}`);

    const timeDisplay = chalk.white(`${current}s`) + chalk.gray('/') + chalk.white(`${total}s`);

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

function startKeepAlive(websocket: any) {
    const sendTimeSync = () => {
        if (stopped || websocket.readyState !== 1) {
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

    sendTimeSync();

    const timeSyncInterval = setInterval(sendTimeSync, 5000);

    const intervals = websocketIntervals.get(websocket) || { timeSync: null };
    intervals.timeSync = timeSyncInterval;
    websocketIntervals.set(websocket, intervals);
}

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

async function createClients(amount: number, host: string, websocketUrl: string, config: ReturnType<typeof parseArgs>): Promise<any[]> {
    const allWebsockets: any[] = [];
    const loggedInWebsockets: any[] = [];

    let availableServers: any[] = [];
    if (config.gatewayEnabled) {

        availableServers = await fetchAvailableServers(config.gatewayUrl, true);
        if (availableServers.length > 0) {
            log(`Found ${availableServers.length} server(s) from gateway`, 'info');

            const firstServer = availableServers[0];
            log(`Server details: ${firstServer.id} - ${firstServer.useSSL ? 'wss' : 'ws'}://${firstServer.publicHost || firstServer.host}:${firstServer.wsPort}`, 'info');

            if (config.realmId) {
                const specificServer = availableServers.find(s => s.id === config.realmId);
                if (specificServer) {
                    availableServers = [specificServer];
                    log(`Using specific realm: ${config.realmId}`, 'info');
                } else {
                    log(`Realm '${config.realmId}' not found, using all available realms`, 'warn');
                }
            }
        } else {
            log('No servers found from gateway', 'warn');
        }
    } else {

        availableServers = await fetchAvailableServers(host, false);
        if (availableServers.length > 0) {
            log(`Found ${availableServers.length} available realm(s)`, 'info');

            if (config.realmId) {
                const specificServer = availableServers.find(s => s.id === config.realmId);
                if (specificServer) {
                    availableServers = [specificServer];
                    log(`Using specific realm: ${config.realmId}`, 'info');
                } else {
                    log(`Realm '${config.realmId}' not found, using all available realms`, 'warn');
                }
            }
        } else {
            log('No realms found, using default connection', 'warn');
        }
    }

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

        const clientPromises = [];
        const batchSize = 1;
        const batchDelay = 300;

        for (let i = 0; i < amount; i++) {
            const clientPromise = (async () => {

                const batchIndex = Math.floor(i / batchSize);
                if (batchIndex > 0) {
                    await new Promise(resolve => setTimeout(resolve, batchIndex * batchDelay));
                }

                try {
                const guestLoginUrl = `${host}/guest-login`;
                const response = await fetch(guestLoginUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'User-Agent': 'Frostfire-Forge-Benchmark-CLI/1.0'
                    },
                    signal: AbortSignal.timeout(15000)
                });

                const responseText = await response.text();

                if (response.status !== 301) {
                    try {
                        const body = JSON.parse(responseText);
                        log(`Failed to create guest account (${response.status}): ${body.message || 'Unknown error'}`, 'error');
                    } catch (parseError) {
                        log(`Failed to create guest account (${response.status}): ${responseText.substring(0, 100)}`, 'error');
                    }
                    return;
                }

                let body;
                try {
                    body = JSON.parse(responseText);
                } catch (parseError) {
                    log(`Failed to parse guest login response: ${responseText.substring(0, 100)}`, 'error');
                    return;
                }

                const token = body.token;
                if (!token) {
                    log('No token received from guest login', 'error');
                    return;
                }

                let finalWebsocketUrl = websocketUrl;
                if (availableServers.length > 0) {

                    const serverIndex = i % availableServers.length;
                    const selectedServer = availableServers[serverIndex];

                    const protocol = selectedServer.useSSL ? 'wss' : 'ws';
                    const hostName = selectedServer.publicHost?.replace(/^https?:\/\//, '') || selectedServer.host;
                    finalWebsocketUrl = `${protocol}://${hostName}:${selectedServer.wsPort}`;
                }

                const wsUrlWithAuth = new URL(finalWebsocketUrl);
                const connectionToken = crypto.randomBytes(32).toString('hex');
                const timestamp = Date.now().toString();
                const expiresAt = (Date.now() + 60000).toString();

                const sharedSecret = process.env.GATEWAY_GAME_SERVER_SECRET;
                if (!sharedSecret) {
                    log('GATEWAY_GAME_SERVER_SECRET environment variable is not set', 'error');
                    return;
                }
                const signature = crypto
                    .createHmac('sha256', sharedSecret)
                    .update(`${connectionToken}:${timestamp}:${expiresAt}`)
                    .digest('hex');

                wsUrlWithAuth.searchParams.set('token', connectionToken);
                wsUrlWithAuth.searchParams.set('timestamp', timestamp);
                wsUrlWithAuth.searchParams.set('expiresAt', expiresAt);
                wsUrlWithAuth.searchParams.set('signature', signature);

                if (i === 0) {
                    log(`Connecting to WebSocket: ${finalWebsocketUrl}`, 'info');
                }

                const websocket = new WebSocket(wsUrlWithAuth.toString());

                websocket.addEventListener('open', () => {
                    allWebsockets.push(websocket);
                    openedCount++;
                    updateConnectionStatus();

                    websocket.send(Buffer.from(packet.encode(JSON.stringify({
                        type: "AUTH",
                        data: token,
                        language: "en"
                    }))));

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
                            //startMovementSimulation(websocket, randomDelay);

                            if (loggedInCount === amount) {
                                clearTimeout(loginTimeout);

                                const finalBar = chalk.green('█'.repeat(50));
                                process.stdout.write(`\r  ${chalk.bold.green('Logging in:')} [${finalBar}] ${chalk.bold('100%')} ${chalk.white(amount)}${chalk.gray('/')}${chalk.white(amount)} clients\n`);
                                log(`All ${amount} clients logged in and moving`, 'success');
                                resolve(loggedInWebsockets);
                            }
                        }
                    } catch (e: any) {
                        console.error(chalk.red(`Error processing message for connection ${i}: ${e.message}`));
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
                    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
                        log(`Guest account creation timed out after 15s (possible database contention)`, 'error');
                    } else {
                        log(`Error creating guest account: ${error.message}`, 'error');
                    }
                }
            })();

            clientPromises.push(clientPromise);
        }

        await Promise.all(clientPromises);
    });
}

function getLatencyStats() {
    if (latencyStats.samples.length === 0) {
        return { avg: 0, min: 0, max: 0, count: 0 };
    }
    const avg = Math.round(latencyStats.samples.reduce((a, b) => a + b, 0) / latencyStats.samples.length);
    const min = Math.round(Math.min(...latencyStats.samples));
    const max = Math.round(Math.max(...latencyStats.samples));
    return { avg, min, max, count: latencyStats.samples.length };
}

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

async function runBenchmark(config: ReturnType<typeof parseArgs>) {
    console.log('\n' + chalk.bold.cyan('━'.repeat(60)));
    console.log(chalk.bold.cyan('  Frostfire Forge CLI Benchmark'));
    console.log(chalk.bold.cyan('━'.repeat(60)) + '\n');

    console.log(`  ${chalk.bold('Clients:')}  ${chalk.white(config.clients)}`);
    console.log(`  ${chalk.bold('Duration:')} ${chalk.white(config.duration + 's')}`);
    console.log(`  ${chalk.bold('Host:')}     ${chalk.blue(config.host)}`);

    if (config.gatewayEnabled) {
        console.log(`  ${chalk.bold('Gateway:')}  ${chalk.green('Enabled')} ${chalk.gray('→')} ${chalk.blue(config.gatewayUrl)}`);
        console.log(`  ${chalk.dim('Note:')} ${chalk.dim('Each client will be assigned to a server via gateway')}`);
    } else {
        console.log(`  ${chalk.bold('WS URL:')}   ${chalk.blue(config.websocketUrl)}`);
        console.log(`  ${chalk.bold('Gateway:')}  ${chalk.gray('Disabled')}`);
        if (config.realmId) {
            console.log(`  ${chalk.bold('Realm:')}    ${chalk.cyan(config.realmId)} ${chalk.dim('(specific)')}`);
        } else {
            console.log(`  ${chalk.bold('Realm:')}    ${chalk.cyan('Auto-select')} ${chalk.dim('(distributes across available realms)')}`);
        }
    }

    if (process.env.WEB_SOCKET_PORT || process.env.WEB_SOCKET_USE_SSL || process.env.GATEWAY_ENABLED) {
        console.log('\n  ' + chalk.dim('Environment:'));
        if (process.env.WEB_SOCKET_PORT) console.log(`  ${chalk.dim('WEB_SOCKET_PORT:')} ${chalk.dim(process.env.WEB_SOCKET_PORT)}`);
        if (process.env.WEB_SOCKET_USE_SSL) console.log(`  ${chalk.dim('WEB_SOCKET_USE_SSL:')} ${chalk.dim(process.env.WEB_SOCKET_USE_SSL)}`);
        if (process.env.GATEWAY_ENABLED) console.log(`  ${chalk.dim('GATEWAY_ENABLED:')} ${chalk.dim(process.env.GATEWAY_ENABLED)}`);
        if (process.env.GATEWAY_URL) console.log(`  ${chalk.dim('GATEWAY_URL:')} ${chalk.dim(process.env.GATEWAY_URL)}`);
    }
    console.log('\n' + chalk.gray('─'.repeat(60)) + '\n');

    log('Starting benchmark...', 'info');

    const startTime = Date.now();

    if (config.gatewayEnabled) {
        log(`Creating ${config.clients} guest accounts (via gateway)...`, 'info');
    } else {
        log(`Creating ${config.clients} guest accounts...`, 'info');
    }
    const websockets = await createClients(config.clients, config.host, config.websocketUrl, config);
    const actualClientCount = websockets.length;

    console.log('');

    if (stopped || actualClientCount === 0) {
        log('Benchmark aborted or no clients connected', 'error');
        return;
    }

    if (actualClientCount < config.clients) {
        log(`${actualClientCount}/${config.clients} clients logged in (${config.clients - actualClientCount} failed)`, 'warn');
    } else {
        log(`All ${actualClientCount} clients logged in`, 'success');
    }

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
            } catch (e: any) {
                console.error(chalk.red(`Error processing message for latency: ${e.message}`));
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

        process.stdout.write('\x1b[2K\r');
        drawProgress(elapsedSeconds, config.duration, activeConnections, actualClientCount, latency);
    }, 1000);

    await new Promise(resolve => setTimeout(resolve, config.duration * 1000));

    stopped = true;
    clearInterval(progressInterval);

    let finalActiveConnections = 0;
    websockets.forEach((ws: any) => {
        if (ws.readyState === 1) finalActiveConnections++;
    });
    const finalLatencyDuringTest = getLatencyStats();
    process.stdout.write('\x1b[2K\r');
    drawProgress(config.duration, config.duration, finalActiveConnections, actualClientCount, finalLatencyDuringTest);
    console.log('');

    const endTime = Date.now();
    const totalTime = ((endTime - startTime) / 1000).toFixed(2);

    websockets.forEach((ws: any) => cleanupWebsocket(ws));

    const finalLatency = getLatencyStats();

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

const config = parseArgs();

if (config.help) {
    showHelp();
    process.exit(0);
}

process.on('SIGINT', () => {
    console.log('\n\n' + chalk.yellow('⚠ Benchmark interrupted by user') + '\n');
    stopped = true;
    process.exit(0);
});

runBenchmark(config).then(() => {
    process.exit(0);
}).catch((error) => {
    log(`Benchmark failed: ${error.message}`, 'error');
    process.exit(1);
});
