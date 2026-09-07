#!/usr/bin/env bun

import chalk from 'chalk';
import { BenchmarkConnection, normalizeHost, setBenchmarkQuiet } from './benchmark-transport.ts';
import { serverFetch } from '../modules/https_servers.ts';

function parseArgs() {
    const args = process.argv.slice(2);

    const wtPort = process.env.WEBSRV_PORTSSL || process.env.GAME_PORT || '3000';
    const gatewayEnabled = process.env.GATEWAY_ENABLED === 'true';
    const defaultGatewayUrl = process.env.GATEWAY_URL || 'http://localhost:9999';

    const useSSL = process.env.HTTP_USE_SSL === 'true';
    const defaultTransportUrl = `https://localhost:${wtPort}`;

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
        durationSet: false,
        rate: 0,
        transportUrl: defaultTransportUrl,
        host: effectiveHost,
        gatewayEnabled: gatewayEnabled,
        gatewayUrl: defaultGatewayUrl,
        realmId: undefined as string | undefined,
        simulation: false,
        quiet: false,
        onClientLoggedIn: undefined as ((client: any) => void) | undefined,
        onClientFailed: undefined as (() => void) | undefined,
        shardIndex: 1,
        shardCount: 1,
        processes: 1,
        help: false
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        // Positional: first numeric arg is client count
        if (i === 0 && /^\d+$/.test(arg)) {
            config.clients = Math.max(1, parseInt(arg) || 50);
            continue;
        }

        switch (arg) {
            case '--clients':
                config.clients = Math.max(1, parseInt(args[++i]) || 50);
                break;
            case '--duration':
                config.duration = Math.max(10, parseInt(args[++i]) || 60);
                config.durationSet = true;
                break;
            case '--simulation':
                config.simulation = true;
                break;
            case '--wt':
                config.transportUrl = args[++i] || defaultTransportUrl;
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
                try {
                    const gwUrl = new URL(config.gatewayUrl);
                    config.host = `${gwUrl.protocol}//${gwUrl.hostname}`;
                } catch { /* keep existing host if URL is invalid */ }
                break;
            case '--rate':
                config.rate = Math.max(1, parseInt(args[++i]) || 5);
                break;
            case '--realm':
                config.realmId = args[++i];
                break;
            case '--processes':
            case '--procs': {
                // Fork the benchmark into N child processes, each driving an
                // equal slice of <player count>. One Bun process tops out
                // around a few thousand WT clients (its own event loop becomes
                // the bottleneck, not the server); spreading the load across
                // processes removes the client-side ceiling.
                config.processes = Math.max(1, Math.min(32, parseInt(args[++i]) || 1));
                break;
            }
            case '--shard': {
                // "M/N": this instance is shard M of N. Splits `clients` evenly
                // so several benchmark processes (or machines) can drive one
                // server without any single Bun process being the client-side
                // bottleneck. Each shard provisions and runs only its slice.
                const spec = args[++i] || "1/1";
                const [mStr, nStr] = spec.split("/");
                const n = Math.max(1, parseInt(nStr) || 1);
                const m = Math.min(n, Math.max(1, parseInt(mStr) || 1));
                config.shardIndex = m;
                config.shardCount = n;
                break;
            }
            case '--help':
                config.help = true;
                break;
        }
    }

    if (config.shardCount > 1) {
        const base = Math.floor(config.clients / config.shardCount);
        const remainder = config.clients % config.shardCount;
        // First `remainder` shards get one extra client.
        config.clients = base + (config.shardIndex <= remainder ? 1 : 0);
    }

    return config;
}

function showHelp() {
    console.log(`
Frostfire Forge - CLI Benchmark Tool

Usage:
  bun benchmark [player count] [options]
  bun benchmark:development <player count> [options]
  bun benchmark:production <player count> [options]

Positional Args:
  <player count>       Number of concurrent players (default: 50)

Options:
  --rate <conns/sec>  Connection rate per second (default: 3/sec, higher = faster ramp-up)
  --clients <number>  Number of concurrent clients (overrides positional, min: 1, default: 50)
  --duration <number> Test duration in seconds (min: 10, default: 60)
  --host <url>        HTTP host URL for API calls (guest-login, etc.)
  --wt <url>          WebTransport URL (default: https://localhost:3000)
  --gateway           Enable gateway load balancer routing
  --gateway-url <url> Gateway HTTP URL (default from GATEWAY_URL env or http://localhost:9999)
  --realm <id>        Specific realm/server ID to benchmark (optional)
  --processes <N>     Fork the benchmark into N child processes, each driving an equal
                      slice of <player count>, and print an aggregate summary. Use this
                      to get past the single-process client-side ceiling (~few thousand
                      WT clients per Bun process). e.g. --processes 4
  --shard <M/N>       (used internally by --processes) run as shard M of N
  --simulation        Simulate a realistic 5-minute daily login curve (slow times, peaks,
                      logins and logouts) instead of a fixed client count
  --duration <number> Override simulation span in seconds (default: 300)
  --help              Show this help message

Examples:
  bun benchmark 100
  bun benchmark 100 --rate 20
  bun benchmark 50 --duration 120
  bun benchmark:development 200 --gateway
  bun benchmark:production 500 --realm server-1 --duration 300
  bun benchmark 2000 --simulation
  bun benchmark 2000 --simulation --duration 600
`);
}

const packet = {
    encode(data: string): Uint8Array {
        const encoder = new TextEncoder();
        return encoder.encode(data);
    }
};

interface LatencyStats {
    // Server -> client one-way delivery, measured from server timestamps
    // piggybacked on movement datagrams. There is no client reply anywhere in
    // the latency path: TIME_SYNC was removed, and how fast a client answers
    // is not something we measure.
    udpOneWaySamples: number[];
    jitterSamples: number[];
    offsets: Map<any, number>;
    offsetCounts: Map<any, number>;
    lastUdpSeqs: Map<any, number>;
    lastUdpOneWay: Map<any, number>;
    udpLostFrames: number;
    udpExpectedFrames: number;
}

const latencyStats: LatencyStats = {
    udpOneWaySamples: [],
    jitterSamples: [],
    offsets: new Map(),
    offsetCounts: new Map(),
    lastUdpSeqs: new Map(),
    lastUdpOneWay: new Map(),
    udpLostFrames: 0,
    udpExpectedFrames: 0,
};

// Connection ramp-up (TLS/QUIC handshakes, guest-account writes, map loads)
// produces latency spikes that are not representative of steady-state. Samples
// collected before this timestamp are excluded from all summary statistics.
const LATENCY_WARMUP_MS = 10000;
let latencyWarmupUntil = 0;

// One-way latency measured from the server timestamps piggybacked on movement
// datagrams. Nothing here requires the client to answer the server.
//
// The clock offset is self-calibrated from those same datagrams rather than
// from SERVER_TIME, which is now sent only once at login and so cannot track
// clock skew over a long run.
//
// The offset is a floor estimate: it assumes the single fastest observed
// delivery was ~instant, so reported times are relative to the best observed
// path. True absolute one-way time needs a round trip, which we deliberately
// no longer do; what load testing needs is how delivery degrades under load,
// and that is exactly what this captures.
const MIN_OFFSET_SAMPLES_FOR_UDP = 5;

