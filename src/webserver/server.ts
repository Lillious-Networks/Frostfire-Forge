import '../utility/validate_config';
import SwaggerHTML from './swagger';
const now = performance.now();
import log from "../modules/logger";
import sendEmail from "../services/email";
import player from "../systems/player";
import verify from "../services/verification";
import { hash, randomBytes } from "../modules/hash";
import query from "../controllers/sqldatabase";
import * as settings from "../config/settings.json";
import path from "path";
import fs from "fs";
import editor_html from "./www/public/editor.html";
import benchmark_html from "./www/public/benchmark.html";
import connectiontest_html from "./www/public/connection-test.html";
import login_html from "./www/public/index.html";
import register_html from "./www/public/register.html";
import game_html from "./www/public/game.html";
import forgotpassword_html from "./www/public/forgot-password.html";
import changepassword_html from "./www/public/change-password.html";

// Load whitelisted and blacklisted IPs and functions
import { w_ips, b_ips, blacklistAdd } from "../systems/security";

// Load security rules from security.cfg
const security = fs.existsSync(path.join(import.meta.dir, "../../config/security.cfg")) 
  ? fs.readFileSync(path.join(import.meta.dir, "../../config/security.cfg"), "utf8").split("\n").filter(line => line.trim() !== "" && !line.startsWith("#"))
  : [];

if (security.length > 0) {
  log.success(`Loaded ${security.length} security rules`);
} else {
  log.warn("No security rules found");
}

// Load assets
import "../modules/assetloader";

import assetCache from "../services/assetCache";

const _cert = path.join(import.meta.dir, "../certs/cert.pem");
const _key = path.join(import.meta.dir, "../certs/key.pem");
const _https = process.env.WEBSRV_USESSL === "true" && fs.existsSync(_cert) && fs.existsSync(_key);

