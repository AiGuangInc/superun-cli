import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configRoot } from "../paths.js";

export interface Session {
  access_token: string;
  refresh_token?: string;
  /** epoch 秒 */
  expires_at?: number;
  strategy?: string;
}

function sessionDir(appId: string): string {
  return join(configRoot(), "sessions", appId);
}

function sessionFile(appId: string): string {
  return join(sessionDir(appId), "session.json");
}

export function loadSession(appId: string): Session | null {
  const f = sessionFile(appId);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, "utf8")) as Session;
  } catch {
    return null;
  }
}

export function saveSession(appId: string, s: Session): void {
  mkdirSync(sessionDir(appId), { recursive: true });
  writeFileSync(sessionFile(appId), JSON.stringify(s, null, 2), { mode: 0o600 });
}

export function clearSession(appId: string): void {
  const f = sessionFile(appId);
  if (existsSync(f)) rmSync(f);
}

/** 不验签地解出 JWT payload(仅用于 whoami / 读 exp) */
export function decodeJwt(token: string): Record<string, any> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}
