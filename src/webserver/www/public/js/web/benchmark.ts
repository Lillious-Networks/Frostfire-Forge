const clients = document.getElementById('clients') as HTMLInputElement;
const clientsLabel = document.getElementById('clients-label') as HTMLLabelElement;
const duration = document.getElementById('duration') as HTMLInputElement;
const durationLabel = document.getElementById('duration-label') as HTMLLabelElement;
const start = document.getElementById('start') as HTMLButtonElement;
const result = document.getElementById('result') as HTMLParagraphElement;
const stop = document.getElementById('stop') as HTMLButtonElement;
const progressWrapper = document.getElementById('progress-wrapper') as HTMLDivElement;
const progressBar = document.getElementById('progress-bar') as HTMLDivElement;
const progressText = document.getElementById('progress-text') as HTMLSpanElement;
const progressPercentage = document.getElementById('progress-percentage') as HTMLSpanElement;
let stopped = false;
let errored = false;

// Write logs to the logs element
const logs = document.getElementById('logs') as HTMLParagraphElement;
function logMessage(message: string) {
    logs.style.display = 'block';
    const timestamp = new Date().toLocaleTimeString();
    logs.innerHTML += `<p>[${timestamp}] ${message}</p>`;
    logs.scrollTop = logs.scrollHeight; // Auto-scroll to the bottom
}

console.error = (message?: any, ...optionalParams: any[]) => {
    logMessage(typeof message === 'string' ? message : JSON.stringify(message));
    if (optionalParams.length > 0) {
        optionalParams.forEach(param => {
            logMessage(typeof param === 'string' ? param : JSON.stringify(param));
        });
    }
}

const packet = {
    decode(data: ArrayBuffer) {
      const decoder = new TextDecoder();
      return decoder.decode(data);
    },
    encode(data: string) {
      const encoder = new TextEncoder();
      return encoder.encode(data);
    },
  };

if (!duration || !durationLabel || !start || !result || !clients) {
    throw new Error('Element not found');
}

// Update progress bar
function updateProgress(elapsed: number, total: number): void {
    const percentage = Math.min(100, Math.round((elapsed / total) * 100));
    progressBar.style.width = `${percentage}%`;
    progressText.innerText = `${elapsed}s / ${total}s elapsed`;
    progressPercentage.innerText = `${percentage}%`;
}

// Initialize inputs with default values
clients.value = '50';
clientsLabel.innerText = `Clients: ${clients.value}`;
duration.value = '60';
durationLabel.innerText = `Duration: ${duration.value}s`;

// Update clients label on input
clients.addEventListener('input', () => {
    clientsLabel.innerText = `Clients: ${clients.value}`;
});

// Update duration label on input
duration.addEventListener('input', () => {
    durationLabel.innerText = `Duration: ${duration.value}s`;
});

// Start button logic
const connections = new Map<string, WebSocket[]>();
const websocketIntervals = new Map<WebSocket, { timeSync: any, movement: any }>();

// Latency tracking
const latencyStats = {
    samples: [] as number[],
    lastSyncTimes: new Map<WebSocket, number>()
};