const routes = {
  "/swaggerui": {
    GET: async () => {
      return new Response(SwaggerHTML, {
        headers: {
          "Content-Type": "text/html",
        },
      });
    }
  },
  "/api.json": {
    GET: async () => {
      const apiSpecPath = path.join(import.meta.dir, "./www/public/api.json");
      if (!fs.existsSync(apiSpecPath)) {
        return new Response(JSON.stringify({ message: "API specification not found" }), { status: 404 });
      }
      const apiSpec = fs.readFileSync(apiSpecPath, "utf8");
      return new Response(apiSpec, {
        headers: {
          "Content-Type": "application/json",
        },
      });
    }
  },
  "/benchmark": benchmark_html,
  "/connection-test": connectiontest_html,
  "/": login_html,
  "/registration": register_html,
  "/game": game_html,
  "/editor": editor_html,
  "/login": (req: Request, server: any) => login(req, server),
  "/verify": (req: Request, server: any) => authenticate(req, server),
  "/register": (req: Request, server: any) => register(req, server),
  "/guest-login": async (req: Request, server: any) => createGuestAccount(req, server),
  "/forgot-password": forgotpassword_html,
  "/change-password": changepassword_html,
  "/reset-password": async (req: Request, server: any) => {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ message: "Invalid request" }), { status: 400 });
    }
    return await resetPassword(req, server);
  },
  "/update-password": async (req: Request, server: any) => {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ message: "Invalid request" }), { status: 400 });
    }
    return await updatePassword(req, server);
  },
  "/tileset" : async (req: Request) => {
    const tilesets = await assetCache.get("tilesets");
    if (req.method !== "GET") {
      return new Response(JSON.stringify({ message: "Invalid request" }), { status: 400 });
    }
    const url = tryParseURL(req.url);
    if (!url) {
      return new Response(JSON.stringify({ message: "Invalid request" }), { status: 400 });
    }
    const tilesetName = url.searchParams.get("name");
    if (!tilesetName) {
      return new Response(JSON.stringify({ message: "Invalid request" }), { status: 400 });
    }

    for (const key of Object.keys(tilesets)) {
      if (tilesets[key].name === tilesetName) {
        return new Response(JSON.stringify({ tileset: tilesets[key] }), { status: 200 });
      }
    }
    return new Response(JSON.stringify({ message: "Tileset not found" }), { status: 404 });
  },
  "/map-chunk": async (req: Request) => {
    if (req.method !== "GET") {
      return new Response(JSON.stringify({ message: "Invalid request" }), { status: 400 });
    }
    const url = tryParseURL(req.url);
    if (!url) {
      return new Response(JSON.stringify({ message: "Invalid request" }), { status: 400 });
    }

    const mapName = url.searchParams.get("map");
    const chunkX = parseInt(url.searchParams.get("x") || "");
    const chunkY = parseInt(url.searchParams.get("y") || "");
    const chunkSize = parseInt(url.searchParams.get("size") || "25");

    if (!mapName || isNaN(chunkX) || isNaN(chunkY) || isNaN(chunkSize)) {
      return new Response(JSON.stringify({ message: "Invalid parameters" }), { status: 400 });
    }

    try {
      const maps = await assetCache.get("maps") as any[];
      const map = maps.find((m: any) => m.name === mapName || m.name === `${mapName}.json`);

      if (!map) {
        return new Response(JSON.stringify({ message: "Map not found" }), { status: 404 });
      }

      // Check if there's a saved chunk in memory first
      const chunkKey = `${chunkX}-${chunkY}`;
      if (map.chunks && map.chunks[chunkKey]) {
        // Return the saved chunk directly
        const savedChunk = map.chunks[chunkKey];
        const response = {
          chunkX,
          chunkY,
          startX: chunkX * chunkSize,
          startY: chunkY * chunkSize,
          width: savedChunk.width,
          height: savedChunk.height,
          tilewidth: map.data.tilewidth,
          tileheight: map.data.tileheight,
          layers: savedChunk.layers,
        };

        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Otherwise, extract from original map data
      const mapData = map.data;
      const startX = chunkX * chunkSize;
      const startY = chunkY * chunkSize;
      const endX = Math.min(startX + chunkSize, mapData.width);
      const endY = Math.min(startY + chunkSize, mapData.height);

      // Validate chunk bounds
      if (startX >= mapData.width || startY >= mapData.height) {
        return new Response(JSON.stringify({ message: "Chunk out of bounds" }), { status: 400 });
      }

      // Extract chunk data for each layer
      const chunkLayers = mapData.layers
        .filter((layer: any) => {
          // Include visible layers and collision/no-pvp layers for debug purposes
          if (layer.type !== "tilelayer") return false;
          if (layer.visible) return true;
          // Include invisible collision and no-pvp layers
          const layerName = layer.name ? layer.name.toLowerCase() : '';
          return layerName.includes('collision') || layerName.includes('nopvp') || layerName.includes('no-pvp');
        })
        .map((layer: any, index: number) => {
          const chunkData: number[] = [];
          for (let y = startY; y < endY; y++) {
            for (let x = startX; x < endX; x++) {
              const tileIndex = layer.data[y * mapData.width + x];
              chunkData.push(tileIndex);
            }
          }

          // Use custom zIndex property if available, otherwise use layer index from original array
          let zIndex = layer.zIndex;
          if (zIndex === undefined) {
            // Find original index in unfiltered layers array
            const originalIndex = mapData.layers.findIndex((l: any) => l === layer);
            zIndex = originalIndex !== -1 ? originalIndex : index;
          }

          return {
            name: layer.name,
            zIndex: zIndex,
            data: chunkData,
            width: endX - startX,
            height: endY - startY,
          };
        });

      const response = {
        chunkX,
        chunkY,
        startX,
        startY,
        width: endX - startX,
        height: endY - startY,
        tilewidth: mapData.tilewidth,
        tileheight: mapData.tileheight,
        tilesets: mapData.tilesets,
        layers: chunkLayers,
      };

      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    } catch (error: any) {
      log.error(`Error serving map chunk: ${error.message}`);
      return new Response(JSON.stringify({ message: "Internal server error" }), { status: 500 });
    }
  },
} as Record<string, any>;

