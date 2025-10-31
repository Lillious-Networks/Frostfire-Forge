import path from "path";
import fs from "fs";
import * as settings from "../config/settings.json";

const types = {
  info: "\x1b[97m",
  error: "\x1b[31m",
  warn: "\x1b[33m",
  success: "\x1b[32m",
  debug: "\x1b[34m",
  trace: "\x1b[95m",
  clear: "\x1b[0m",
};

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

    message = `\n${message}\n`;
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
    if (settings.logging.level !== "debug" && settings.logging.level !== "trace") return;
    log.createLogFile(`🛠  ${msg}`, "debug");
  },
  trace: (msg: string) => {
    if (settings.logging.level !== "trace") return;
    log.createLogFile(`🛠  ${msg}`, "trace");
  },
  object: (obj: any) => {
    log.createLogFile(`🛠  ${JSON.stringify(obj, null, 2)}`, "info");
  },
};

export default log;
