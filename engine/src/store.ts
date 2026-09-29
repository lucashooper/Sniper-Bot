import fs from "node:fs";
import path from "node:path";
import { env } from "./config.js";

/** Tiny JSON-file persistence. Writes are atomic (tmp file + rename). */
export function loadJson<T>(name: string, fallback: T): T {
  const file = path.join(env.dataDir, name);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function saveJson(name: string, value: unknown, mode = 0o600) {
  fs.mkdirSync(env.dataDir, { recursive: true });
  const file = path.join(env.dataDir, name);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode });
  fs.renameSync(tmp, file);
}