Bun.serve({
    port: _https ? (process.env.WEBSRV_PORTSSL || 443) : (process.env.WEBSRV_PORT || 80),
    routes: {
      "/swaggerui": routes["/swaggerui"],
      "/benchmark": routes["/benchmark"],
      "/connection-test": routes["/connection-test"],
      "/": routes["/"],
      "/registration": routes["/registration"],
      "/register": routes["/register"],
      "/guest-login": routes["/guest-login"],
      "/forgot-password": routes["/forgot-password"],
      "/change-password": routes["/change-password"],
      "/reset-password": routes["/reset-password"],
      "/update-password": routes["/update-password"],
      "/game": routes["/game"],
      "/editor": routes["/editor"],
      "/login": routes["/login"],
      "/verify": routes["/verify"],
      "/tileset": routes["/tileset"],
      "/map-chunk": routes["/map-chunk"],
    },
  async fetch(req: Request, server: any) {
    const url = tryParseURL(req.url);
    if (!url) {
      return new Response(JSON.stringify({ message: "Invalid request" }), { status: 400 });
    }
    const address = server.requestIP(req);
    if (!address) {
      return new Response(JSON.stringify({ message: "Invalid request" }), { status: 400 });
    }
    const ip = address.address;
    log.debug(`Received request: ${req.method} ${req.url} from ${ip}`);
    // Check if the ip is blacklisted
    if (b_ips.includes(ip)) {
      return new Response(JSON.stringify({ message: "Invalid request" }), { status: 403 });
    }
    // Check if the ip is whitelisted
    if (!w_ips.includes(ip)) {
      const path = url.pathname.split("/")[1];
      if (security.includes(path)) {
        // Ban the IP
        await blacklistAdd(ip);
        return new Response(JSON.stringify({ message: "Invalid request" }), { status: 403 });
      }
    }

    // Restrict direct ip access to the webserver
    if (process.env.DOMAIN?.replace(/https?:\/\//, "") !== url.host) {
      return new Response(JSON.stringify({ message: "Invalid request" }), { status: 403 });
    }

    const route = routes[url.pathname as keyof typeof routes];
    if (!route) {
      return Response.redirect("/", 301);
    }
    return route[req.method as keyof typeof route]?.(req);
  },
  ...(_https ? {
      cert: fs.readFileSync(_cert),
      key: fs.readFileSync(_key),
    }
  : {}),
});
// If HTTPS is enabled, also start an HTTP server that redirects to HTTPS
if (_https) {
  Bun.serve({
    port: process.env.WEBSRV_PORT || 80,
    fetch(req: Request) {
      const url = tryParseURL(req.url);
      if (!url) {
        return new Response(JSON.stringify({ message: "Invalid request" }), { status: 400 });
      }
      // Always redirect to https with same host/path/query
      // If the port is 443, don't include it in the redirect
      const port = process.env.WEBSRV_PORTSSL === "443" ? "" : `:${process.env.WEBSRV_PORTSSL || 443}`;
      return Response.redirect(`https://${url.hostname}${port}${url.pathname}${url.search}`, 301);
    }
  });
}

async function authenticate(req: Request, server: any) {
  // Check if ip banned
  const ip = server.requestIP(req)?.address;
  if (b_ips.includes(ip) && !w_ips.includes(ip)) {
    return new Response(JSON.stringify({ message: "Invalid request" }), { status: 403 });
  }
  const url = tryParseURL(req.url);
  if (!url) {
    return new Response(JSON.stringify({ message: "Invalid request" }), { status: 400 });
  }
  const email = url.searchParams.get("email");
  const token = url.searchParams.get("token");
  const code = url.searchParams.get("code");

  if (!token || !code || !email) {
    return new Response(JSON.stringify({ message: "Invalid request" }), { status: 403 });
  }

  const result = await query("SELECT * FROM accounts WHERE token = ? AND email = ? AND verification_code = ? LIMIT 1", [token, email.toLowerCase(), code]) as any;
  if (result.length === 0) {
    return new Response(JSON.stringify({ message: "Invalid request" }), { status: 403 });
  }

  await query("UPDATE accounts SET verified = 1 WHERE token = ?", [token]);
  await query("UPDATE accounts SET verification_code = NULL WHERE token = ?", [token]);

  // Send to /game
  return Response.redirect(`${process.env.DOMAIN}/game`, 301);
}

async function createGuestAccount(req: Request, server: any) {
  try {
    if (!settings.guest_mode?.enabled) {
      return new Response(JSON.stringify({ message: "Guest mode is disabled" }), { status: 403 });
    }
    const ip = server.requestIP(req)?.address;
    if (b_ips.includes(ip) && !w_ips.includes(ip)) {
      return new Response(JSON.stringify({ message: "Invalid request" }), { status: 403 });
    }

    const guest_username = `guest_${randomBytes(12)}`;
    const domain = process.env.DOMAIN?.replace(/^https?:\/\//, "");
    const guest_email = `${guest_username}@${domain}`;
    const guest_password = `guest_${randomBytes(12)}`;
    const guest_password_hash = await hash(guest_password);

    const user = await player.register(guest_username.toLowerCase(), guest_password_hash, guest_email, req, true) as any;
    if (!user) {
      return new Response(JSON.stringify({ message: "Failed to create guest account" }), { status: 500 });
    }

    if (user.error) {
      return new Response(JSON.stringify({ message: user.error }), { status: 400 });
    }

    const token = await player.login(guest_username.toLowerCase(), guest_password);
    if (!token) {
      log.debug(`Failed to login guest user after registration: ${guest_username} (${ip})`);
      return new Response(JSON.stringify({ message: "Failed to create guest account" }), { status: 500 });
    }

    log.debug(`Guest account created: ${guest_username} (${ip})`);

    return new Response(JSON.stringify({ message: "Logged in successfully"}), { status: 301, headers: { "Set-Cookie": `token=${token}; Path=/;` } });

  } catch (error) {
    log.error(`Failed to create guest account: ${error}`);
    return new Response(JSON.stringify({ message: "Failed to create guest account" }), { status: 500 });
  }
}

async function register(req: Request, server: any) {
  try {
    // Check if ip banned
    const ip = server.requestIP(req)?.address;
    if (b_ips.includes(ip) && !w_ips.includes(ip)) {
      return new Response(JSON.stringify({ message: "Invalid request" }), { status: 403 });
    }
    const body = await req.json();
    const { username, email, password, password2 } = body;
    if (!username || !password || !email || !password2) {
      return new Response(JSON.stringify({ message: "All fields are required" }), { status: 400 });
    }

    if (password !== password2) {
      return new Response(JSON.stringify({ message: "Passwords do not match" }), { status: 400 });
    }

    if (!validateUsername(username)) {
      return new Response(JSON.stringify({ message: "Invalid username" }), { status: 400 });
    }

    if (validatePasswordComplexity(password) === false) {
      return new Response(JSON.stringify({ message: "Password must be between 8 and 20 characters long, contain at least one uppercase letter, one lowercase letter, one number, and one special character." }), { status: 400 });
    }

    if (!validateEmail(email)) {
      return new Response(JSON.stringify({ message: "Invalid email format" }), { status: 400 });
    }

    const password_hash = await hash(password);

    const user = await player.register(username.toLowerCase(), password_hash, email.toLowerCase(), req, false) as any;
    if (!user) {
      return new Response(JSON.stringify({ message: "Failed to register" }), { status: 400 });
    }

    if (user.error) {
      return new Response(JSON.stringify({ message: user.error }), { status: 400 });
    }

    const token = await player.login(username.toLowerCase(), password);
    if (!token) {
      return new Response(JSON.stringify({ message: "Invalid credentials" }), { status: 400 });
    }

    if (settings['2fa'].enabled) {
      const result = await verify(token, email.toLowerCase(), username.toLowerCase()) as any;

      if (result instanceof Error) {
        return new Response(JSON.stringify({ message: "Failed to send verification email" }), { status: 500 });
      }
      return new Response(JSON.stringify({ message: "Verification email sent" }), { status: 200 });
    } else {
      return new Response(JSON.stringify({ message: "Logged in successfully"}), { status: 301, headers: { "Set-Cookie": `token=${token}; Path=/;` } });
    }
  } catch (error) {
    return new Response(JSON.stringify({ message: "Failed to register", error: error instanceof Error ? error.message : "Unknown error" }), { status: 500 });
  }
}

async function login(req: Request, server: any) {
  try {
    // Check if ip banned
    const ip = server.requestIP(req)?.address;
    if (b_ips.includes(ip) && !w_ips.includes(ip)) {
      return new Response(JSON.stringify({ message: "Invalid request" }), { status: 403 });
    }
    const body = await req.json();
    const { username, password } = body;
    if (!username || !password) {
      return new Response(JSON.stringify({ message: "Invalid credentials" }), { status: 400 });
    }

    if (!validateUsername(username)) {
      return new Response(JSON.stringify({ message: "Invalid username" }), { status: 400 });
    }

    if (password.length < 8 || password.length > 20) {
      return new Response(JSON.stringify({ message: "Password must be between 8 and 20 characters long" }), { status: 400 });
    }

    const token = await player.login(username.toLowerCase(), password);
    if (!token) {
      return new Response(JSON.stringify({ message: "Invalid credentials" }), { status: 400 });
    }

    const useremail = await player.getEmail(username.toLowerCase()) as string;
    if (!useremail) {
      return new Response(JSON.stringify({ message: "Invalid credentials" }), { status: 400 });
    }

    if (!settings["2fa"].enabled) {
      // Update the account to verified
      await query("UPDATE accounts SET verified = 1 WHERE token = ?", [token]);

      // Remove any verification code that may exist
      await query("UPDATE accounts SET verification_code = NULL WHERE token = ?", [token]);
      // 2FA is not enabled, so we can just return the token
      return new Response(JSON.stringify({ message: "Logged in successfully"}), { status: 301, headers: { "Set-Cookie": `token=${token}; Path=/;` } });
    } else {
      // 2FA is enabled, so we need to send a verification email
      const result = await verify(token, useremail.toLowerCase(), username.toLowerCase()) as any;
      if (result instanceof Error) {
        return new Response(JSON.stringify({ message: "Failed to send verification email" }), { status: 500 });
      }
      // Return a 200
      return new Response(JSON.stringify({ message: "Verification email sent"}), { status: 200, headers: { "Set-Cookie": `token=${token}; Path=/;` } });
    }
  } catch (error) {
    log.error(`Failed to authenticate: ${error}`);
    return new Response(JSON.stringify({ message: "Failed to authenticate" }), { status: 500 });
  }
}

async function resetPassword(req: Request, server: any) {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ message: "Invalid request" }), { status: 400 });
  }
  const responseMessage = `If the email you provided is registered, you will receive an email with instructions to reset your password.`;
      // Check if ip banned
    const ip = server.requestIP(req)?.address;
    if (b_ips.includes(ip) && !w_ips.includes(ip)) {
      return new Response(JSON.stringify({ message: "Invalid request" }), { status: 403 });
    }
  const body = await req.json();

  if (!body.email) {
    return new Response(JSON.stringify({ message: "Email is required" }), { status: 400 });
  }

  const email = body.email.toLowerCase();

  if (!validateEmail(email)) {
    return new Response(JSON.stringify({ message: "Invalid email" }), { status: 400 });
  }

  // Check if the email exists in the database
  const result = await query("SELECT email FROM accounts WHERE email = ? LIMIT 1", [email]) as any;
  // Don't tip off the user if the email does not exist
  if (result.length === 0) {
    return new Response(JSON.stringify({ message: responseMessage }), { status: 200 });
  }

  // Generate a random code to use for password reset verification
  const code = randomBytes(8);

  // Send the email with the reset link
  const gameName = process.env.GAME_NAME || process.env.DOMAIN || "Game";
  const subject = `${gameName} - Reset your password`;
  const url = `${process.env.DOMAIN}/change-password?email=${email}&code=${code}`;
  const message = `<p style="font-size: 20px;"><a href="${url}">Reset password</a></p><br><p style="font-size:12px;">If you did not request this, please ignore this email.</p>`;
  const emailResponse = await sendEmail(email, subject, gameName, message);
  if (emailResponse !== "Email sent successfully") {
    log.error(`Failed to send reset password email: ${emailResponse}`);
    // We can return a 500 error here because the email doesn't exist in general or the email service failed
    return new Response(JSON.stringify({ message: "Failed to send reset password email" }), { status: 500 });
  }

  await query("UPDATE accounts SET reset_password_code = ? WHERE email = ?", [code, email]);

  return new Response(JSON.stringify({ message: responseMessage }), { status: 200 });
}