// Feed a server timestamp into the per-client clock-offset estimate.
function recordClockOffset(client: any, serverSendTime: number): void {
    const clientRecvTime = Date.now();
    // raw offset = client clock - server clock, inflated by network delay
    const rawOffset = clientRecvTime - serverSendTime;

    const previous = latencyStats.offsets.get(client);
    // Keep the MINIMUM observed offset: the sample with the least network delay
    // is closest to true clock skew. A rolling mean would drift upward under
    // load, masking the very latency we are trying to measure.
    const offset = previous === undefined ? rawOffset : Math.min(previous, rawOffset);

    latencyStats.offsets.set(client, offset);
    latencyStats.offsetCounts.set(client, (latencyStats.offsetCounts.get(client) ?? 0) + 1);
}

function recordUdpLatency(client: any, serverSendTime: number): void {
    // Every movement datagram also refines the clock offset. This must happen
    // before the warm-up gate so the estimate is already settled by the time
    // samples start being recorded.
    recordClockOffset(client, serverSendTime);

    // Skip connection warm-up like the stream metrics do
    if (Date.now() < latencyWarmupUntil) return;

    const offset = latencyStats.offsets.get(client);
    if (offset === undefined) return;
    if ((latencyStats.offsetCounts.get(client) ?? 0) < MIN_OFFSET_SAMPLES_FOR_UDP) return;

    const clientRecvTime = Date.now();
    const oneWay = Math.max(0, clientRecvTime - serverSendTime - offset);
    latencyStats.udpOneWaySamples.push(oneWay);
    if (latencyStats.udpOneWaySamples.length > 200000) {
        latencyStats.udpOneWaySamples.shift();
    }

    // Jitter: absolute change in one-way delivery between consecutive samples
    // for the same client (previously derived from TIME_SYNC RTT).
    const prevOneWay = latencyStats.lastUdpOneWay.get(client);
    if (prevOneWay !== undefined) {
        latencyStats.jitterSamples.push(Math.abs(oneWay - prevOneWay));
        if (latencyStats.jitterSamples.length > 200000) {
            latencyStats.jitterSamples.shift();
        }
    }
    latencyStats.lastUdpOneWay.set(client, oneWay);
}

function recordUdpBatchLatency(client: any, seq: number, serverSendTime: number): void {
    // Skip connection warm-up like the stream metrics do
    if (Date.now() < latencyWarmupUntil) return;

    recordUdpLatency(client, serverSendTime);

    const prevSeq = latencyStats.lastUdpSeqs.get(client);
    if (prevSeq !== undefined && seq > prevSeq + 1) {
        const lost = seq - prevSeq - 1;
        latencyStats.udpLostFrames += lost;
        latencyStats.udpExpectedFrames += lost;
    }
    latencyStats.lastUdpSeqs.set(client, seq);
    latencyStats.udpExpectedFrames++;
}

const movementStats = { starts: 0, aborts: 0, logouts: 0, abruptDisconnects: 0 };

// Base session lifetime for simulated clients, set to the simulation span by
// runSimulation (see the sessionUntil comment in startMovementSimulation).
let simulationLifetimeBaseMs = 300000;


const pendingTimeouts = new Map<any, Set<any>>();

const openClients = new Set<any>();

let stopped = false;

let quietMode = false;

function log(message: string, level: 'info' | 'error' | 'success' | 'warn' = 'info') {
    if (quietMode) return;

    const timestamp = chalk.gray(new Date().toLocaleTimeString());
    const prefix = {
        info: chalk.cyan('ℹ'),
        error: chalk.red('✖'),
        success: chalk.green('✓'),
        warn: chalk.yellow('⚠')
    }[level];
    console.log(`${timestamp} ${prefix} ${message}`);
}

