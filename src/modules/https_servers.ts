// Unified HTTP serving stack. This file is kept byte-identical across the
// Frostfire Forge engine, gateway and asset server repositories.
//
// Layout:
//   1. The application runs an HTTPS server bound to 127.0.0.1 on the
//      internal port (started by the caller with getInternalServerOptions).
//   2. This module starts the edge reverse proxy in front of it on the public
//      interface. When SSL is enabled the proxy terminates TLS (HTTP/3 +
//      HTTP/2) and forwards HTTPS to the internal server, adding the
//      X-Real-Client-IP / X-Forwarded-For / X-Forwarded-Proto headers.
//   3. When SSL is enabled, an HTTP->HTTPS 301 redirect server runs on the
//      plain HTTP port.
//
// Environment (identical in every project):
//   HTTP_USE_SSL          "true" to enable TLS on the public listener
//   WEBSRV_PORT           public plain HTTP port (redirect target when SSL is on)
//   WEBSRV_PORTSSL        public HTTPS port
//   WEBSRV_INTERNAL_PORT  internal HTTPS port (the application itself)
//   WEBSRV_HTTP1          "false" to disable HTTP/1.1 on the public listener (default: on)
//   WEBSRV_HTTP2          "false" to disable HTTP/2 on the public listener (default: on)
//   WEBSRV_HTTP3          "false" to disable HTTP/3 on the public listener (default: on, TLS only)
//   TLS_CERT_PATH / TLS_KEY_PATH / TLS_CA_PATH
import fs from "node:fs";

export interface HttpsServerLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  success: (msg: string) => void;
  debug: (msg: string) => void;
}

export interface HttpsServerConfig {
  name: string;
  sslEnabled: boolean;
  httpPort: number;
  httpsPort: number;
  internalPort: number;
  internalHost?: string;
  certPath?: string;
  keyPath?: string;
  caPath?: string;
  // Force HTTP/3 off on the edge proxy. Needed when another listener owns
  // the UDP port (e.g. the game server's WebTransport/QUIC listener shares
  // the port number with the HTTP API).
  http3?: boolean;
  log?: HttpsServerLogger;
  filterRequest?: (req: Request, ip: string) => Response | null | Promise<Response | null>;
}

export interface HttpsServerStack {
  proxy: ReturnType<typeof Bun.serve<any, any>>;
  redirect: ReturnType<typeof Bun.serve<any, any>> | null;
  publicPort: number;
  internalUrl: string;
  sslEnabled: boolean;
}

// Environment-driven HTTP protocol toggles for every Bun.serve listener in
// the project (edge proxy, redirect server and internal application server).
// Internal hops always fetch over TLS with HTTP/2 (see serverFetch and the
// proxy's upstream request), so HTTP/1.1 can be disabled everywhere without
// breaking the proxy chain.
export function getHttpProtocolOptions(sslEnabled: boolean, http3Override?: boolean): { http1: boolean; http2: boolean; http3?: boolean } {
  const http1 = process.env.WEBSRV_HTTP1 !== "false";
  const http2 = process.env.WEBSRV_HTTP2 !== "false";
  const http3 = sslEnabled && (http3Override ?? process.env.WEBSRV_HTTP3 !== "false");

  const options: { http1: boolean; http2: boolean; http3?: boolean } = { http1, http2 };
  if (http3) {
    options.http3 = true;
  }
  return options;
}

function readChain(certPath: string, caPath?: string): string {
  const cert = fs.readFileSync(certPath, "utf-8").replace(/^\uFEFF/, "").trim();
  if (caPath && fs.existsSync(caPath)) {
    return cert + "\n" + fs.readFileSync(caPath, "utf-8").replace(/^\uFEFF/, "").trim();
  }
  return cert;
}

// The internal hop uses TLS when the shared certificate files exist
// (production / local machines) and falls back to plain HTTP when they do
// not (CI/docker images do not bake in certificates).
export function isInternalTlsEnabled(certPath?: string, keyPath?: string): boolean {
  return !!certPath && !!keyPath && fs.existsSync(certPath) && fs.existsSync(keyPath);
}

