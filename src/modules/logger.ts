import path from "path";
import fs from "fs";

const LOG_LEVEL = process.env.LOG_LEVEL || "info";

const types = {
  info: "\x1b[97m",
  error: "\x1b[31m",
  warn: "\x1b[33m",
  success: "\x1b[32m",
  debug: "\x1b[34m",
  trace: "\x1b[95m",
  clear: "\x1b[0m",
};

// ANSI escape sequences (CSI and OSC, and the two-byte ones), and every other control character but the line feed.
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
const CONTROL = /[\x00-\x09\x0b-\x1f\x7f]/g;

/**
 * A message as it is written: no terminal escapes and no carriage returns,
 * and each line after the first indented, so text a player sent can neither
 * restyle the console nor pose as an entry of its own (entries start at the
 * margin with their time).
 */
export function cleanLogMessage(message: string): string {
  return String(message)
    .replace(ANSI, "")
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL, "")
    .replace(/\n/g, "\n    ");
}

const log = {
  type: (_type: string) => types[_type.toLowerCase() as keyof typeof types],
  date: () => new Date().toLocaleDateString().split("/").join("-"),
  timestamp: () => new Date().toLocaleTimeString(),
  createLogFile: async (message: string, type: string) => {
    const timestamp = log.timestamp();

    const _folder = path.join(import.meta.dir, "..", "logs");
    if (!fs.existsSync(_folder)) {
      fs.mkdirSync(_folder);
    }

    const _file = path.join(import.meta.dir, "..", "logs", `${log.date()}.log`);

    if (!fs.existsSync(_file)) {
      fs.writeFileSync(_file, "");
    }

    message = `\n${cleanLogMessage(message)}\n`;
    fs.appendFileSync(_file, `${timestamp} ${message}`);

    const _message = `${log.type(type)}- ${timestamp} - ${message} ${log.type(
      "clear"
    )}`;
    console.log(_message);
  },
  info: (msg: string) => {
    log.createLogFile(`${msg}`, "info");
  },
  error: (msg: string) => {
    log.createLogFile(`❌  ${msg}`, "error");
  },
  warn: (msg: string) => {
    log.createLogFile(`⚠  ${msg}`, "warn");
  },
  success: (msg: string) => {
    log.createLogFile(`✔  ${msg}`, "success");
  },
  debug: (msg: string) => {
    if (LOG_LEVEL !== "debug" && LOG_LEVEL !== "trace") return;
    log.createLogFile(`🛠  ${msg}`, "debug");
  },
  trace: (msg: string) => {
    if (LOG_LEVEL !== "trace") return;
    log.createLogFile(`🛠  ${msg}`, "trace");
  },
  object: (obj: any) => {
    log.createLogFile(`🛠  ${JSON.stringify(obj, null, 2)}`, "info");
  },
};

export default log;