async function fetchAvailableServers(host: string, quiet: boolean = false): Promise<any[]> {
    try {

        const endpoint = '/api/gateway/servers';
        const url = `${host}${endpoint}`;
        const response = await serverFetch(url, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Frostfire-Forge-Benchmark-CLI/1.0'
            },
            signal: AbortSignal.timeout(10000)
        });

        if (!response.ok) {
            const text = await response.text();
            log(`Server list HTTP ${response.status}: ${text.substring(0, 200)}`, 'warn');
            return [];
        }

        const text = await response.text();
        let data: any;
        try {
            data = JSON.parse(text);
        } catch {
            log(`Server list response not JSON (${response.status}): ${text.substring(0, 200)}`, 'warn');
            return [];
        }
        if (!quiet) {
            log(`Gateway servers response: ${JSON.stringify(data).substring(0, 300)}`, 'info');
        }
        if (Array.isArray(data)) return data;
        if (Array.isArray(data.servers)) return data.servers;
        return [];
    } catch (error: any) {
        log(`Failed to fetch server list from ${host}: ${error.message}`, 'warn');
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

// No keep-alive is sent. TIME_SYNC is gone, and the server treats an open QUIC
// session as proof of life, so clients need not send anything to stay
// connected. Latency comes entirely from server-pushed timestamps.

const packetMixStats = { select: 0, target: 0, inspect: 0, chat: 0, mount: 0 };

function startPacketMix(client: any, behavior: { position: { x: number; y: number } | null }) {
    if (!pendingTimeouts.has(client)) {
        pendingTimeouts.set(client, new Set());
    }

    const track = (fn: () => void, delayMs: number) => {
        const timer = setTimeout(() => {
            pendingTimeouts.get(client)?.delete(timer);
            if (stopped || client.readyState !== 1) return;
            fn();
        }, delayMs);
        pendingTimeouts.get(client)?.add(timer);
    };

    const jitter = (ms: number) => ms * (0.7 + Math.random() * 0.6);

    const mix: Array<{ min: number; max: number; send: () => void }> = [
        {
            min: 45000, max: 150000,
            send: () => {
                if (!behavior.position) return;
                client.send(packet.encode(JSON.stringify({
                    type: "SELECTPLAYER",
                    data: {
                        x: behavior.position.x + Math.round(Math.random() * 80 - 40),
                        y: behavior.position.y + Math.round(Math.random() * 80 - 40),
                    }
                })));
                packetMixStats.select++;
            },
        },
        {
            min: 30000, max: 120000,
            send: () => {
                client.send(packet.encode(JSON.stringify({ type: "TARGETCLOSEST" })));
                packetMixStats.target++;
            },
        },
        {
            min: 90000, max: 240000,
            send: () => {
                client.send(packet.encode(JSON.stringify({ type: "INSPECTPLAYER" })));
                packetMixStats.inspect++;
            },
        },
        {
            min: 120000, max: 300000,
            send: () => {
                client.send(packet.encode(JSON.stringify({ type: "CHAT", data: { message: "hello" } })));
                packetMixStats.chat++;
            },
        },
        {
            min: 120000, max: 240000,
            send: () => {
                client.send(packet.encode(JSON.stringify({ type: "MOUNT", data: { mount: "unicorn" } })));
                packetMixStats.mount++;
            },
        },
    ];

    for (const entry of mix) {
        const loop = () => {
            if (stopped || client.readyState !== 1) return;
            entry.send();
            track(loop, jitter(entry.min + Math.random() * (entry.max - entry.min)));
        };
        track(loop, jitter(entry.min + Math.random() * (entry.max - entry.min)));
    }
}

function startMovementSimulation(client: any, initialDelay: number = 0) {
    const directions = ['up', 'down', 'left', 'right', 'upleft', 'upright', 'downleft', 'downright'];

    if (!pendingTimeouts.has(client)) {
        pendingTimeouts.set(client, new Set());
    }

    const behavior = {
        position: null as { x: number; y: number } | null,
        home: null as { x: number; y: number } | null,
        state: 'idle' as string,
        // Session lifetimes scale with the simulation span (1-3x the duration).
        // Short fixed lifetimes churn the population faster than the connection
        // rate can replenish it, capping max concurrency below the target.
        sessionUntil: Date.now() + (simulationLifetimeBaseMs + Math.random() * simulationLifetimeBaseMs * 2),
    };

    // Track own position from 0x02 MOVEXY echo datagrams (server echoes mover
    // position every tick) and one-way UDP latency from the trailing server
    // timestamps piggybacked on movement frames (0x02 echoes and 0x01 batches).
    // SERVER_TIME also arrives as a datagram and supplies the clock offset.
    client.onDatagram((bytes: Uint8Array) => {
        if (bytes.length < 11) return;

        if (bytes[0] === 0x02) {
            const view = new DataView(bytes.buffer, bytes.byteOffset, 11);
            const x = view.getInt16(5, true);
            const y = view.getInt16(7, true);
            behavior.position = { x, y };
            if (!behavior.home) behavior.home = { x, y };

            if (bytes.length >= 17) {
                const seconds = new DataView(bytes.buffer, bytes.byteOffset + 11, 4).getUint32(0, true);
                const ms = new DataView(bytes.buffer, bytes.byteOffset + 15, 2).getUint16(0, true);
                recordUdpLatency(client, seconds * 1000 + ms);
            }
            return;
        }

        if (bytes[0] === 0x01) {
            const view = new DataView(bytes.buffer, bytes.byteOffset);
            const count = view.getUint16(1, true);
            const entriesEnd = 3 + count * 9;
            if (bytes.length >= entriesEnd + 10) {
                const seq = view.getUint32(entriesEnd, true);
                const seconds = view.getUint32(entriesEnd + 4, true);
                const ms = view.getUint16(entriesEnd + 8, true);
                recordUdpBatchLatency(client, seq, seconds * 1000 + ms);
            }
            return;
        }

        // JSON datagram. SERVER_TIME is a 1Hz one-way push carrying the
        // server's Date.now(); it is the clock reference for the one-way
        // latency math, and needs no reply from us.
        if (bytes[0] === 0x7B) {
            try {
                const message = JSON.parse(new TextDecoder().decode(bytes));
                if (message.type === 'SERVER_TIME' && typeof message.data === 'number') {
                    recordClockOffset(client, message.data);
                }
            } catch {
                // Not JSON after all - ignore
            }
        }
    });

    const track = (fn: () => void, delayMs: number) => {
        const timer = setTimeout(() => {
            pendingTimeouts.get(client)?.delete(timer);
            if (stopped || client.readyState !== 1) return;
            fn();
        }, delayMs);
        pendingTimeouts.get(client)?.add(timer);
    };

    const jitter = (ms: number) => ms * (0.7 + Math.random() * 0.6);

    const sendMove = (dir: string) => {
        client.send(packet.encode(JSON.stringify({ type: "MOVEXY", data: dir })));
        movementStats.starts++;
    };

    const sendAbort = () => {
        client.send(packet.encode(JSON.stringify({ type: "MOVEXY", data: "abort" })));
        movementStats.aborts++;
    };

    const randomDirection = () => directions[Math.floor(Math.random() * directions.length)];

    const directionToward = (from: { x: number; y: number }, to: { x: number; y: number }): string | null => {
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const adx = Math.abs(dx);
        const ady = Math.abs(dy);
        if (adx < 48 && ady < 48) return null;
        let dir: string;
        if (adx > ady * 2) {
            dir = dx > 0 ? 'right' : 'left';
        } else if (ady > adx * 2) {
            dir = dy > 0 ? 'down' : 'up';
        } else {
            dir = (dy > 0 ? 'down' : 'up') + (dx > 0 ? 'right' : 'left');
        }
        return dir;
    };

    const startState = () => {
        if (stopped || client.readyState !== 1) return;

        if (Date.now() >= behavior.sessionUntil) {
            // End of session: clean logout 70%, abrupt disconnect 30%
            if (Math.random() < 0.7) {
                client.send(packet.encode(JSON.stringify({ type: "LOGOUT" })));
                movementStats.logouts++;
            } else {
                movementStats.abruptDisconnects++;
            }
            track(() => {
                if (client.readyState === 1) cleanupClient(client);
            }, jitter(500 + Math.random() * 2000));
            return;
        }

        const roll = Math.random();
        if (roll < 0.45) {
            // Idle / AFK - the dominant state for real players
            const longAfk = Math.random() < 0.08;
            behavior.state = 'idle';
            track(() => startState(), jitter(longAfk ? 90000 + Math.random() * 150000 : 8000 + Math.random() * 60000));
        } else if (roll < 0.70) {
            // Wander: short random walk
            behavior.state = 'wander';
            sendMove(randomDirection());
            track(() => {
                sendAbort();
                startState();
            }, jitter(2000 + Math.random() * 6000));
        } else if (roll < 0.88) {
            // Return home: gravitate back toward spawn/hub (creates hotspot clustering)
            if (!behavior.position || !behavior.home) {
                startState();
                return;
            }
            const dir = directionToward(behavior.position, behavior.home);
            if (!dir) {
                startState();
                return;
            }
            behavior.state = 'return';
            sendMove(dir);
            track(() => {
                sendAbort();
                startState();
            }, jitter(4000 + Math.random() * 6000));
        } else {
            // Movement burst: 2-5 quick direction changes (questing-like)
            behavior.state = 'burst';
            const steps = 2 + Math.floor(Math.random() * 4);
            let remaining = steps;
            const step = () => {
                if (remaining <= 0) {
                    sendAbort();
                    startState();
                    return;
                }
                remaining--;
                sendMove(randomDirection());
                track(() => {
                    sendAbort();
                    step();
                }, jitter(800 + Math.random() * 1600));
            };
            step();
        }
    };

    startPacketMix(client, behavior);

    track(() => startState(), jitter(initialDelay));
}

let cachedAvailableServers: Promise<any[]> | null = null;

async function getAvailableServers(host: string, gatewayEnabled: boolean, gatewayUrl: string, realmId?: string, quiet: boolean = false): Promise<any[]> {
    if (!cachedAvailableServers) {
        cachedAvailableServers = (async () => {
            let servers: any[] = [];
            if (gatewayEnabled) {
                servers = await fetchAvailableServers(gatewayUrl, quiet);
                if (servers.length > 0 && !quiet) {
                    log(`Found ${servers.length} server(s) from gateway`, 'info');
                } else if (!quiet) {
                    log('No servers found from gateway', 'warn');
                }
            } else {
                servers = await fetchAvailableServers(host, quiet);
                if (servers.length > 0 && !quiet) {
                    log(`Found ${servers.length} available realm(s)`, 'info');
                } else if (!quiet) {
                    log('No realms found, using default connection', 'warn');
                }
            }

            if (realmId) {
                const specificServer = servers.find(s => s.id === realmId);
                if (specificServer) {
                    servers = [specificServer];
                    if (!quiet) log(`Using specific realm: ${realmId}`, 'info');
                } else if (!quiet) {
                    log(`Realm '${realmId}' not found, using all available realms`, 'warn');
                }
            }

            return servers;
        })();
    }

    return await cachedAvailableServers;
}

// Provision guest accounts up front via the gateway's bulk endpoint instead of
// one /guest-login (≈15 serialised SQL round-trips) per client. At multi-thousand
// client counts the per-request path saturates the gateway DB worker pool and
// clients time out during login (1000 close). The bulk endpoint batches the
// whole set into a handful of multi-row INSERTs; we request in chunks so a
// single response stays a reasonable size.
async function provisionGuestTokens(amount: number, host: string): Promise<string[]> {
    const secret = process.env.GATEWAY_GAME_SERVER_SECRET;
    if (!secret) {
        log('GATEWAY_GAME_SERVER_SECRET environment variable is not set', 'error');
        return [];
    }

    const CHUNK = 500;
    const tokens: string[] = [];
    let logged = false;

    for (let offset = 0; offset < amount; offset += CHUNK) {
        const count = Math.min(CHUNK, amount - offset);
        try {
            const response = await serverFetch(`${host}/guest-bulk`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Benchmark-Secret': secret,
                    'User-Agent': 'Frostfire-Forge-Benchmark-CLI/1.0',
                },
                body: JSON.stringify({ count }),
                signal: AbortSignal.timeout(60000),
            });

            const text = await response.text();
            if (response.status !== 200) {
                let msg = text.substring(0, 200);
                try { msg = JSON.parse(text).message || msg; } catch { /* raw */ }
                log(`Bulk guest provisioning failed (${response.status}): ${msg}`, 'error');
                return tokens;
            }

            const body = JSON.parse(text);
            if (!Array.isArray(body.tokens)) {
                log('Bulk guest provisioning returned no tokens', 'error');
                return tokens;
            }
            tokens.push(...body.tokens);

            if (!logged) {
                log(`Provisioning ${amount} guest accounts (bulk, ${CHUNK}/request)...`, 'info');
                logged = true;
            }
        } catch (error: any) {
            log(`Bulk guest provisioning error: ${error.message}`, 'error');
            return tokens;
        }
    }

    return tokens;
}