start.addEventListener('click', async () => {
    if (start.disabled) return; // If the start button is disabled, do not run the benchmark
    start.disabled = true; // Disable the start button
    stop.disabled = false; // Enable the stop button
    clients.disabled = true; // Disable the clients input
    duration.disabled = true; // Disable the duration input
    result.style.display = 'block';
    result.innerHTML = '';
    stopped = false;

    // Clear previous intervals and stats
    websocketIntervals.clear();
    latencyStats.samples = [];
    latencyStats.lastSyncTimes.clear();

    // Clear logs from previous test
    logs.innerHTML = '';
    logs.style.display = 'none';

    const clientsValue = parseInt(clients.value);
    const durationValue = parseInt(duration.value);

    // Show and initialize progress bar
    progressWrapper.classList.add('active');
    updateProgress(0, durationValue);

    // Function to start TIME_SYNC (keeps connection alive and tracks latency)
    function startKeepAlive(websocket: WebSocket) {
        const sendTimeSync = () => {
            if (stopped || websocket.readyState !== WebSocket.OPEN) {
                const intervals = websocketIntervals.get(websocket);
                if (intervals?.timeSync) clearInterval(intervals.timeSync);
                return;
            }

            // Track when we send the TIME_SYNC
            const sendTime = Date.now();
            latencyStats.lastSyncTimes.set(websocket, sendTime);

            websocket.send(
                packet.encode(
                    JSON.stringify({
                        type: "TIME_SYNC",
                        data: sendTime
                    })
                )
            );
        };

        // Send first TIME_SYNC immediately
        sendTimeSync();

        // Then send TIME_SYNC every 5 seconds
        const timeSyncInterval = setInterval(sendTimeSync, 5000);

        const intervals = websocketIntervals.get(websocket) || { timeSync: null, movement: null };
        intervals.timeSync = timeSyncInterval;
        websocketIntervals.set(websocket, intervals);
    }

    // Function to start movement simulation
    // Pattern: Move for 1 second, abort, wait 1 second, repeat (2 second cycle)
    function startMovementSimulation(websocket: WebSocket) {
        const directions = ['up', 'down', 'left', 'right', 'upleft', 'upright', 'downleft', 'downright'];
        let movementInterval: any = null;

        const movementCycle = () => {
            if (stopped || websocket.readyState !== WebSocket.OPEN) {
                if (movementInterval) clearInterval(movementInterval);
                return;
            }

            // Pick a random direction and send movement packet
            const randomDirection = directions[Math.floor(Math.random() * directions.length)];
            websocket.send(
                packet.encode(
                    JSON.stringify({
                        type: "MOVEXY",
                        data: randomDirection
                    })
                )
            );

            // After 1 second, send ABORT packet
            setTimeout(() => {
                if (stopped || websocket.readyState !== WebSocket.OPEN) return;

                websocket.send(
                    packet.encode(
                        JSON.stringify({
                            type: "MOVEXY",
                            data: "abort"
                        })
                    )
                );
            }, 1000);
        };

        // Start the first cycle immediately
        movementCycle();

        // Repeat every 2 seconds
        movementInterval = setInterval(movementCycle, 2000);

        const intervals = websocketIntervals.get(websocket) || { timeSync: null, movement: null };
        intervals.movement = movementInterval;
        websocketIntervals.set(websocket, intervals);
    }

    async function createClients(amount: number): Promise<WebSocket[]> {
        const allWebsockets: WebSocket[] = [];
        const loggedInWebsockets: WebSocket[] = [];

        return new Promise((resolve, reject) => {
            let openedCount = 0;
            let loggedInCount = 0;
            let loginTimeout: any = null;
            let lastUpdateTime = 0;

            // Throttled UI update function - updates at most every 150ms
            const updateConnectionStatus = () => {
                const now = Date.now();
                if (now - lastUpdateTime < 150) return; // Throttle to 150ms
                lastUpdateTime = now;

                if (stopped) {
                    result.innerHTML = 'Stopping benchmark...';
                } else if (openedCount < amount) {
                    result.innerText = `Connecting: ${openedCount} / ${amount} clients`;
                } else if (loggedInCount < amount) {
                    result.innerText = `Connected ${openedCount} clients | Logging in: ${loggedInCount} / ${amount}`;
                }
            };

            // Timeout after 30 seconds - proceed with whoever logged in
            const startLoginTimeout = () => {
                loginTimeout = setTimeout(() => {
                    if (loggedInCount < amount) {
                        logMessage(`Login timeout: Only ${loggedInCount}/${amount} clients logged in successfully`);

                        // Close websockets that didn't log in
                        allWebsockets.forEach(ws => {
                            if (!loggedInWebsockets.includes(ws) && ws.readyState === WebSocket.OPEN) {
                                ws.close();
                            }
                        });

                        // Force final update
                        lastUpdateTime = 0;
                        updateConnectionStatus();
                        resolve(loggedInWebsockets);
                    }
                }, 30000); // 30 second timeout
            };

            for (let i = 0; i < amount; i++) {
                // Create a guest account first
                fetch('/guest-login', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                }).then(async (response) => {
                    if (response.status !== 301) {
                        const body = await response.json();
                        logMessage(`Failed to create guest account: ${body.message}`);
                        return;
                    }

                    // Extract token from response body
                    const body = await response.json();
                    const token = body.token;
                    if (!token) {
                        logMessage('No token received from guest login');
                        return;
                    }

                    // Now create websocket and authenticate
                    const websocket = new WebSocket('__VAR.WEBSOCKETURL__');
                    websocket.binaryType = "arraybuffer";

                    websocket.onopen = () => {
                        allWebsockets.push(websocket);
                        openedCount++;
                        updateConnectionStatus();

                        // Send AUTH packet to log in the guest player
                        websocket.send(
                            packet.encode(
                                JSON.stringify({
                                    type: "AUTH",
                                    data: token,
                                    language: "en"
                                })
                            )
                        );

                        if (openedCount === amount) {
                            if (!stopped) {
                                // Start timeout once all connections are open
                                startLoginTimeout();
                            }
                        }
                    };

                    // Listen for login success
                    const loginHandler = (event: any) => {
                        if (!(event.data instanceof ArrayBuffer)) return;
                        const message = JSON.parse(packet.decode(event.data));
                        if (message.type === 'LOAD_MAP') {
                            // Player successfully logged in and loaded into game
                            loggedInCount++;
                            loggedInWebsockets.push(websocket);

                            updateConnectionStatus();
                            websocket.removeEventListener('message', loginHandler);

                            // Start TIME_SYNC immediately to keep connection alive
                            startKeepAlive(websocket);

                            if (loggedInCount === amount) {
                                clearTimeout(loginTimeout);
                                // Force final update to show completion
                                lastUpdateTime = 0;
                                result.innerText = `All ${amount} clients logged in successfully`;
                                resolve(loggedInWebsockets);
                            }
                        }
                    };
                    websocket.addEventListener('message', loginHandler);

                    websocket.onerror = (error) => {
                        logMessage(`WebSocket connection error during login`);
                    };

                    websocket.onclose = (event) => {
                        if (loggedInCount < amount) {
                            logMessage(`Client disconnected during login (Code: ${event.code})`);
                        }
                    };
                }).catch((error) => {
                    logMessage(`Error creating guest account: ${error.message}`);
                });
            }
        });
    }

    const websockets = await createClients(clientsValue) as WebSocket[];
    const actualClientCount = websockets.length;

    if (stopped) {
        websockets.forEach(ws => ws.close());
        progressWrapper.classList.remove('active');
        result.innerHTML = 'Benchmark aborted';
        setTimeout(() => {
            result.style.display = 'none';
            result.innerHTML = '';
            reset();
        }, 3000);
        return;
    }

    if (actualClientCount === 0) {
        result.innerHTML = 'No clients successfully logged in. Benchmark aborted.';
        progressWrapper.classList.remove('active');
        setTimeout(() => {
            result.style.display = 'none';
            result.innerHTML = '';
            reset();
        }, 3000);
        return;
    }

    // All clients are now logged in, wait a moment before starting movement
    if (actualClientCount < clientsValue) {
        result.innerText = `${actualClientCount} guests logged in (${clientsValue - actualClientCount} failed). Starting benchmark in 3 seconds...`;
        logMessage(`Starting benchmark with ${actualClientCount}/${clientsValue} clients`);
    } else {
        result.innerText = `All ${actualClientCount} guests logged in. Starting benchmark in 3 seconds...`;
    }

    // Wait 3 seconds to ensure all clients are fully loaded on server side
    await new Promise(resolve => setTimeout(resolve, 3000));

    if (stopped) {
        websockets.forEach(ws => ws.close());
        progressWrapper.classList.remove('active');
        result.innerHTML = 'Benchmark aborted';
        setTimeout(() => {
            result.style.display = 'none';
            result.innerHTML = '';
            reset();
        }, 3000);
        return;
    }

    // Now start movement simulation for all guests
    websockets.forEach((websocket: WebSocket) => {
        startMovementSimulation(websocket);
    });

    const startTime = Date.now();
    websockets.forEach((websocket: WebSocket) => {
        const id = Math.random().toString(36).substring(7);
        connections.set(id, [websocket]);

        // Handle incoming messages to track latency
        websocket.onmessage = (event: any) => {
            if (!(event.data instanceof ArrayBuffer)) return;
            try {
                const message = JSON.parse(packet.decode(event.data));
                if (message.type === 'TIME_SYNC') {
                    // Calculate latency
                    const sentTime = latencyStats.lastSyncTimes.get(websocket);
                    if (sentTime) {
                        const receiveTime = Date.now();
                        const latency = receiveTime - sentTime;
                        latencyStats.samples.push(latency);
                        // Keep only last 100 samples per client to avoid memory issues
                        if (latencyStats.samples.length > actualClientCount * 100) {
                            latencyStats.samples.shift();
                        }
                    }
                }
            } catch (e) {
                // Ignore parse errors
            }
        };

        websocket.onerror = (error) => {
            if (stopped) return;
            console.error("WebSocket error:", error);
            logMessage(`Client ${id} encountered an error`);
        };

        websocket.onclose = (event) => {
            connections.delete(id);
            // Clean up intervals
            const intervals = websocketIntervals.get(websocket);
            if (intervals?.timeSync) clearInterval(intervals.timeSync);
            if (intervals?.movement) clearInterval(intervals.movement);
            websocketIntervals.delete(websocket);
            latencyStats.lastSyncTimes.delete(websocket);

            if (!stopped) {
                // Log the disconnection with the reason
                const reason = event.reason || 'Unknown reason';
                const code = event.code;
                logMessage(`Client ${id} disconnected (Code: ${code}, Reason: ${reason})`);
            }
        };
    });

    // Helper function to calculate latency stats
    function getLatencyStats() {
        if (latencyStats.samples.length === 0) {
            return { avg: 0, min: 0, max: 0, count: 0 };
        }
        const avg = Math.round(latencyStats.samples.reduce((a, b) => a + b, 0) / latencyStats.samples.length);
        const min = Math.round(Math.min(...latencyStats.samples));
        const max = Math.round(Math.max(...latencyStats.samples));
        return { avg, min, max, count: latencyStats.samples.length };
    }

    // Progress timer - updates every second
    let elapsedSeconds = 0;
    const progressInterval = setInterval(() => {
        if (stopped) {
            clearInterval(progressInterval);
            return;
        }
        elapsedSeconds++;

        // Count actual open connections
        let activeConnections = 0;
        websockets.forEach(ws => {
            if (ws.readyState === WebSocket.OPEN) {
                activeConnections++;
            }
        });

        // Get current latency stats
        const latency = getLatencyStats();

        updateProgress(elapsedSeconds, durationValue);
        if (latency.count > 0) {
            result.innerText = `Running: ${elapsedSeconds}s / ${durationValue}s - ${activeConnections}/${actualClientCount} clients | Latency: ${latency.avg}ms (min: ${latency.min}ms, max: ${latency.max}ms)`;
        } else {
            result.innerText = `Running: ${elapsedSeconds}s / ${durationValue}s - ${activeConnections}/${actualClientCount} clients | Waiting for latency data...`;
        }
    }, 1000);

    // End benchmark after duration
    setTimeout(() => {
        if (stopped) return;
        clearInterval(progressInterval);

        const endTime = Date.now();
        const totalTime = ((endTime - startTime) / 1000).toFixed(2);

        // Count final active connections
        let finalActiveConnections = 0;
        websockets.forEach(ws => {
            if (ws.readyState === WebSocket.OPEN) {
                finalActiveConnections++;
            }
        });

        // Close all connections and clean up intervals
        websockets.forEach(ws => {
            const intervals = websocketIntervals.get(ws);
            if (intervals?.timeSync) clearInterval(intervals.timeSync);
            if (intervals?.movement) clearInterval(intervals.movement);
            websocketIntervals.delete(ws);
            if (ws.readyState === WebSocket.OPEN) {
                ws.close();
            }
        });
        connections.clear();

        // Hide progress bar
        progressWrapper.classList.remove('active');

        // Get final latency stats
        const finalLatency = getLatencyStats();

        // Show results
        const connectionStatus = finalActiveConnections === actualClientCount
            ? `<p style="color: #4CAF50;">✓ All ${actualClientCount} clients remained connected</p>`
            : `<p style="color: #ff9800;">⚠ ${finalActiveConnections}/${actualClientCount} clients connected at end (${actualClientCount - finalActiveConnections} disconnected)</p>`;

        const startedWithNote = actualClientCount < clientsValue
            ? `<p style="color: #2196F3;">Note: Started with ${actualClientCount}/${clientsValue} clients (${clientsValue - actualClientCount} failed to log in)</p>`
            : '';

        const latencyInfo = finalLatency.count > 0
            ? `<p><strong>Latency Statistics:</strong></p>
               <p>Average: ${finalLatency.avg}ms | Min: ${finalLatency.min}ms | Max: ${finalLatency.max}ms</p>
               <p>Samples: ${finalLatency.count}</p>`
            : `<p style="color: #ff9800;">No latency data collected</p>`;

        result.innerHTML = `
            <p><strong>Benchmark Complete</strong></p>
            <p>Duration: ${totalTime}s</p>
            ${startedWithNote}
            ${connectionStatus}
            ${latencyInfo}
        `;

        setTimeout(() => {
            reset();
        }, 5000);
    }, durationValue * 1000);
});

stop.addEventListener('click', () => {
    stop.disabled = true; // Disable the stop button
    stopped = true;

    // Close all websocket connections and clean up intervals
    connections.forEach((websocketArray: WebSocket[]) => {
        websocketArray.forEach((websocket: WebSocket) => {
            const intervals = websocketIntervals.get(websocket);
            if (intervals?.timeSync) clearInterval(intervals.timeSync);
            if (intervals?.movement) clearInterval(intervals.movement);
            websocketIntervals.delete(websocket);
            if (websocket.readyState === WebSocket.OPEN) {
                websocket.close();
            }
        });
    });
    connections.clear();

    // Hide progress bar
    progressWrapper.classList.remove('active');

    // Show abort message
    result.innerHTML = 'Benchmark stopped by user';
    setTimeout(() => {
        result.style.display = 'none';
        result.innerHTML = '';
        reset();
    }, 3000);
});

function reset() {
    stop.disabled = true; // Disable the stop button
    start.disabled = false; // Enable the start button
    clients.disabled = false; // Enable the clients input
    duration.disabled = false; // Enable the duration input
    stopped = false;
    errored = false;
}
