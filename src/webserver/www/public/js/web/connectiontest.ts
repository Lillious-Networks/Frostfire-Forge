const startButton = document.getElementById('start') as HTMLButtonElement;
const logs = document.getElementById('logs') as HTMLDivElement;

const domain = window.location.hostname;
const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
const wsUrl = `${protocol}://${domain}:3000`;

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

console.log = (message?: any, ...optionalParams: any[]) => {
    logs.style.display = 'block';
    const msg = [message, ...optionalParams].join(' ');
    const logEntry = document.createElement('div');
    logEntry.textContent = msg;
    logs.appendChild(logEntry);
};

console.error = (message?: any, ...optionalParams: any[]) => {
    logs.style.display = 'block';
    const msg = [message, ...optionalParams].join(' ');
    const logEntry = document.createElement('div');
    logEntry.style.color = 'red';
    logEntry.textContent = msg;
    logs.appendChild(logEntry);
};

console.warn = (message?: any, ...optionalParams: any[]) => {
    logs.style.display = 'block';
    const msg = [message, ...optionalParams].join(' ');
    const logEntry = document.createElement('div');
    logEntry.style.color = 'orange';
    logEntry.textContent = msg;
    logs.appendChild(logEntry);
};

startButton.onclick = () => {
    logs.innerHTML = '';
    logs.style.display = 'none';
    connectWebSocket();
};

function connectWebSocket() {
    try {
        console.log(`Connecting to ${wsUrl}`);
        const websocket = new WebSocket(wsUrl);
        websocket.binaryType = "arraybuffer";

        websocket.onopen = () => {
            console.log('WebSocket connection established.');
            const data = JSON.stringify({ type: 'PING', data: null });
            const _packet = packet.encode(data);
            console.log(`Sending Data: ${data}`);
            websocket.send(_packet);
        };

        websocket.onmessage = (event: any) => {
            if (!(event.data instanceof ArrayBuffer)) {
                console.error('Received non-binary data from server.');
                return;
            }
            const data = JSON.parse(packet.decode(event.data));
            console.log(`Received Data: ${JSON.stringify(data)}`);
        };
        websocket.onerror = (event) => {
            console.error('WebSocket error:', JSON.stringify(event));
        };

        websocket.onclose = (event) => {
            console.error(`WebSocket connection closed: code=${event.code}, reason=${event.reason}`);
        };
    } catch (error) {
        console.error('Failed to connect to WebSocket:', error);
    }
}