async function createClients(amount: number, host: string, clientUrl: string, config: ReturnType<typeof parseArgs>): Promise<any[]> {
    const allClients: any[] = [];
    const loggedInClients: any[] = [];

    // The wave settles only when every client attempt reaches a terminal
    // state: LOAD_MAP received, closed before login, failed, or the login
    // timeout fires. Resolving on connect alone would let the simulation
    // overshoot its target while LOAD_MAP responses are still in flight.
    let resolveLoggedIn!: (clients: any[]) => void;
    const loginCompletion = new Promise<any[]>((resolve) => { resolveLoggedIn = resolve; });

    const availableServers = await getAvailableServers(host, config.gatewayEnabled, config.gatewayUrl, config.realmId, config.quiet);

        const guestTokens = await provisionGuestTokens(amount, host);
        if (guestTokens.length < amount) {
            log(`Only provisioned ${guestTokens.length}/${amount} guest tokens - continuing with what we have`, 'warn');
        }
        if (guestTokens.length === 0) {
            resolveLoggedIn([]);
            return await loginCompletion;
        }

        let openedCount = 0;
        let loggedInCount = 0;
        let settledCount = 0;
        const settledIndexes = new Set<number>();
        let loginTimeout: any = null;
        let lastUpdateTime = 0;

        const settleClient = (index: number) => {
            if (settledIndexes.has(index)) return;
            settledIndexes.add(index);
            settledCount++;
            if (settledCount === amount) {
                if (loginTimeout) clearTimeout(loginTimeout);
                resolveLoggedIn(loggedInClients);
            }
        };

        const updateConnectionStatus = () => {
            if (config.quiet) return;

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

                    allClients.forEach(client => {
                        if (!loggedInClients.includes(client) && client.readyState === 1) {
                            client.close();
                        }
                    });

                    log(`${loggedInCount}/${amount} clients logged in - proceeding`, 'info');
                }
                resolveLoggedIn(loggedInClients);
            }, 30000);
        };

        const clientPromises = [];
        const batchSize = 1;
        const batchDelay = config.rate > 0 ? Math.round(1000 / config.rate) : 300;

        // Only as many clients as we have tokens for. All the settle/progress
        // bookkeeping below is keyed off `amount`, so narrow it here.
        amount = Math.min(amount, guestTokens.length);

        for (let i = 0; i < amount; i++) {
            const clientPromise = (async () => {

                const batchIndex = Math.floor(i / batchSize);
                if (batchIndex > 0) {
                    await new Promise(resolve => setTimeout(resolve, batchIndex * batchDelay));
                }

                try {
                const token = guestTokens[i];

                let finalTransportUrl = clientUrl;
                if (availableServers.length > 0) {

                    const serverIndex = i % availableServers.length;
                    const selectedServer = availableServers[serverIndex];

                    const hostName = selectedServer.publicHost?.replace(/^https?:\/\//, '') || selectedServer.host;
                    finalTransportUrl = `https://${normalizeHost(hostName)}:${selectedServer.wtPort || 3000}`;
                } else if (config.gatewayEnabled) {
                    try {
                        const gwUrl = new URL(config.gatewayUrl);
                        finalTransportUrl = `https://${gwUrl.hostname}:${process.env.WEBSRV_PORTSSL || process.env.GAME_PORT || '3000'}`;
                    } catch { /* keep default clientUrl */ }
                }

                const sharedSecret = process.env.GATEWAY_GAME_SERVER_SECRET;
                if (!sharedSecret) {
                    log('GATEWAY_GAME_SERVER_SECRET environment variable is not set', 'error');
                    return;
                }

                if (i === 0 && !config.quiet) {
                    log(`Connecting to WebTransport: ${finalTransportUrl}`, 'info');
                }

                const client = await BenchmarkConnection.connect(finalTransportUrl, sharedSecret, 'Frostfire-Forge-Benchmark-CLI/1.0');

                allClients.push(client);
                openClients.add(client);
                openedCount++;
                updateConnectionStatus();

                const loginHandler = (rawMessage: string) => {
                    try {
                        const message = JSON.parse(rawMessage);
                        if (message.type === 'LOAD_MAP') {
                            loggedInCount++;
                            loggedInClients.push(client);

                            updateConnectionStatus();
                            client.offMessage(loginHandler);

                            if (config.onClientLoggedIn) {
                                config.onClientLoggedIn(client);
                            }

                            settleClient(i);

                            const randomDelay = Math.floor(Math.random() * 10000);
                            startMovementSimulation(client, randomDelay);

                            if (loggedInCount === amount && !config.quiet) {
                                const finalBar = chalk.green('█'.repeat(50));
                                process.stdout.write(`\r  ${chalk.bold.green('Logging in:')} [${finalBar}] ${chalk.bold('100%')} ${chalk.white(amount)}${chalk.gray('/')}${chalk.white(amount)} clients\n`);
                                log(`All ${amount} clients logged in and moving`, 'success');
                            }
                        }
                    } catch (e: any) {
                        if (!quietMode) {
                            console.error(chalk.red(`Error processing message for connection ${i}: ${e.message}`));
                        }
                    }
                };
                client.onMessage(loginHandler);

                client.onClose((code: number) => {
                    if (loggedInCount < amount && !config.quiet) {
                        log(`Client disconnected during login (Code: ${code})`, 'error');
                    }
                    settleClient(i);
                });

                client.send(packet.encode(JSON.stringify({
                    type: "AUTH",
                    data: token,
                    language: "en"
                })));

                if (openedCount === amount && !stopped) {
                    startLoginTimeout();
                }
                } catch (error: any) {
                    if (config.onClientFailed) {
                        config.onClientFailed();
                    }
                    log(`Error connecting client: ${error.message}`, 'error');
                    settleClient(i);
                }
            })();

            clientPromises.push(clientPromise);
        }

        await Promise.allSettled(clientPromises);

        return await loginCompletion;
}

