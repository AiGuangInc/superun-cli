import { createHash, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { AppConfig } from "../config/app.js";
import { decodeJwt, type Session } from "./session.js";

/** Hosted callback + polling transport for Supabase Authorization Code with PKCE.
 * This is not a device grant: the relay never receives the verifier or user tokens.
 */
export async function loginWithManaged(app: AppConfig, endpoint?: string): Promise<Session> {
  const relay = new URL(endpoint ?? `${app.baseUrl}/functions/v1/superun-oauth`);
  if (relay.protocol !== "https:" && !(relay.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(relay.hostname))) {
    throw new Error("Managed login requires HTTPS (HTTP is allowed only on loopback for local development)");
  }
  if (relay.username || relay.password || relay.search || relay.hash) {
    throw new Error("--managed-url must be a base URL without credentials, query or fragment");
  }
  const base = relay.href.replace(/\/+$/, "");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  // The anon key belongs to the selected project, never send it to another origin.
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (relay.origin === new URL(app.baseUrl).origin) headers.apikey = app.anonKey;
  const start = await fetch(`${base}/requests`, {
    method: "POST", headers, redirect: "error", signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ code_challenge: challenge, code_challenge_method: "S256" }),
  });
  const data = await start.json().catch(() => ({}));
  if (!start.ok) throw new Error(`Managed login unavailable (HTTP ${start.status}). Deploy the superun-oauth relay described in the integration guide.`);
  if (!data || typeof data !== "object") throw new Error("Managed login returned an invalid response");
  for (const key of ["request_id", "poll_token", "client_id", "redirect_uri", "authorization_url"]) {
    if (typeof data[key] !== "string" || !data[key]) throw new Error(`Managed login response is missing ${key}`);
  }
  const authorization = new URL(data.authorization_url);
  const callback = new URL(data.redirect_uri);
  const expectedAuth = new URL(`${app.baseUrl}/auth/v1/oauth/authorize`);
  if (authorization.origin !== expectedAuth.origin || authorization.pathname !== expectedAuth.pathname ||
      callback.href !== `${base}/callback` || authorization.searchParams.get("state") !== data.request_id ||
      authorization.searchParams.get("client_id") !== data.client_id ||
      authorization.searchParams.get("redirect_uri") !== callback.href ||
      authorization.searchParams.get("response_type") !== "code" ||
      authorization.searchParams.get("code_challenge") !== challenge ||
      authorization.searchParams.get("code_challenge_method") !== "S256") {
    throw new Error("Managed login returned an authorization URL that does not match this project and PKCE request");
  }
  if (!Number.isFinite(data.expires_in) || data.expires_in <= 0 || data.expires_in > 600 ||
      !Number.isFinite(data.interval) || data.interval < 1 || data.interval > 30) {
    throw new Error("Managed login returned invalid expiry or polling interval");
  }

  // Deliberately no browser spawn and no loopback listener. The host UI displays this
  // public URL to the human; the private polling credential stays inside this process.
  console.error(`Authorize this CLI in your browser:\n  ${authorization.href}\nWaiting for approval (up to ${data.expires_in}s)...`);
  const deadline = Date.now() + data.expires_in * 1000;
  while (Date.now() < deadline) {
    await delay(Math.min(data.interval * 1000, deadline - Date.now()));
    if (Date.now() >= deadline) break;
    const poll = await fetch(`${base}/poll`, {
      method: "POST", headers, redirect: "error",
      signal: AbortSignal.timeout(Math.min(15_000, Math.max(1, deadline - Date.now()))),
      body: JSON.stringify({ request_id: data.request_id, poll_token: data.poll_token }),
    });
    const result = (await poll.json().catch(() => null)) ?? {};
    if (poll.status === 202 && result.status === "pending") continue;
    if (result.error === "access_denied") throw new Error("Managed login was denied. No session was saved.");
    if (result.error === "expired_request") throw new Error("Managed login expired. Run superun login --managed again.");
    if (!poll.ok || result.status !== "authorized" || typeof result.code !== "string" || !result.code) {
      throw new Error(`Managed login polling failed (HTTP ${poll.status}). Run login again; no session was saved.`);
    }
    const tokenUrl = `${app.baseUrl}/auth/v1/oauth/token`;
    const exchange = await fetch(tokenUrl, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { apikey: app.anonKey, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: result.code,
        redirect_uri: data.redirect_uri, client_id: data.client_id, code_verifier: verifier }),
    });
    const tokens = (await exchange.json().catch(() => null)) ?? {};
    if (!exchange.ok || typeof tokens.access_token !== "string" || !tokens.access_token ||
        typeof tokens.refresh_token !== "string" || !tokens.refresh_token) {
      throw new Error(`Managed OAuth token exchange failed (HTTP ${exchange.status}). Run login again; no session was saved.`);
    }
    return {
      access_token: tokens.access_token, refresh_token: tokens.refresh_token,
      expires_at: tokens.expires_at ?? (tokens.expires_in ? Math.floor(Date.now() / 1000) + tokens.expires_in : decodeJwt(tokens.access_token)?.exp),
      strategy: "managed", oauth: { client_id: data.client_id, token_url: tokenUrl },
    };
  }
  throw new Error("Managed login timed out. Run superun login --managed again.");
}
