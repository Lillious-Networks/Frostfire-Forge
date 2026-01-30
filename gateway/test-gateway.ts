/**
 * Simple test script to demonstrate gateway functionality
 *
 * This script:
 * 1. Registers 3 mock game servers
 * 2. Simulates 5 client connections
 * 3. Shows load balancing in action
 */

const GATEWAY_URL = "http://localhost:8080";
const GATEWAY_WS_URL = "ws://localhost:9000";

interface MockServer {
  id: string;
  port: number;
  wsPort: number;
  heartbeatTimer?: Timer;
}

const mockServers: MockServer[] = [];

/**
 * Register a mock game server
 */
async function registerMockServer(id: string, port: number, wsPort: number) {
  try {
    const response = await fetch(`${GATEWAY_URL}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id,
        host: "localhost",
        port,
        wsPort,
        maxConnections: 100
      })
    });

    const result = await response.json();
    if (result.success) {
      console.log(`✓ Mock server registered: ${id} (port ${port}, ws ${wsPort})`);

      // Start heartbeat
      const heartbeatTimer = setInterval(async () => {
        try {
          await fetch(`${GATEWAY_URL}/heartbeat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              id,
              activeConnections: Math.floor(Math.random() * 50)
            })
          });
        } catch (error) {
          console.error(`✗ Heartbeat failed for ${id}`);
        }
      }, 3000);

      mockServers.push({ id, port, wsPort, heartbeatTimer });
    } else {
      console.error(`✗ Failed to register ${id}:`, result.error);
    }
  } catch (error) {
    console.error(`✗ Error registering ${id}:`, error);
  }
}

/**
 * Test client connection to gateway
 */
function testClientConnection(clientId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const ws = new WebSocket(GATEWAY_WS_URL);

      ws.onopen = () => {
        console.log(`[Client ${clientId}] Connected to gateway`);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data.toString());

          if (data.type === "server_assignment") {
            console.log(
              `[Client ${clientId}] Assigned to server: ${data.server.host}:${data.server.wsPort}`
            );
            ws.close();
            resolve();
          } else if (data.type === "error") {
            console.error(`[Client ${clientId}] Error: ${data.message}`);
            ws.close();
            reject(new Error(data.message));
          }
        } catch (error) {
          console.error(`[Client ${clientId}] Failed to parse message`);
        }
      };

      ws.onerror = (error) => {
        console.error(`[Client ${clientId}] WebSocket error:`, error);
        reject(error);
      };

      ws.onclose = () => {
        console.log(`[Client ${clientId}] Disconnected from gateway`);
      };
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Get gateway status
 */
async function getGatewayStatus() {
  try {
    const response = await fetch(`${GATEWAY_URL}/status`);
    const status = await response.json();

    console.log("\n" + "=".repeat(60));
    console.log("GATEWAY STATUS");
    console.log("=".repeat(60));
    console.log(`Total Servers: ${status.totalServers}`);
    console.log("\nRegistered Servers:");

    status.servers.forEach((server: any) => {
      console.log(
        `  - ${server.id} (${server.host}:${server.wsPort}) ` +
        `[${server.activeConnections}/${server.maxConnections} connections]`
      );
    });

    console.log("=".repeat(60) + "\n");
  } catch (error) {
    console.error("✗ Failed to get gateway status:", error);
  }
}

/**
 * Cleanup mock servers
 */
async function cleanup() {
  console.log("\nCleaning up...");

  for (const server of mockServers) {
    if (server.heartbeatTimer) {
      clearInterval(server.heartbeatTimer);
    }

    try {
      await fetch(`${GATEWAY_URL}/unregister`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: server.id })
      });
      console.log(`✓ Unregistered ${server.id}`);
    } catch (error) {
      console.error(`✗ Failed to unregister ${server.id}`);
    }
  }
}

/**
 * Main test function
 */
async function runTest() {
  console.log("Starting Gateway Test...\n");

  // Wait for gateway to be ready
  console.log("Checking gateway connection...");
  try {
    await fetch(GATEWAY_URL);
    console.log("✓ Gateway is running\n");
  } catch (error) {
    console.error("✗ Gateway is not running. Please start it with: bun run server.ts");
    process.exit(1);
  }

  // Register 3 mock servers
  console.log("Registering mock game servers...");
  await registerMockServer("server-1", 4001, 5001);
  await registerMockServer("server-2", 4002, 5002);
  await registerMockServer("server-3", 4003, 5003);

  // Wait a bit for registration to complete
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Check status
  await getGatewayStatus();

  // Simulate 5 client connections
  console.log("Simulating client connections...\n");

  for (let i = 1; i <= 5; i++) {
    try {
      await testClientConnection(i);
      // Small delay between connections
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (error) {
      console.error(`Failed to connect client ${i}`);
    }
  }

  // Wait a bit
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Check status again
  await getGatewayStatus();

  // Cleanup
  await cleanup();

  console.log("\nTest completed!");
  process.exit(0);
}

// Handle Ctrl+C
process.on("SIGINT", async () => {
  await cleanup();
  process.exit(0);
});

// Run the test
runTest().catch((error) => {
  console.error("Test failed:", error);
  cleanup().then(() => process.exit(1));
});