// All latency figures describe SERVER -> CLIENT delivery. There is no RTT: the
// engine no longer round-trips anything with the client, and how quickly a
// client answers is not a property of server performance.
function getLatencyStats() {
    const samples = latencyStats.udpOneWaySamples;
    const stats: any = {
        avg: 0, min: 0, max: 0, p95: 0, p99: 0,
        count: samples.length,
        jitterAvg: 0,
        udpLostFrames: latencyStats.udpLostFrames,
        udpExpectedFrames: latencyStats.udpExpectedFrames,
    };

    if (samples.length > 0) {
        stats.avg = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
        stats.min = Math.round(Math.min(...samples));
        stats.max = Math.round(Math.max(...samples));
        const sorted = [...samples].sort((a, b) => a - b);
        stats.p95 = Math.round(sorted[Math.floor(sorted.length * 0.95)]);
        stats.p99 = Math.round(sorted[Math.floor(sorted.length * 0.99)]);
    }

    if (latencyStats.jitterSamples.length > 0) {
        stats.jitterAvg = Math.round(latencyStats.jitterSamples.reduce((a, b) => a + b, 0) / latencyStats.jitterSamples.length);
    }

    return stats;
}

function cleanupClient(client: any) {
    const timeouts = pendingTimeouts.get(client);
    if (timeouts) {
        timeouts.forEach(timeoutId => clearTimeout(timeoutId));
        pendingTimeouts.delete(client);
    }

    latencyStats.offsets.delete(client);
    latencyStats.offsetCounts.delete(client);
    latencyStats.lastUdpSeqs.delete(client);
    latencyStats.lastUdpOneWay.delete(client);

    if (client.readyState === 1) {
        client.close();
    }
    openClients.delete(client);
}

function closeAllClients() {
    stopped = true;
    for (const client of openClients) {
        try {
            client.close();
        } catch (error: any) {
            if (!quietMode) {
                console.debug("Benchmark client close failed:", error);
            }
        }
    }
}

const SIMULATION_SEGMENTS: Array<{ start: number; end: number; from: number; to: number; label: string }> = [
    { start: 0.00, end: 0.10, from: 0.05, to: 0.20, label: 'Early morning' },
    { start: 0.10, end: 0.20, from: 0.20, to: 0.15, label: 'Mid-morning dip' },
    { start: 0.20, end: 0.40, from: 0.15, to: 0.70, label: 'Lunch ramp' },
    { start: 0.40, end: 0.50, from: 0.70, to: 1.00, label: 'Peak buildup' },
    // The peak is HELD at 100% for the full peak phase, then declines.
    { start: 0.50, end: 0.70, from: 1.00, to: 1.00, label: 'Peak hours' },
    { start: 0.70, end: 0.85, from: 1.00, to: 0.30, label: 'Evening decline' },
    { start: 0.85, end: 1.00, from: 0.30, to: 0.10, label: 'Late night' },
];

function simulateTargetFraction(t: number): { fraction: number; phase: string } {
    for (const seg of SIMULATION_SEGMENTS) {
        if (t <= seg.end) {
            const progress = (t - seg.start) / (seg.end - seg.start);
            return { fraction: seg.from + (seg.to - seg.from) * progress, phase: seg.label };
        }
    }
    return { fraction: 0.10, phase: 'Late night' };
}

let pendingConnects = 0;
let totalLogins = 0;
let loginSuccesses = 0;
let totalLogouts = 0;
let maxConcurrent = 0;

function countActiveConnections(): number {
    let active = 0;
    for (const client of openClients) {
        if (client.readyState === 1) active++;
    }
    return active;
}

function attachSimulationHandlers(client: any) {
    client.onMessage((rawMessage: string) => {
        try {
            if (!rawMessage || rawMessage.trim().length === 0) {
                return;
            }

            const message = JSON.parse(rawMessage);

            if (message.type === 'SERVER_TIME' && typeof message.data === 'number') {
                recordClockOffset(client, message.data);
            }
        } catch (e: any) {
            if (!(e instanceof SyntaxError) && !quietMode) {
                console.error(chalk.red(`Error processing message for latency: ${e.message}`));
            }
        }
    });

    client.onClose((_code: number) => {
        if (!stopped) {
            totalLogouts++;
        }
        cleanupClient(client);
    });
}

async function connectWave(count: number, config: ReturnType<typeof parseArgs>): Promise<void> {
    if (count <= 0 || stopped) return;

    pendingConnects += count;
    totalLogins += count;

    let settled = 0;
    const settleOne = () => {
        settled++;
        pendingConnects = Math.max(0, pendingConnects - 1);
    };

    const waveConfig: ReturnType<typeof parseArgs> = {
        ...config,
        rate: config.rate > 0 ? config.rate : 25,
        quiet: true,
        onClientLoggedIn: (client: any) => {
            settleOne();
            loginSuccesses++;
            attachSimulationHandlers(client);
        },
        onClientFailed: () => {
            settleOne();
        },
    };

    try {
        await createClients(count, waveConfig.host, waveConfig.transportUrl, waveConfig);
    } catch (error) {
        // Ignore errors, settle remaining connections
    } finally {
        while (settled < count) settleOne();
    }
}

function disconnectRandomClients(count: number): void {
    if (count <= 0) return;

    const candidates: any[] = [];
    for (const client of openClients) {
        if (client.readyState === 1) candidates.push(client);
    }

    if (candidates.length === 0) return;

    const toDisconnect = candidates.sort(() => Math.random() - 0.5).slice(0, Math.min(count, candidates.length));

    for (const client of toDisconnect) {
        totalLogouts++;
        cleanupClient(client);
    }
}