export function getInternalBaseUrl(port: number, certPath?: string, keyPath?: string, host?: string): string {
  const scheme = isInternalTlsEnabled(certPath, keyPath) ? "https" : "http";
  return `${scheme}://${host ?? "127.0.0.1"}:${port}`;
}

// Options for the internal application server: HTTPS on 127.0.0.1 using the
// same certificate as the public proxy. Protocol versions follow the
// WEBSRV_HTTP1/2/3 env vars - internal hops always fetch over TLS with
// HTTP/3 or HTTP/2 (see serverFetch), so disabling HTTP/1.1 is safe
// everywhere. Without certificate files (CI images) it falls back to plain
// HTTP so the stack still boots.
export function getInternalServerOptions(certPath: string, keyPath: string, caPath?: string): { http1: boolean; http2: boolean; http3?: boolean; tls?: { cert: string; key: string | Buffer } } {
  const protocols = getHttpProtocolOptions(isInternalTlsEnabled(certPath, keyPath));
  if (!isInternalTlsEnabled(certPath, keyPath)) {
    return protocols;
  }
  return {
    ...protocols,
    tls: {
      cert: readChain(certPath, caPath),
      key: fs.readFileSync(keyPath),
    },
  };
}

// Origins whose HTTP/3 support has been probed: true = h3 works, false = h2 only.
const http3Origins = new Map<string, boolean>();
const HTTP3_PROBE_TIMEOUT_MS = 2500;

// Server-to-server fetch. Tries HTTP/3 first on https:// URLs (each origin is
// probed once with a short timeout - a failed QUIC handshake would otherwise
// stall 20s), falls back to HTTP/2, and keeps HTTP/1.1 for cleartext http://
// URLs (development) because Bun's fetch has no h2c support. Self-signed
// internal certificates are trusted per request instead of relying on
// NODE_TLS_REJECT_UNAUTHORIZED.
export function serverFetch(url: string, init?: RequestInit): Promise<Response> {
  if (!url.startsWith("https://")) {
    return fetch(url, init);
  }

  const origin = new URL(url).origin;
  const known = http3Origins.get(origin);

  if (known === false) {
    return fetch(url, { ...init, protocol: "http2", tls: { rejectUnauthorized: false } });
  }

  if (known === true) {
    return fetch(url, { ...init, protocol: "http3", tls: { rejectUnauthorized: false } })
      .catch(() => {
        http3Origins.set(origin, false);
        return fetch(url, { ...init, protocol: "http2", tls: { rejectUnauthorized: false } });
      });
  }

  // Unknown origin: probe HTTP/3 with a short timeout so h3-less origins
  // (or the game server, whose UDP port is owned by WebTransport) do not
  // stall requests for the full QUIC handshake timeout.
  const callerSignal = init?.signal ?? null;
  const probe = new AbortController();
  const forwardAbort = () => probe.abort();
  if (callerSignal) {
    if (callerSignal.aborted) probe.abort();
    else callerSignal.addEventListener("abort", forwardAbort, { once: true });
  }
  const timer = setTimeout(() => probe.abort(), HTTP3_PROBE_TIMEOUT_MS);

  return fetch(url, { ...init, protocol: "http3", tls: { rejectUnauthorized: false }, signal: probe.signal })
    .then((res) => {
      http3Origins.set(origin, true);
      return res;
    })
    .catch(() => {
      http3Origins.set(origin, false);
      return fetch(url, { ...init, protocol: "http2", tls: { rejectUnauthorized: false } });
    })
    .finally(() => {
      clearTimeout(timer);
      if (callerSignal) callerSignal.removeEventListener("abort", forwardAbort);
    });
}

const consoleLogger: HttpsServerLogger = {
  info: (msg: string) => console.log(msg),
  warn: (msg: string) => console.warn(msg),
  error: (msg: string) => console.error(msg),
  success: (msg: string) => console.log(msg),
  debug: (msg: string) => console.debug(msg),
};

