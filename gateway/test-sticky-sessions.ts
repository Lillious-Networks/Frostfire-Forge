/**
 * Test script to verify sticky sessions are working
 */

console.log('Testing sticky sessions...\n');

// Test 1: Connect with same clientId twice
console.log('Test 1: Same clientId should get same server');
const clientId1 = 'test-user-123';

const ws1 = new WebSocket(`ws://localhost:9000?clientId=${clientId1}`);
ws1.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log(`  First connection: ${data.type}, assigned to ${data.server?.id}`);
  ws1.close();

  // Wait a bit then reconnect with same clientId
  setTimeout(() => {
    const ws2 = new WebSocket(`ws://localhost:9000?clientId=${clientId1}`);
    ws2.onmessage = (event2) => {
      const data2 = JSON.parse(event2.data);
      console.log(`  Second connection: ${data2.type}, assigned to ${data2.server?.id}`);

      if (data.server?.id === data2.server?.id) {
        console.log('  ✓ PASS: Sticky session working!\n');
      } else {
        console.log('  ✗ FAIL: Got different servers!\n');
      }
      ws2.close();

      // Test 2: Different clientId should get different server (if multiple servers)
      setTimeout(() => runTest2(), 1000);
    };
  }, 1000);
};

function runTest2() {
  console.log('Test 2: Different clientIds should distribute');

  const clients = ['client-a', 'client-b', 'client-c', 'client-d', 'client-e'];
  const assignments: Record<string, string> = {};
  let completed = 0;

  clients.forEach((clientId, index) => {
    setTimeout(() => {
      const ws = new WebSocket(`ws://localhost:9000?clientId=${clientId}`);
      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        assignments[clientId] = data.server?.id || 'none';
        console.log(`  ${clientId} → ${data.server?.id}`);
        ws.close();

        completed++;
        if (completed === clients.length) {
          const servers = new Set(Object.values(assignments));
          console.log(`  Distributed across ${servers.size} server(s)`);
          if (servers.size > 1) {
            console.log('  ✓ PASS: Load balancing working!\n');
          } else {
            console.log('  ℹ INFO: Only 1 server registered (expected if testing with single server)\n');
          }

          // Test 3: Check sessions are persisted
          setTimeout(() => runTest3(clients), 1000);
        }
      };
    }, index * 200);
  });
}

function runTest3(clients: string[]) {
  console.log('Test 3: Reconnect all clients - should go to same servers');

  let completed = 0;

  clients.forEach((clientId, index) => {
    setTimeout(() => {
      const ws = new WebSocket(`ws://localhost:9000?clientId=${clientId}`);
      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        console.log(`  ${clientId} → ${data.server?.id} (reconnect)`);
        ws.close();

        completed++;
        if (completed === clients.length) {
          console.log('  ✓ All clients reconnected\n');

          // Check gateway status
          setTimeout(() => checkGatewayStatus(), 1000);
        }
      };
    }, index * 200);
  });
}

async function checkGatewayStatus() {
  console.log('Checking gateway status...');

  const response = await fetch('http://localhost:8080/status');
  const status = await response.json();

  console.log(`  Total servers: ${status.totalServers}`);
  console.log(`  Total sessions: ${status.totalActiveSessions}`);
  console.log('  Servers:');
  status.servers.forEach((s: any) => {
    console.log(`    - ${s.id} (${s.host}:${s.wsPort}) - ${s.activeConnections}/${s.maxConnections} connections`);
  });

  // Check debug sessions endpoint
  const debugResponse = await fetch('http://localhost:8080/debug/sessions');
  const debugData = await debugResponse.json();
  console.log(`\n  Session details (${debugData.totalSessions} total):`);
  debugData.sessions.forEach((s: any) => {
    console.log(`    - ${s.clientId} → ${s.serverId} (age: ${s.age})`);
  });

  console.log('\nTests complete!');
  process.exit(0);
}