async function runSimulation(config: ReturnType<typeof parseArgs>) {
    const peakClients = config.clients;

    // Fixed connection rate: bigger populations take longer to connect, the
    // rate itself never scales with the total required.
    const connectionRate = config.rate > 0 ? config.rate : 25;

    // The connection rate must cover three demands at the peak:
    // 1. the curve's steepest segment (peak buildup: 30% of the peak over 10%
    //    of the span -> 3.0 * peak / duration)
    // 2. natural session expiry (avg lifetime = 2x the duration -> 0.5 *
    //    peak / duration)
    // 3. churn (0.2%/s of the active population)
    // A 15% margin is applied so the demand never sits exactly at the cap
    // (any pipeline hiccup then causes a shortfall that never recovers).
    const MAX_SEGMENT_SLOPE = 3.5;
    const CHURN_PER_SEC_FRACTION = 0.002;
    const RATE_MARGIN = 0.85;
    const sustainableRate = connectionRate * RATE_MARGIN - CHURN_PER_SEC_FRACTION * peakClients;
    let duration: number;
    let durationStretched = false;

    if (sustainableRate <= 0) {
        // Even churn alone exceeds the configured rate; the peak is unreachable
        // at any duration.
        duration = config.durationSet ? config.duration : 300;
        log(`Warning: churn (${CHURN_PER_SEC_FRACTION * peakClients}/s) alone exceeds the connection rate (${connectionRate}/s) - the peak will not be reached`, 'warn');
    } else {
        const minDurationForRate = Math.ceil((peakClients * MAX_SEGMENT_SLOPE) / sustainableRate);
        const requestedDuration = config.durationSet ? config.duration : 300;
        duration = Math.max(requestedDuration, minDurationForRate);
        durationStretched = duration > requestedDuration;
    }

    simulationLifetimeBaseMs = duration * 1000;

    console.log('\n' + chalk.bold.cyan('-'.repeat(60)));
    console.log(chalk.bold.cyan('  Frostfire Forge CLI Benchmark - Simulation Mode'));
    console.log(chalk.bold.cyan('-'.repeat(60)) + '\n');

    console.log(`  ${chalk.bold('Peak clients:')} ${chalk.white(peakClients)}`);
    console.log(`  ${chalk.bold('Duration:')}     ${chalk.white(duration + 's')} ${chalk.gray(durationStretched ? `(stretched to ${connectionRate}/sec)` : '(5-minute daily curve)')}`);
    console.log(`  ${chalk.bold('Curve:')}       ${chalk.white('early-morning → lunch ramp → peak → evening decline')}`);
    console.log(`  ${chalk.bold('Host:')}         ${chalk.blue(config.host)}`);
    console.log(`  ${chalk.bold('Rate:')}         ${config.rate > 0 ? chalk.white(config.rate + '/sec') : chalk.gray('default (25/sec)')}`);

    if (config.gatewayEnabled) {
        console.log(`  ${chalk.bold('Gateway:')}      ${chalk.green('Enabled')} ${chalk.gray('→')} ${chalk.blue(config.gatewayUrl)}`);
    }

    console.log('\n' + chalk.gray('─'.repeat(60)) + '\n');

    quietMode = true;
    setBenchmarkQuiet(true);

    log('Starting simulation...', 'info');

    const startTime = Date.now();
    latencyWarmupUntil = startTime + LATENCY_WARMUP_MS;

    const initialWave = Math.min(Math.round(peakClients * 0.05), connectionRate);
    log(`Initial population: ${Math.round(peakClients * 0.05)} clients (5% of peak) at ${connectionRate}/sec`, 'info');
    connectWave(initialWave, config);

    let lastProgressDraw = 0;
    let lastTickAt = Date.now();
    let lastTargetFraction = 0;

    const tick = () => {
        if (stopped) return;

        const now = Date.now();
        // Compensate for event-loop lag in the benchmark process itself: at
        // thousands of sessions the 1s timer can fire late, and a lagged tick
        // would otherwise spawn just one wave instead of one per missed second.
        const secondsSinceLastTick = Math.min(Math.max((now - lastTickAt) / 1000, 1), 5);
        lastTickAt = now;

        const elapsed = (now - startTime) / 1000;
        const t = Math.min(elapsed / duration, 1);
        const { fraction } = simulateTargetFraction(t);
        const target = Math.max(0, Math.round(peakClients * fraction));

        // The peak must be MAINTAINED for the whole peak phase: while the
        // curve is at 100% (flat peak) or still rising, never tear down active
        // clients - pending logins will settle into the gap on their own.
        // Disconnects are only used to follow genuine curve declines.
        const isPeakPhase = fraction === 1;
        const isDeclining = fraction < lastTargetFraction;
        lastTargetFraction = fraction;

        const active = countActiveConnections();
        if (active > maxConcurrent) maxConcurrent = active;

        if (!isPeakPhase) {
            // Churn is a fixed 0.2%/s of the population - do NOT scale it by
            // the tick lag (lag compensation is for the wave cap only).
            const churn = Math.max(1, Math.round(active * 0.002));
            disconnectRandomClients(Math.floor(Math.random() * (churn + 1)));
            const churnReconnects = Math.floor(Math.random() * (churn + 1));
            if (churnReconnects > 0) connectWave(Math.min(churnReconnects, Math.max(1, Math.floor(connectionRate / 2) * secondsSinceLastTick)), config);
        }

        // Keep the login pipeline SATURATED without overshooting the target:
        // in-flight logins (pendingConnects) count toward the target, so demand
        // is the gap above active AND pending. Overshooting the peak was
        // caused by requesting the full active-gap while logins were already
        // in flight.
        const MAX_PENDING_CONNECTS = Math.max(connectionRate * 30, 300);
        const want = target - countActiveConnections() - pendingConnects;
        const roomInPipeline = Math.max(0, MAX_PENDING_CONNECTS - pendingConnects);
        const waveCap = Math.max(1, Math.round(connectionRate * secondsSinceLastTick));

        if (want > 0 && roomInPipeline > 0) {
            connectWave(Math.min(want, roomInPipeline, waveCap), config);
        } else if (isDeclining || isPeakPhase) {
            // Trim only the excess above the target (in-flight included) so
            // the population settles exactly on the curve - including the
            // flat peak, which must hold the target without overshoot.
            const excess = countActiveConnections() + pendingConnects - target;
            if (excess > 0) {
                disconnectRandomClients(excess);
            }
        }

        if (now - lastProgressDraw >= 1000) {
            lastProgressDraw = now;
            process.stdout.write('\x1b[2K\r');
            drawProgress(Math.floor(elapsed), duration, countActiveConnections(), peakClients, getLatencyStats());
        }
    };

    tick();
    const tickInterval = setInterval(tick, 1000);

    await new Promise(resolve => setTimeout(resolve, duration * 1000));

    clearInterval(tickInterval);
    stopped = true;
    closeAllClients();

    process.stdout.write('\x1b[2K\r');
    drawProgress(duration, duration, countActiveConnections(), peakClients, getLatencyStats());
    console.log('');

    quietMode = false;
    setBenchmarkQuiet(false);

    const endTime = Date.now();
    const totalTime = ((endTime - startTime) / 1000).toFixed(2);
    const finalLatency = getLatencyStats();

    console.log('\n\n' + chalk.bold.green('-'.repeat(60)));
    console.log(chalk.bold.green('  Simulation Complete'));
    console.log(chalk.bold.green('-'.repeat(60)) + '\n');

    console.log(`  ${chalk.bold('Test Duration:')}       ${chalk.white(totalTime + 's')}`);
    console.log(`  ${chalk.bold('Peak Target:')}         ${chalk.white(peakClients)}`);
    console.log(`  ${chalk.bold('Max Concurrent:')}      ${chalk.white(maxConcurrent)}`);
    console.log(`  ${chalk.bold('Total Login Attempts:')} ${chalk.white(totalLogins.toLocaleString())}`);
    console.log(`  ${chalk.bold('Successful Logins:')}    ${chalk.white(loginSuccesses.toLocaleString())}`);
    console.log(`  ${chalk.bold('Logouts/Disconnects:')}  ${chalk.white(totalLogouts.toLocaleString())}`);

    printLatencySummary(finalLatency);

    console.log('\n' + chalk.gray('-'.repeat(60)) + '\n');
}

