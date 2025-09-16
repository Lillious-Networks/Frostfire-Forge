const clients = document.getElementById('clients') as HTMLInputElement;
const clientsLabel = document.getElementById('clients-label') as HTMLLabelElement;
const iterations = document.getElementById('iterations') as HTMLInputElement;
const iterationsLabel = document.getElementById('iterations-label') as HTMLLabelElement;
const data = document.getElementById('data') as HTMLInputElement;
const dataLabel = document.getElementById('data-label') as HTMLLabelElement;
const start = document.getElementById('start') as HTMLButtonElement;
const result = document.getElementById('result') as HTMLParagraphElement;
const interval = document.getElementById('interval') as HTMLInputElement;
const intervalLabel = document.getElementById('interval-label') as HTMLLabelElement;
const stop = document.getElementById('stop') as HTMLButtonElement;
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

function createPacket(size: number) {
    // size is in mb
    const data = new Uint8Array(size * 1024 * 1024);
    for (let i = 0; i < data.length; i++) {
        data[i] = Math.floor(Math.random() * 256);
    }
    return data;
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

if (!iterations || !data || !iterationsLabel || !dataLabel || !start || !result || !clients) {
    throw new Error('Element not found');
}

// Function to format data size dynamically
function formatDataSize(valueInBytes: number): string {
    if (valueInBytes < 1024) {
        return `${valueInBytes.toFixed(2)} B`;
    } else if (valueInBytes < 1024 * 1024) {
        return `${(valueInBytes / 1024).toFixed(2)} KB`;
    } else if (valueInBytes < 1024 * 1024 * 1024) {
        return `${(valueInBytes / (1024 * 1024)).toFixed(2)} MB`;
    } else {
        return `${(valueInBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }
}

// Helper function to calculate actual data size per message
function calculateDataArrayBytes(dataValueInMB: number, bytesPerElement: number): number {
    const elements = dataValueInMB * 1024 * 1024 / bytesPerElement;
    return elements * bytesPerElement;
}

// Initialize inputs with default values
clients.value = '50';
clientsLabel.innerText = `Clients: ${clients.value}`;
iterations.value = '100';
iterationsLabel.innerText = `Iterations: ${iterations.value}`;
data.value = '0.000031';
interval.value = '64';
intervalLabel.innerText = `Interval: ${interval.value} ms`;
const bytesPerElement = 4; // Each array element is 4 bytes
const dataValueInBytes = calculateDataArrayBytes(Number(data.value), bytesPerElement);
dataLabel.innerText = `Data per message: ${formatDataSize(dataValueInBytes)}`;

// Update iterations label on input
iterations.addEventListener('input', () => {
    iterationsLabel.innerText = `Iterations: ${iterations.value}`;
});

// Update data label on input
data.addEventListener('input', () => {
    const dataValueInBytes = calculateDataArrayBytes(Number(data.value), bytesPerElement);
    dataLabel.innerText = `Data per message: ${formatDataSize(dataValueInBytes)}`;
});

// Update clients label on input
clients.addEventListener('input', () => {
    clientsLabel.innerText = `Clients: ${clients.value}`;
});

// Update interval label on input
interval.addEventListener('input', () => {
    intervalLabel.innerText = `Interval: ${interval.value} ms`;
});

// Start button logic
const connections = new Map<string, WebSocket[]>();
start.addEventListener('click', async () => {
    if (start.disabled) return; // If the start button is disabled, do not run the benchmark
    start.disabled = true; // Disable the start button
    stop.disabled = false; // Enable the stop button
    clients.disabled = true; // Disable the clients input
    iterations.disabled = true; // Disable the iterations input
    data.disabled = true; // Disable the data input
    interval.disabled = true; // Disable the interval input 
    result.style.display = 'block';
    result.innerHTML = '';
    stopped = false;
    let total = 0;

    const clientsValue = parseInt(clients.value);
    const iterationsValue = parseInt(iterations.value);
    const dataValue = parseFloat(data.value);
    const dataArray = createPacket(dataValue);

    async function createClients(amount: number): Promise<WebSocket[]> {
        const websockets: WebSocket[] = [];
        return new Promise((resolve, reject) => {
            let openedCount = 0;
            for (let i = 0; i < amount; i++) {
                const websocket = new WebSocket('__VAR.WEBSOCKETURL__');
                websocket.binaryType = "arraybuffer";
                websocket.onopen = () => {
                    websockets.push(websocket);
                    openedCount++;
                    if (stopped) {
                        result.innerHTML = 'Stopping benchmark...';
                    } else {
                        result.innerText = `Connected ${openedCount} / ${amount} clients`;
                    }
                    if (openedCount === amount) {
                        if (!stopped) {
                            result.innerText = `Connected ${amount} clients`;
                        }
                        resolve(websockets);
                    }
                };
                websocket.onerror = (error) => {
                    reject(error);
                };
            }
        });
    }

    const websockets = await createClients(clientsValue) as WebSocket[];
    const startTime = Date.now();
    websockets.forEach((websocket: WebSocket) => {
        const id = Math.random().toString(36).substring(7);
        connections.set(id, [websocket]);
        if (stopped) {
            connections.delete(id);
            websocket.close();
            // Check the connections size
            if (connections.size === 0) {
                result.innerHTML = 'Benchmark aborted';
                setTimeout(() => {
                    result.style.display = 'none';
                    result.innerHTML = '';
                    reset();
                }, 3000);
            }
            return;
        }
        let counter = 0;
        (async () => {
            for (let i = 0; i < iterationsValue; i++) {
                if (stopped) return;
                await new Promise<void>((resolve) => {
                    websocket.send(
                    packet.encode(
                    JSON.stringify({
                    type: "BENCHMARK",
                    data: {
                        data: dataArray,
                        id: i
                    }
                    })
                )
                );
                setTimeout(resolve, Number(interval.value)); // Wait for the interval value before resolving the promise
            });
            }
        })();

        websocket.onerror = (error) => {
            if (stopped) return;
            console.error("WebSocket error:", error);
            errored = true;
            result.innerText = `An error occurred while connecting to the WebSocket.`;
            connections.delete(id);
        };

        websocket.onclose = () => {
            if (errored) return;
            connections.delete(id);
            if (connections.size === 0) {
                const endTime = Date.now();
                const totalTime = (endTime - startTime) / 1000; // Convert milliseconds to seconds
                const averageTimePerMessage = totalTime / total;
                const dataPerMessage = formatDataSize(calculateDataArrayBytes(Number(data.value), bytesPerElement));
                const totalDataBytes = formatDataSize(calculateDataArrayBytes(Number(data.value), bytesPerElement) * iterationsValue);
                if (stopped) {
                    result.textContent = 'Benchmark aborted';
                    setTimeout(() => {
                        result.style.display = 'none';
                        result.innerHTML = '';
                        reset();
                    }, 3000);
                } else {
                    result.innerHTML = `
                        <p>Processed ${total} / ${iterationsValue * clientsValue} messages</p>
                        <p>Clients: ${clientsValue}</p>
                        <p>Interval: ${interval.value} ms</p>
                        <p>Iterations: ${iterationsValue}</p>
                        <p>Total data sent: ${totalDataBytes}</p>
                    <p>Data per message: ${dataPerMessage}</p>
                    <p>Total time elapsed: ${totalTime} s</p>
                    <p>Average time per message: ${Math.round(averageTimePerMessage * 1000)} ms</p>
                `;
                reset();
                }
            }
        }

        websocket.onmessage = (event: any) => {
            if (!(event.data instanceof ArrayBuffer)) return;
            const type = JSON.parse(packet.decode(event.data))["type"];
            if (type !== 'BENCHMARK') return;
            total++;
            counter++;
            result.innerText = `Received ${total} messages`;
            if (counter >= iterationsValue) {
                websocket.close();
            }
        }
    });
});

stop.addEventListener('click', () => {
    stop.disabled = true; // Disable the stop button
    stopped = true;
    connections.forEach((websocket: WebSocket[]) => {
        websocket.forEach((websocket: WebSocket) => {
            if (websocket.readyState === WebSocket.OPEN) {
                websocket.close();
            }
        });
    });
});

function reset() {
    stop.disabled = true; // Disable the stop button
    start.disabled = false; // Enable the start button
    clients.disabled = false; // Enable the clients input
    iterations.disabled = false; // Enable the iterations input
    data.disabled = false; // Enable the data input
    interval.disabled = false; // Enable the interval input
    stopped = false;
}
