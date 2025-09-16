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

// ---------- Logging ----------
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

// ---------- Button ----------
startButton.onclick = () => {
  logs.innerHTML = '';
  logs.style.display = 'none';
  connectWebSocket();
};

// ---------- Helpers ----------
function bufferForTypedArray(ta: Uint8Array) {
  if (ta.byteOffset === 0 && ta.byteLength === ta.buffer.byteLength) return ta.buffer;
  return ta.buffer.slice(ta.byteOffset, ta.byteOffset + ta.byteLength);
}

function sendJSON(ws: WebSocket, obj: any) {
  const json = JSON.stringify(obj);
  const u8 = packet.encode(json);
  const ab = bufferForTypedArray(u8);

  try {
    ws.send(ab);
    console.log('Sent as ArrayBuffer.');
    return;
  } catch (e) {
    console.warn('ArrayBuffer send failed:', e);
  }

  try {
    ws.send(new Blob([u8]));
    console.log('Sent as Blob.');
    return;
  } catch (e) {
    console.warn('Blob send failed:', e);
  }

  try {
    ws.send(json);
    console.log('Sent as text fallback.');
  } catch (e) {
    console.error('All send attempts failed:', e);
  }
}

// ---------- Main ----------
function connectWebSocket() {
  try {
    console.log(`Connecting to ${wsUrl}`);
    const websocket = new WebSocket(wsUrl);
    websocket.binaryType = "arraybuffer";

    websocket.addEventListener('open', () => {
      console.log('WebSocket connection established. readyState =', websocket.readyState);
      sendJSON(websocket, { type: 'PING', data: null });
    });

    websocket.addEventListener('message', (event: any) => {
      if (!(event.data instanceof ArrayBuffer)) {
        console.error('Received non-binary data from server:', event.data);
        return;
      }
      const data = JSON.parse(packet.decode(event.data));
      console.log(`Received Data: ${JSON.stringify(data)}`);
    });

    websocket.addEventListener('error', (event) => {
      console.error('WebSocket error event:', JSON.stringify(event));
    });

    websocket.addEventListener('close', (event) => {
      console.error('WebSocket closed:', JSON.stringify(event));
    });
  } catch (error) {
    console.error('Failed to connect to WebSocket:', error);
  }
}