function printLatencySummary(latency: any) {
    if (latency.count <= 0) {
        console.log(`\n  ${chalk.yellow('⚠')} No latency data collected`);
        return;
    }

    console.log(`\n  ${chalk.bold('Latency Statistics:')}`);

    let avgColor = chalk.green;
    if (latency.avg > 100) avgColor = chalk.yellow;
    if (latency.avg > 200) avgColor = chalk.red;

    console.log(`    ${chalk.bold('One-way Average:')} ${avgColor(latency.avg + 'ms')}`);
    console.log(`    ${chalk.bold('One-way Minimum:')} ${chalk.green(latency.min + 'ms')}`);

    let maxColor = chalk.green;
    if (latency.max > 200) maxColor = chalk.yellow;
    if (latency.max > 500) maxColor = chalk.red;

    console.log(`    ${chalk.bold('One-way Maximum:')} ${maxColor(latency.max + 'ms')}`);
    if (latency.p95 > 0) {
        console.log(`    ${chalk.bold('One-way p95:')} ${chalk.white(latency.p95 + 'ms')} ${chalk.dim('|')} ${chalk.bold('p99:')} ${chalk.white(latency.p99 + 'ms')}`);
    }
    console.log(`    ${chalk.bold('Samples:')}     ${chalk.white(latency.count.toLocaleString())}`);

    if (latency.jitterAvg > 0) {
        console.log(`    ${chalk.bold('Jitter (mean |Δone-way|):')} ${chalk.white(latency.jitterAvg + 'ms')}`);
    }
    if (latency.udpExpectedFrames > 0) {
        const udpLossPercent = ((latency.udpLostFrames / latency.udpExpectedFrames) * 100).toFixed(2);
        const udpLossColor = latency.udpLostFrames === 0 ? chalk.green : chalk.yellow;
        console.log(`    ${chalk.bold('Movement datagram loss:')} ${udpLossColor(`${latency.udpLostFrames}/${latency.udpExpectedFrames} (${udpLossPercent}%)`)}`);
    }
}

async function runBenchmark(config: ReturnType<typeof parseArgs>) {
    if (config.simulation) {
        await runSimulation(config);
        return;
    }

    console.log('\n' + chalk.bold.cyan('-'.repeat(60)));
    console.log(chalk.bold.cyan('  Frostfire Forge CLI Benchmark'));
    console.log(chalk.bold.cyan('-'.repeat(60)) + '\n');

    console.log(`  ${chalk.bold('Clients:')}  ${chalk.white(config.clients)}${config.shardCount > 1 ? chalk.gray(`  (shard ${config.shardIndex}/${config.shardCount})`) : ''}`);
    console.log(`  ${chalk.bold('Duration:')} ${chalk.white(config.duration + 's')}`);
    console.log(`  ${chalk.bold('TLS:')}      ${chalk.green('Required (WebTransport)')}`);
    console.log(`  ${chalk.bold('Rate:')}     ${config.rate > 0 ? chalk.white(config.rate + '/sec') : chalk.gray('default (3/sec)')}`);
    console.log(`  ${chalk.bold('Host:')}     ${chalk.blue(config.host)}`);

    if (config.gatewayEnabled) {
        console.log(`  ${chalk.bold('Gateway:')}  ${chalk.green('Enabled')} ${chalk.gray('→')} ${chalk.blue(config.gatewayUrl)}`);
        console.log(`  ${chalk.dim('Note:')} ${chalk.dim('Each client will be assigned to a server via gateway')}`);
    } else {
        console.log(`  ${chalk.bold('Transport URL:')} ${chalk.blue(config.transportUrl)}`);
        console.log(`  ${chalk.bold('Gateway:')}  ${chalk.gray('Disabled')}`);
        if (config.realmId) {
            console.log(`  ${chalk.bold('Realm:')}    ${chalk.cyan(config.realmId)} ${chalk.dim('(specific)')}`);
        } else {
            console.log(`  ${chalk.bold('Realm:')}    ${chalk.cyan('Auto-select')} ${chalk.dim('(distributes across available realms)')}`);
        }
    }

    console.log('\n' + chalk.gray('─'.repeat(60)) + '\n');

    log('Starting benchmark...', 'info');

    const startTime = Date.now();

    if (config.gatewayEnabled) {
        log(`Creating ${config.clients} guest accounts (via gateway)...`, 'info');
    } else {
        log(`Creating ${config.clients} guest accounts...`, 'info');
    }
    const clients = await createClients(config.clients, config.host, config.transportUrl, config);
    const actualClientCount = clients.length;

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

    clients.forEach((client: any) => {
        client.onMessage((rawMessage: string) => {
            try {
                if (!rawMessage || rawMessage.trim().length === 0) {
                    return;
                }

                const message = JSON.parse(rawMessage);

                if (message.type === 'SERVER_TIME' && typeof message.data === 'number') {
                    recordClockOffset(client, message.data);
                }
            } catch (e: any) {
                if (e instanceof SyntaxError) {
                    return;
                }
                console.error(chalk.red(`Error processing message for latency: ${e.message}`));
            }
        });

        client.onClose((code: number) => {
            if (!stopped) {
                log(`Client disconnected (Code: ${code})`, 'warn');
            }
            cleanupClient(client);
        });
    });

    log('Starting test timer in 3 seconds...', 'info');
    await new Promise(resolve => setTimeout(resolve, 3000));

    latencyWarmupUntil = Date.now() + LATENCY_WARMUP_MS;

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
        clients.forEach((client: any) => {
            if (client.readyState === 1) activeConnections++;
        });

        const latency = getLatencyStats();

        process.stdout.write('\x1b[2K\r');
        drawProgress(elapsedSeconds, config.duration, activeConnections, actualClientCount, latency);
    }, 1000);

    await new Promise(resolve => setTimeout(resolve, config.duration * 1000));

    stopped = true;
    clearInterval(progressInterval);

    let finalActiveConnections = 0;
    clients.forEach((client: any) => {
        if (client.readyState === 1) finalActiveConnections++;
    });
    const finalLatencyDuringTest = getLatencyStats();
    process.stdout.write('\x1b[2K\r');
    drawProgress(config.duration, config.duration, finalActiveConnections, actualClientCount, finalLatencyDuringTest);
    console.log('');

    const endTime = Date.now();
    const totalTime = ((endTime - startTime) / 1000).toFixed(2);

    clients.forEach((client: any) => cleanupClient(client));

    const finalLatency = getLatencyStats();

    console.log('\n\n' + chalk.bold.green('-'.repeat(60)));
    console.log(chalk.bold.green('  Benchmark Complete'));
    console.log(chalk.bold.green('-'.repeat(60)) + '\n');

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

    printLatencySummary(finalLatency);
    emitShardResult(finalLatency, actualClientCount, finalActiveConnections);

    console.log('\n' + chalk.gray('-'.repeat(60)) + '\n');
}

