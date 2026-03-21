import fs from "fs";
import path from "path";
import * as readline from "node:readline/promises";
import log from "../modules/logger";
const security = path.join(import.meta.dir, "..", "..", "config", "security.cfg");

if (!fs.existsSync(path.join(import.meta.dir, "..", "..", "config"))) {
    fs.mkdirSync(path.join(import.meta.dir, "..", "..", "config"));
}
if (!fs.existsSync(security)) {
  fs.writeFileSync(security, "# Security Definitions\n");
}

if (fs.existsSync(security)) {
  log.success(`Loaded security.cfg`);
}
export function checkSecurityRule(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(security),
    });
    rl.on("line", (rule: string) => {
      if (rule.startsWith("#")) return;
      if (url.includes(rule)) {
        resolve(true);
      }
    })
      .on("close", () => {
        reject("NOT_FOUND");
      })
      .on("error", (err: any) => {
        log.error(err);
        reject("Error reading security.cfg");
      });
  });
}

export function addSecurityRule(rule: string): Promise<any> {
  return new Promise((resolve, reject) => {
    checkSecurityRule(rule)
      .then(() => {
        reject("Rule already exists");
      })
      .catch(() => {

        fs.readFile(security, (err: any, data: Buffer) => {
          if (err) {
            log.error(err);
            reject("Error reading security.cfg");
          }
          if (!data.toString().endsWith("\n")) rule = "\n" + rule;
          fs.appendFile(security, rule + "\n", (err: any) => {
            if (err) {
              log.error(err);
              reject("Error writing to security.cfg");
            }
            resolve(true);
          });
        });
      });
  });
}

export function removeSecurityRule(rule: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(security),
    });
    const lines: string[] = [];
    rl.on("line", (line: string) => {
      if (line.startsWith("#")) return;
      if (line !== rule) lines.push(line);
    })
      .on("close", () => {
        fs.writeFile(security, lines.join("\n"), (err: any) => {
          if (err) {
            log.error(err);
            reject("Error writing to security.cfg");
          }
          resolve(true);
        });
      })
      .on("error", (err: any) => {
        log.error(err);
        reject("Error reading security.cfg");
      });
  });
}
