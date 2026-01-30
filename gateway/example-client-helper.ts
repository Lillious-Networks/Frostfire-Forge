/**
 * Gateway Client Helper with Sticky Session Support
 *
 * This module provides helper functions to connect clients through the gateway.
 * Uses clientId for sticky sessions - clients with the same ID always connect to the same server.
 */

interface GatewayConfig {
  gatewayUrl: string;
  clientId?: string;  // Optional: provide your own clientId (username, userId, etc.)
  timeout?: number;
}

interface ServerAssignment {
  host: string;
  port: number;
  wsPort: number;
  clientId: string;  // Gateway returns the clientId used (generated if not provided)
}

/**
 * Connect to the gateway and get assigned server with sticky session support
 * @param config Gateway configuration with optional clientId
 * @returns Promise that resolves with the assigned server details
 */
export function connectThroughGateway(config: GatewayConfig): Promise<ServerAssignment> {
  return new Promise((resolve, reject) => {
    const timeout = config.timeout || 10000; // 10 second default timeout
    let timeoutId: number;

    try {
      // Build gateway URL with clientId query parameter if provided
      let gatewayUrl = config.gatewayUrl;
      if (config.clientId) {
        const url = new URL(gatewayUrl);
        url.searchParams.set('clientId', config.clientId);
        gatewayUrl = url.toString();
      }

      const gatewaySocket = new WebSocket(gatewayUrl);

      // Set timeout
      timeoutId = setTimeout(() => {
        gatewaySocket.close();
        reject(new Error('Gateway connection timeout'));
      }, timeout);

      gatewaySocket.onopen = () => {
        console.log('[Gateway] Connected, waiting for server assignment...');
      };

      gatewaySocket.onmessage = (event) => {
        clearTimeout(timeoutId);

        try {
          const data = JSON.parse(event.data.toString());

          if (data.type === 'server_assignment') {
            console.log('[Gateway] Assigned to server:', data.server);
            console.log('[Gateway] Your clientId:', data.clientId);
            gatewaySocket.close();
            resolve({
              ...data.server,
              clientId: data.clientId
            });
          } else if (data.type === 'error') {
            gatewaySocket.close();
            reject(new Error(`Gateway error: ${data.message}`));
          }
        } catch (error) {
          gatewaySocket.close();
          reject(new Error(`Failed to parse gateway message: ${error}`));
        }
      };

      gatewaySocket.onerror = (error) => {
        clearTimeout(timeoutId);
        reject(new Error(`Gateway connection error: ${error}`));
      };

      gatewaySocket.onclose = (event) => {
        clearTimeout(timeoutId);
        if (event.code !== 1000) {
          reject(new Error(`Gateway connection closed unexpectedly: ${event.code} ${event.reason}`));
        }
      };
    } catch (error) {
      reject(new Error(`Failed to connect to gateway: ${error}`));
    }
  });
}

/**
 * Connect to game server with gateway fallback
 * @param directUrl Direct server WebSocket URL (fallback)
 * @param gatewayUrl Gateway WebSocket URL (optional)
 * @param clientId Client identifier for sticky sessions (optional - username, userId, etc.)
 * @returns Promise that resolves with the WebSocket connection
 */
export async function connectWithGateway(
  directUrl: string,
  gatewayUrl?: string,
  clientId?: string
): Promise<WebSocket> {
  // If gateway is not configured, connect directly
  if (!gatewayUrl) {
    console.log('[Gateway] Gateway not configured, connecting directly to:', directUrl);
    return new WebSocket(directUrl);
  }

  try {
    // Try to connect through gateway
    console.log('[Gateway] Attempting to connect through gateway...');
    const result = await connectThroughGateway({
      gatewayUrl,
      clientId,  // Pass clientId for sticky sessions
      timeout: 5000
    });

    // Store clientId in localStorage for subsequent connections
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('gateway_clientId', result.clientId);
    }

    // Connect to assigned server
    const gameUrl = `ws://${result.host}:${result.wsPort}`;
    console.log('[Gateway] Connecting to assigned server:', gameUrl);
    return new WebSocket(gameUrl);
  } catch (error) {
    // Fallback to direct connection
    console.warn('[Gateway] Gateway connection failed, falling back to direct connection:', error);
    return new WebSocket(directUrl);
  }
}

/**
 * Usage Examples:
 *
 * // Option 1: Basic connection with sticky sessions
 * try {
 *   const result = await connectThroughGateway({
 *     gatewayUrl: 'ws://localhost:9000',
 *     clientId: 'user123'  // Your unique identifier
 *   });
 *   console.log('Assigned clientId:', result.clientId);
 *   const socket = new WebSocket(`ws://${result.host}:${result.wsPort}`);
 * } catch (error) {
 *   console.error('Failed to connect through gateway:', error);
 * }
 *
 * // Option 2: Let gateway generate clientId (first connection)
 * const result = await connectThroughGateway({
 *   gatewayUrl: 'ws://localhost:9000'
 *   // No clientId - gateway will generate one
 * });
 * // Save result.clientId for future connections!
 * localStorage.setItem('myClientId', result.clientId);
 *
 * // Option 3: Reconnect with saved clientId (sticky!)
 * const savedClientId = localStorage.getItem('myClientId');
 * const result = await connectThroughGateway({
 *   gatewayUrl: 'ws://localhost:9000',
 *   clientId: savedClientId  // Will return to same server!
 * });
 *
 * // Option 4: Connect with automatic fallback
 * const socket = await connectWithGateway(
 *   'ws://localhost:3000',  // Direct URL (fallback)
 *   'ws://localhost:9000',  // Gateway URL (optional)
 *   'user123'               // ClientId for sticky sessions
 * );
 *
 * socket.binaryType = "arraybuffer";
 * socket.onopen = () => {
 *   console.log('Connected to game server!');
 * };
 */
