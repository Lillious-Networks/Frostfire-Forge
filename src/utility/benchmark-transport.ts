import { connect } from "@webtransport-bun/webtransport";
import crypto from "crypto";
import fs from "node:fs";
import path from "node:path";
import { FrameDecoder, encodeFrame } from "../socket/framing.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const MAX_FRAME_SIZE = 1024 * 1024 * 50;

let benchmarkQuiet = false;

export function setBenchmarkQuiet(quiet: boolean): void {
  benchmarkQuiet = quiet;
}

function debug(message: string, ...args: any[]): void {
  if (benchmarkQuiet) return;
  console.debug(message, ...args);
}

function resolveLocalCertPem(): string | undefined {
  const configured = process.env.TLS_CERT_PATH;
  if (!configured) return undefined;
  const certPath = path.resolve(configured);

  try {
    const pem = fs.readFileSync(certPath, "utf8").replace(/^\uFEFF/, "").trim();
    return pem.length > 0 ? pem : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeHost(host: string): string {
  if (host === "localhost") return "127.0.0.1";
  return host;
}

export interface ConnectionToken {
  token: string;
  timestamp: string;
  expiresAt: string;
  signature: string;
}

export function generateConnectionToken(serverSecret: string): ConnectionToken {
  const token = crypto.randomBytes(32).toString("hex");
  const timestamp = Date.now().toString();
  const expiresAt = (Date.now() + 60000).toString();

  const signature = crypto
    .createHmac("sha256", serverSecret)
    .update(`${token}:${timestamp}:${expiresAt}`)
    .digest("hex");

  return { token, timestamp, expiresAt, signature };
}

function isLocalHost(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

export class BenchmarkConnection {
  readonly session: any;
  readonly stream: any;
  private decoder = new FrameDecoder(MAX_FRAME_SIZE);
  private state: number = 0;
  private messageHandlers: Array<(message: string) => void> = [];
  private closeHandlers: Array<(code: number, reason: string) => void> = [];
  private datagramHandlers: Array<(datagram: Uint8Array) => void> = [];

  private constructor(session: any, stream: any) {
    this.session = session;
    this.stream = stream;

    (async () => {
      try {
        for await (const datagram of session.incomingDatagrams()) {
          const bytes = datagram instanceof Uint8Array ? datagram : new Uint8Array(datagram);
          for (const handler of [...this.datagramHandlers]) {
            try {
              handler(bytes);
            } catch (error: any) {
              debug("Benchmark datagram handler error:", error);
            }
          }
        }
      } catch {
        // Expected on session close
      }
    })();

    (async () => {
      try {
        for await (const chunk of stream) {
          const frames = this.decoder.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
          for (const frame of frames) {
            const message = textDecoder.decode(frame);
            for (const handler of [...this.messageHandlers]) {
              try {
                handler(message);
              } catch (error: any) {
                debug("Benchmark message handler error:", error);
              }
            }
          }
        }
      } catch {
        // Expected on session close
      }

      if (this.state !== 3) {
        this.state = 3;
        this.emitClose(0, "");
      }
    })();

    session.closed
      .then((info: any) => {
        if (this.state === 3) return;
        this.state = 3;
        const reason = info?.reason || "";
        const separator = reason.indexOf("|");
        const code = separator !== -1 ? parseInt(reason.slice(0, separator), 10) : info?.code ?? 1;
        const reasonText = separator !== -1 ? reason.slice(separator + 1) : reason;
        this.emitClose(Number.isFinite(code) ? code : 1, reasonText);
      })
      .catch(() => {
        if (this.state !== 3) {
          this.state = 3;
          this.emitClose(1, "");
        }
      });
  }

  static async connect(url: string, serverSecret: string, useragent: string = "Frostfire-Forge-Benchmark/1.0", origin: string = "http://localhost"): Promise<BenchmarkConnection> {
    const caPem = resolveLocalCertPem();
    const session = caPem
      ? await connect(url, { tls: { caPem } })
      : isLocalHost(url)
        ? await connect(url, { tls: { insecureSkipVerify: true } })
        : await connect(url);
    if (session.ready) {
      await session.ready;
    }

    const bidi = await session.createBidirectionalStream();
    const connection = new BenchmarkConnection(session, bidi);

    const token = generateConnectionToken(serverSecret);
    const authFrame = encodeFrame(textEncoder.encode(JSON.stringify({
      type: "AUTH_CONNECT",
      data: {
        token: token.token,
        timestamp: token.timestamp,
        expiresAt: token.expiresAt,
        signature: token.signature,
        useragent,
        origin,
      },
    })));

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Authentication timeout")), 15000);

      const handler = (message: string) => {
        let parsed: any;
        try {
          parsed = JSON.parse(message);
        } catch {
          return;
        }

        if (parsed.type === "AUTH_CONNECT_SUCCESS") {
          clearTimeout(timeout);
          connection.offMessage(handler);
          connection.state = 1;
          resolve();
        }
      };

      connection.onMessage(handler);
      connection.writeRaw(authFrame);
    });

    return connection;
  }

  get readyState(): number {
    return this.state;
  }

  onMessage(handler: (message: string) => void): void {
    this.messageHandlers.push(handler);
  }

  offMessage(handler: (message: string) => void): void {
    const index = this.messageHandlers.indexOf(handler);
    if (index !== -1) {
      this.messageHandlers.splice(index, 1);
    }
  }

  onClose(handler: (code: number, reason: string) => void): void {
    this.closeHandlers.push(handler);
  }

  onDatagram(handler: (datagram: Uint8Array) => void): void {
    this.datagramHandlers.push(handler);
  }

  send(payload: Uint8Array | string): void {
    if (this.state !== 1) return;

    let bytes: Uint8Array;
    if (typeof payload === "string") {
      bytes = textEncoder.encode(payload);
    } else {
      bytes = payload;
    }

    this.writeRaw(encodeFrame(bytes));
  }

  close(code: number = 1000, reason: string = "benchmark"): void {
    if (this.state === 3) return;
    this.state = 3;

    const wtCode = code === 1000 ? 0 : 1;
    try {
      this.session.close({ code: wtCode, reason: `${code}|${reason}` });
    } catch (error: any) {
      debug("Benchmark session close failed:", error);
    }
  }

  private writeRaw(bytes: Uint8Array): void {
    try {
      this.stream.write(Buffer.from(bytes));
    } catch (error: any) {
      debug("Benchmark stream write failed:", error);
    }
  }

  private emitClose(code: number, reason: string): void {
    for (const handler of [...this.closeHandlers]) {
      try {
        handler(code, reason);
      } catch (error: any) {
        debug("Benchmark close handler error:", error);
      }
    }
  }
}
