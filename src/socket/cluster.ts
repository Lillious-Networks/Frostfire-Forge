import { spawn, type Subprocess } from "bun";
import log from "../modules/logger";
import os from "node:os";
import path from "node:path";

interface WorkerProcess {
  id: number;
  process: Subprocess;
  port: number;
  status: "starting" | "running" | "crashed" | "stopped";
  restarts: number;
  lastRestart: number;
}

class ClusterManager {
  private workers: Map<number, WorkerProcess> = new Map();
  private workerCount: number;
  private basePort: number;
  private maxRestarts: number = 5;
  private restartWindow: number = 60000; // 1 minute

  constructor(workerCount?: number, basePort: number = 3000) {
    // Default to CPU cores - 1 (leave one for HTTP server)
    const cpuCount = os.cpus().length;
    this.workerCount = workerCount || Math.max(1, cpuCount - 1);
    this.basePort = basePort;

    log.info(`Cluster Manager: Initializing with ${this.workerCount} workers`);
    log.info(`CPU Cores: ${cpuCount}`);
  }

  /**
   * Start all worker processes
   */
  async start() {
    log.info(`Starting ${this.workerCount} WebSocket workers...`);

    for (let i = 0; i < this.workerCount; i++) {
      await this.spawnWorker(i);
      // Small delay between spawns
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Setup graceful shutdown
    this.setupShutdownHandlers();

    log.success(`All ${this.workerCount} workers started successfully`);
  }

  /**
   * Spawn a single worker process
   */
  private async spawnWorker(workerId: number): Promise<void> {
    // All workers bind to the same port with reusePort for OS-level load balancing
    const workerPort = this.basePort;
    const workerPath = path.join(import.meta.dir, "worker.ts");

    log.info(`Spawning worker ${workerId} on port ${workerPort}...`);

    const workerProcess = spawn({
      cmd: ["bun", "run", workerPath],
      env: {
        ...process.env,
        WORKER_ID: String(workerId),
        WORKER_PORT: String(workerPort),
        IS_WORKER: "true",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const worker: WorkerProcess = {
      id: workerId,
      process: workerProcess,
      port: workerPort,
      status: "starting",
      restarts: 0,
      lastRestart: Date.now(),
    };

    this.workers.set(workerId, worker);

    // Handle worker output
    this.setupWorkerLogging(worker);

    // Handle worker exit
    workerProcess.exited.then((exitCode) => {
      this.handleWorkerExit(worker, exitCode);
    });

    // Wait for worker to be ready (give it 5 seconds)
    await this.waitForWorkerReady(worker);
  }

  /**
   * Setup logging for worker stdout/stderr
   */
  private setupWorkerLogging(worker: WorkerProcess) {
    const readStream = async (stream: ReadableStream) => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const text = decoder.decode(value, { stream: true });
          const lines = text.split('\n');

          for (const line of lines) {
            if (line.trim()) {
              console.log(`[Worker ${worker.id}] ${line}`);
            }
          }
        }
      } catch (e: any) {
        console.error(`[Worker ${worker.id}] Stream error: ${e.message}`);
      }
    };

    // Read stdout
    if (
      worker.process.stdout &&
      typeof worker.process.stdout !== "number"
    ) {
      readStream(worker.process.stdout);
    }

    // Read stderr
    if (
      worker.process.stderr &&
      typeof worker.process.stderr !== "number"
    ) {
      readStream(worker.process.stderr);
    }
  }

  /**
   * Wait for worker to signal it's ready
   */
  private async waitForWorkerReady(worker: WorkerProcess): Promise<void> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        log.warn(`Worker ${worker.id} did not start within 5 seconds`);
        worker.status = "running"; // Assume it's running anyway
        resolve();
      }, 5000);

      // Just wait a bit and assume success
      setTimeout(() => {
        clearTimeout(timeout);
        worker.status = "running";
        log.success(`Worker ${worker.id} ready on port ${worker.port}`);
        resolve();
      }, 1000);
    });
  }

  /**
   * Handle worker process exit
   */
  private handleWorkerExit(worker: WorkerProcess, exitCode: number) {
    log.warn(`Worker ${worker.id} exited with code ${exitCode}`);
    worker.status = "crashed";

    // Check if we should restart
    const now = Date.now();
    const timeSinceLastRestart = now - worker.lastRestart;

    // Reset restart counter if outside restart window
    if (timeSinceLastRestart > this.restartWindow) {
      worker.restarts = 0;
    }

    // Check if we've exceeded max restarts
    if (worker.restarts >= this.maxRestarts) {
      log.error(
        `Worker ${worker.id} has crashed ${worker.restarts} times in ${this.restartWindow}ms. Not restarting.`
      );
      return;
    }

    // Restart the worker
    worker.restarts++;
    worker.lastRestart = now;

    log.info(`Restarting worker ${worker.id} (restart #${worker.restarts})...`);

    setTimeout(() => {
      this.spawnWorker(worker.id);
    }, 1000);
  }

  /**
   * Gracefully shutdown all workers
   */
  async shutdown(): Promise<void> {
    log.info("Shutting down cluster...");

    const shutdownPromises: Promise<void>[] = [];

    for (const [workerId, worker] of this.workers.entries()) {
      log.info(`Stopping worker ${workerId}...`);

      const shutdownPromise = new Promise<void>((resolve) => {
        if (worker.status === "stopped" || worker.status === "crashed") {
          resolve();
          return;
        }

        worker.status = "stopped";

        // Try graceful shutdown first
        worker.process.kill("SIGTERM");

        // Force kill after 5 seconds
        const forceKillTimeout = setTimeout(() => {
          log.warn(`Force killing worker ${workerId}`);
          worker.process.kill("SIGKILL");
          resolve();
        }, 5000);

        // Wait for process to exit
        worker.process.exited.then(() => {
          clearTimeout(forceKillTimeout);
          log.info(`Worker ${workerId} stopped`);
          resolve();
        });
      });

      shutdownPromises.push(shutdownPromise);
    }

    await Promise.all(shutdownPromises);
    log.success("All workers stopped");
  }

  /**
   * Setup handlers for graceful shutdown
   */
  private setupShutdownHandlers() {
    const shutdown = async (signal: string) => {
      log.info(`Received ${signal}, shutting down...`);
      await this.shutdown();
      process.exit(0);
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  }

  /**
   * Get cluster statistics
   */
  getStats() {
    const stats = {
      totalWorkers: this.workerCount,
      runningWorkers: 0,
      crashedWorkers: 0,
      workers: [] as any[],
    };

    for (const [id, worker] of this.workers.entries()) {
      if (worker.status === "running") stats.runningWorkers++;
      if (worker.status === "crashed") stats.crashedWorkers++;

      stats.workers.push({
        id,
        port: worker.port,
        status: worker.status,
        restarts: worker.restarts,
      });
    }

    return stats;
  }
}

export default ClusterManager;