async function updatePassword(req: Request, server: any) {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ message: "Invalid request" }), { status: 400 });
  }
  // Check if ip banned
  const ip = server.requestIP(req)?.address;
  if (b_ips.includes(ip) && !w_ips.includes(ip)) {
    return new Response(JSON.stringify({ message: "Invalid request" }), { status: 403 });
  }
  const body = await req.json();

  if (!body.email || !body.password || !body.password2 || !body.code) {
    return new Response(JSON.stringify({ message: "All fields are required" }), { status: 400 });
  }

  if (!validateEmail(body.email)) {
    return new Response(JSON.stringify({ message: "Invalid email" }), { status: 400 });
  }

  if (body.password !== body.password2) {
    return new Response(JSON.stringify({ message: "Passwords do not match" }), { status: 400 });
  }

  if (!validatePasswordComplexity(body.password)) {
    return new Response(JSON.stringify({ message: "Password must be between 8 and 20 characters long, contain at least one uppercase letter, one lowercase letter, one number, and one special character." }), { status: 400 });
  }

  // Check if the account exists
  const account = await query("SELECT * FROM accounts WHERE email = ? LIMIT 1", [body.email.toLowerCase()]) as any;
  if (account.length === 0) {
    log.warn(`Attempt to update password for non-existent email: ${body.email.toLowerCase()}`);
    return new Response(JSON.stringify({ message: "Failed to update password" }), { status: 500 });
  }

  // Check if the reset password code matches
  const codeResult = await query("SELECT reset_password_code FROM accounts WHERE email = ? AND reset_password_code = ? LIMIT 1", [body.email.toLowerCase(), body.code]) as any;
  if (codeResult.length === 0) {
    log.warn(`Invalid reset password code for email: ${body.email.toLowerCase()}`);
    return new Response(JSON.stringify({ message: "Invalid reset password code" }), { status: 403 });
  }

  // Update the password
  const hashedPassword = await hash(body.password);
  const updateResult = await query("UPDATE accounts SET password_hash = ?, reset_password_code = NULL, verified = 0, verification_code = NULL WHERE email = ?", [hashedPassword, body.email.toLowerCase()]);
  if (!updateResult) {
    log.error(`Failed to update password for email: ${body.email.toLowerCase()}`);
    return new Response(JSON.stringify({ message: "Failed to update password" }), { status: 500 });
  }

  log.debug(`Password updated successfully for email: ${body.email.toLowerCase()}`);

  if (account.session_id) {
    // If the user is logged in, we need to logout the user
    player.logout(account.session_id);
  }

  return new Response(JSON.stringify({ message: "Password updated successfully" }), { status: 200 });
}

function validatePasswordComplexity(password: string): boolean {
  const hasUpperCase = /[A-Z]/.test(password);
  const hasLowerCase = /[a-z]/.test(password);
  const hasNumbers = /\d/.test(password);
  const hasSpecialCharacter = /[!@#$%^&*(),.?":{}|<>]/.test(password);
  const isValidLength = password.length >= 8 && password.length <= 20;
  return hasUpperCase && hasLowerCase && hasNumbers && hasSpecialCharacter && isValidLength;
}

function validateUsername(username: string): boolean {
  const regex = /^[a-zA-Z0-9_]{3,15}$/; // Alphanumeric and underscores, 3-15 characters
  return regex.test(username);
}

function validateEmail(email: string): boolean {
  const regex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,100}$/;
  return regex.test(email);
}

function tryParseURL(url: string) : URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

const readyTimeMs = performance.now() - now;
log.success(`Webserver started on port ${_https ? "443 (HTTPS)" : "80 (HTTP)"} - Ready in ${(readyTimeMs / 1000).toFixed(3)}s (${readyTimeMs.toFixed(0)}ms)`);
await import('../socket/server');