function tryParseURL(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export function startHttpsServers(config: HttpsServerConfig): HttpsServerStack {
  const log = config.log ?? consoleLogger;

  const filesOk = !!config.certPath && !!config.keyPath && fs.existsSync(config.certPath) && fs.existsSync(config.keyPath);
  const sslEnabled = config.sslEnabled && filesOk;

  if (config.sslEnabled && !filesOk) {
    log.error(`[${config.name}] SSL requested but certificates not found.`);
    log.error(`  Cert path: ${config.certPath || "(TLS_CERT_PATH not set)"} (exists: ${!!config.certPath && fs.existsSync(config.certPath)})`);
    log.error(`  Key path:  ${config.keyPath || "(TLS_KEY_PATH not set)"} (exists: ${!!config.keyPath && fs.existsSync(config.keyPath)})`);
  }

  const publicPort = sslEnabled ? config.httpsPort : config.httpPort;
  const internalUrl = getInternalBaseUrl(config.internalPort, config.certPath, config.keyPath, config.internalHost);

  const tlsOptions = sslEnabled
    ? {
        tls: {
          cert: readChain(config.certPath!, config.caPath),
          key: fs.readFileSync(config.keyPath!),
        },
      }
    : {};

  const proxy = Bun.serve({
    hostname: "0.0.0.0",
    port: publicPort,
    development: false,
    reusePort: true,
    ...getHttpProtocolOptions(sslEnabled, config.http3),
    async fetch(req: Request, server: any) {
      const url = tryParseURL(req.url);
      if (!url) {
        return new Response(JSON.stringify({ message: "Invalid request" }), { status: 400 });
      }

      const ip = server.requestIP(req)?.address;
      if (!ip) {
        return new Response(JSON.stringify({ message: "Invalid request" }), { status: 400 });
      }

      if (config.filterRequest) {
        const blocked = await config.filterRequest(req, ip);
        if (blocked) {
          return blocked;
        }
      }

      const headers = new Headers(req.headers);
      headers.delete("X-Real-Client-IP");
      headers.set("X-Real-Client-IP", ip);
      headers.set("X-Forwarded-For", ip);
      headers.set("X-Forwarded-Proto", sslEnabled ? "https" : "http");
      // Request identity encoding upstream: Bun's fetch transparently
      // decompresses gzip responses but passes the upstream Content-Encoding
      // header through, so a client would double-decompress (ZlibError).
      headers.set("Accept-Encoding", "identity");

      try {
        const hasBody = req.method !== "GET" && req.method !== "HEAD";
        return await serverFetch(`${internalUrl}${url.pathname}${url.search}`, {
          method: req.method,
          headers,
          body: hasBody ? await req.arrayBuffer() : undefined,
          redirect: "manual",
        });
      } catch (error) {
        log.error(`[${config.name}] Failed to proxy request: ${error}`);
        return new Response(JSON.stringify({ message: "Bad gateway" }), { status: 502 });
      }
    },
    ...tlsOptions,
  });

  let redirect: ReturnType<typeof Bun.serve<any, any>> | null = null;
  if (sslEnabled) {
    redirect = Bun.serve({
      hostname: "0.0.0.0",
      port: config.httpPort,
      development: false,
      reusePort: true,
      ...getHttpProtocolOptions(false),
      fetch(req: Request) {
        const url = tryParseURL(req.url);
        if (!url) {
          return new Response(JSON.stringify({ message: "Invalid request" }), { status: 400 });
        }
        // If the HTTPS port is 443, don't include it in the redirect
        const port = config.httpsPort === 443 ? "" : `:${config.httpsPort}`;
        return Response.redirect(`https://${url.hostname}${port}${url.pathname}${url.search}`, 301);
      },
    });
  }

  log.success(
    `[${config.name}] ${sslEnabled ? "HTTPS" : "HTTP"} proxy started on port ${publicPort} forwarding to ${internalUrl}` +
    (sslEnabled ? ` (HTTP->HTTPS redirect on port ${config.httpPort})` : "")
  );

  return { proxy, redirect, publicPort, internalUrl, sslEnabled };
}