const config = parseArgs();

if (config.help) {
    showHelp();
    process.exit(0);
}

const RESULT_MARKER = '##BENCHRESULT##';

// Child (sharded) processes emit their raw stats on one line for the parent
// orchestrator to aggregate. Only when actually running as a shard-of-many.
function emitShardResult(latency: any, startedClients: number, connectedAtEnd: number) {
    if (config.shardCount <= 1) return;
    console.log(RESULT_MARKER + ' ' + JSON.stringify({
        shard: config.shardIndex,
        oneWaySamples: latencyStats.udpOneWaySamples,
        jitterSamples: latencyStats.jitterSamples,
        udpLostFrames: latency.udpLostFrames,
        udpExpectedFrames: latency.udpExpectedFrames,
        startedClients,
        connectedAtEnd,
    }));
}

async function runOrchestrator() {
    const n = config.processes;
    const passthroughArgs = process.argv.slice(2).filter((a, i, arr) => {
        if (a === '--processes' || a === '--procs') return false;
        if ((arr[i - 1] === '--processes' || arr[i - 1] === '--procs')) return false;
        return true;
    });

    console.log('\n' + chalk.bold.cyan('-'.repeat(60)));
    console.log(chalk.bold.cyan(`  Frostfire Forge CLI Benchmark  ${chalk.gray(`(${n} processes)`)}`));
    console.log(chalk.bold.cyan('-'.repeat(60)) + '\n');
    console.log(`  ${chalk.bold('Total clients:')} ${chalk.white(config.clients)}  ${chalk.gray(`≈ ${Math.floor(config.clients / n)}/process`)}`);
    console.log(`  ${chalk.bold('Processes:')}     ${chalk.white(n)}\n`);

    const colors = [chalk.cyan, chalk.magenta, chalk.yellow, chalk.green, chalk.blue, chalk.red, chalk.white, chalk.gray];
    const results: any[] = [];
    const children: any[] = [];

    const spawns = [];
    for (let i = 1; i <= n; i++) {
        const color = colors[(i - 1) % colors.length];
        const tag = color(`[p${i}]`);
        const childArgs = [import.meta.path, ...passthroughArgs, '--shard', `${i}/${n}`];
        const proc = Bun.spawn(['bun', ...childArgs], {
            stdout: 'pipe',
            stderr: 'pipe',
            env: { ...process.env, FORCE_COLOR: '1' },
        });
        children.push(proc);

        const pump = async (stream: ReadableStream<Uint8Array>) => {
            const reader = stream.getReader();
            const decoder = new TextDecoder();
            let buf = '';
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                let nl;
                while ((nl = buf.indexOf('\n')) !== -1) {
                    const line = buf.slice(0, nl);
                    buf = buf.slice(nl + 1);
                    const marker = line.indexOf(RESULT_MARKER);
                    if (marker !== -1) {
                        try { results.push(JSON.parse(line.slice(marker + RESULT_MARKER.length))); } catch { /* ignore */ }
                        continue;
                    }
                    console.log(`${tag} ${line}`);
                }
            }
        };

        spawns.push((async () => {
            await Promise.all([pump(proc.stdout as any), pump(proc.stderr as any)]);
            await proc.exited;
        })());
    }

    process.on('SIGINT', () => {
        console.log('\n\n' + chalk.yellow('⚠ Interrupted - terminating child processes') + '\n');
        for (const c of children) { try { c.kill(); } catch { /* ignore */ } }
        setTimeout(() => process.exit(0), 500);
    });

    await Promise.all(spawns);

    // Aggregate
    const allOneWay: number[] = [];
    const allJitter: number[] = [];
    let lost = 0, expected = 0, started = 0, connected = 0;
    for (const r of results) {
        allOneWay.push(...(r.oneWaySamples || []));
        allJitter.push(...(r.jitterSamples || []));
        lost += r.udpLostFrames || 0;
        expected += r.udpExpectedFrames || 0;
        started += r.startedClients || 0;
        connected += r.connectedAtEnd || 0;
    }

    console.log('\n' + chalk.bold.cyan('-'.repeat(60)));
    console.log(chalk.bold.cyan(`  Aggregate Results  ${chalk.gray(`(${results.length}/${n} processes reported)`)}`));
    console.log(chalk.bold.cyan('-'.repeat(60)) + '\n');

    if (allOneWay.length === 0) {
        console.log(chalk.yellow('  No latency samples collected across processes.'));
    } else {
        const sorted = [...allOneWay].sort((a, b) => a - b);
        const avg = Math.round(allOneWay.reduce((a, b) => a + b, 0) / allOneWay.length);
        const jitterAvg = allJitter.length
            ? Math.round(allJitter.reduce((a, b) => a + b, 0) / allJitter.length) : 0;
        const lossPct = expected > 0 ? ((lost / expected) * 100).toFixed(2) : '0.00';
        console.log(`    ${chalk.bold('Clients started:')}   ${chalk.white(started)}`);
        console.log(`    ${chalk.bold('Connected at end:')}  ${chalk.white(connected)}`);
        console.log(`    ${chalk.bold('One-way Average:')}   ${chalk.white(avg + 'ms')}`);
        console.log(`    ${chalk.bold('One-way Minimum:')}   ${chalk.white(sorted[0] + 'ms')}`);
        console.log(`    ${chalk.bold('One-way Maximum:')}   ${chalk.white(sorted[sorted.length - 1] + 'ms')}`);
        console.log(`    ${chalk.bold('One-way p95:')}       ${chalk.white(sorted[Math.floor(sorted.length * 0.95)] + 'ms')} ${chalk.dim('|')} ${chalk.bold('p99:')} ${chalk.white(sorted[Math.floor(sorted.length * 0.99)] + 'ms')}`);
        console.log(`    ${chalk.bold('Samples:')}           ${chalk.white(allOneWay.length.toLocaleString())}`);
        console.log(`    ${chalk.bold('Jitter:')}            ${chalk.white(jitterAvg + 'ms')}`);
        const lossColor = lost === 0 ? chalk.green : (parseFloat(lossPct) > 2 ? chalk.red : chalk.yellow);
        console.log(`    ${chalk.bold('Movement datagram loss:')} ${lossColor(`${lost}/${expected} (${lossPct}%)`)}`);
    }
    console.log('\n' + chalk.gray('-'.repeat(60)) + '\n');
    process.exit(0);
}

if (config.processes > 1 && config.shardCount <= 1) {
    // Orchestrator mode: fork N children, each a --shard of the total.
    await runOrchestrator().catch((e) => {
        log(`Orchestrator failed: ${e.message}`, 'error');
        process.exit(1);
    });
} else {
    process.on('SIGINT', () => {
        console.log('\n\n' + chalk.yellow('⚠ Benchmark interrupted by user') + '\n');
        closeAllClients();
        setTimeout(() => process.exit(0), 500);
    });

    runBenchmark(config).then(() => {
        setTimeout(() => process.exit(0), 500);
    }).catch((error) => {
        log(`Benchmark failed: ${error.message}`, 'error');
        process.exit(1);
    });
}
