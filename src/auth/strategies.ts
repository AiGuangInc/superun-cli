import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import type { AppConfig } from "../config/app.js";
import { request } from "../transport/client.js";
import { decodeJwt, type Session } from "./session.js";

export type StrategyId = "token" | "password" | "otp" | "browser" | "custom";

/** Manual token entry: a fallback that works with any app. Accepts an access token alone, or with a refresh token. */
export function loginWithToken(token: string, refresh?: string): Session {
  const claims = decodeJwt(token);
  return { access_token: token, refresh_token: refresh, expires_at: claims?.exp, strategy: "token" };
}

/** GoTrue 邮箱密码:标准 /auth/v1/token?grant_type=password */
export async function loginWithPassword(app: AppConfig, email: string, password: string): Promise<Session> {
  const { status, body } = await request(app, null, {
    method: "POST",
    path: "/auth/v1/token",
    query: { grant_type: "password" },
    body: { email, password },
  });
  if (status !== 200) throw new Error(`Login failed, HTTP ${status}: ${JSON.stringify(body)}`);
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_at: body.expires_at ?? (body.expires_in ? Math.floor(Date.now() / 1000) + body.expires_in : undefined),
    strategy: "password",
  };
}

export interface BrowserOpts {
  port: number;
  /** 覆盖项:对接非 Supabase 的自有 OAuth AS 时用;默认走该项目 OAuth server 的 discovery。 */
  authorizeUrl?: string;
  tokenUrl?: string;
  clientId?: string;
}

/**
 * 浏览器登录 = 标准 OAuth 2.1 授权码 + PKCE(RFC 6749 / 7636 / 8252)。
 * 默认对接该 Supabase 项目自带的 OAuth 2.1 授权服务器:
 *   ① OIDC discovery 取端点(/auth/v1/.well-known/openid-configuration)
 *   ② RFC 7591 动态客户端注册(DCR)拿 client_id,本地缓存
 *   ③ 授权码 + PKCE → token(同意页由 Supabase 出)
 * 后端需开:GOTRUE_OAUTH_SERVER_ENABLED=true + GOTRUE_OAUTH_SERVER_ALLOW_DYNAMIC_REGISTRATION=true。
 * 给了 authorizeUrl/tokenUrl/clientId 则走自有 AS。SUPERUN_NO_OPEN=1 不自动开浏览器。
 */
export async function loginWithBrowser(app: AppConfig, opts: BrowserOpts): Promise<Session> {
  let authorizeUrl = opts.authorizeUrl;
  let tokenUrl = opts.tokenUrl;
  let registrationUrl: string | undefined;
  if (!authorizeUrl || !tokenUrl) {
    const d = await discover(app);
    authorizeUrl = authorizeUrl ?? d.authorize;
    tokenUrl = tokenUrl ?? d.token;
    registrationUrl = d.register;
  }

  let clientId = opts.clientId ?? readCachedClientId(app, opts.port);
  if (!clientId) {
    if (!registrationUrl) {
      throw new Error(
        "No client_id available, and discovery exposes no registration_endpoint. " +
          "Enable GOTRUE_OAUTH_SERVER_ALLOW_DYNAMIC_REGISTRATION=true on the backend, or pass --oauth-client-id.",
      );
    }
    clientId = await dynamicRegister(app, registrationUrl, opts.port);
    writeCachedClientId(app, opts.port, clientId);
  }

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("hex");
  const redirect = `http://localhost:${opts.port}`;

  const code = await new Promise<string>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", redirect);
      if (u.pathname === "/favicon.ico") {
        res.writeHead(204, { connection: "close" }).end();
        return;
      }
      const sp = u.searchParams;
      const c = sp.get("code");
      const err = sp.get("error_description") ?? sp.get("error");
      const ok = !err && !!c && sp.get("state") === state;
      // Connection: close —— 不让浏览器保持 keep-alive,否则 server.close() 关不掉这条 socket,
      // event loop 残留活跃 handle,CLI 拿到 session 后进程不退出、一直挂住。
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", connection: "close" });
      const msg = ok
        ? "✅ Authorized. You can close this page."
        : "❌ Login failed: " + escapeHtml(err ?? "callback missing code or state mismatch");
      res.end(
        `<!doctype html><meta charset=utf-8><title>superun</title>` +
          `<body style="font:16px/1.7 system-ui,sans-serif;text-align:center;margin-top:20vh;color:#333">` +
          `<p>${msg}</p>` +
          // 成功页尝试自我关闭(多数浏览器禁止脚本关非脚本打开的页,关不掉就停在这行字上)
          (ok ? `<script>setTimeout(function(){window.close()},500)</script>` : ``) +
          `</body>`,
      );
      clearTimeout(timer);
      server.close();
      if (err) reject(new Error(err));
      else if (!c) reject(new Error("Callback did not include a code"));
      else if (sp.get("state") !== state) reject(new Error("State mismatch (possible CSRF); aborted"));
      else resolve(c);
    });
    server.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    server.listen(opts.port, () => {
      const sep = authorizeUrl!.includes("?") ? "&" : "?";
      const url =
        `${authorizeUrl}${sep}response_type=code&client_id=${encodeURIComponent(clientId!)}` +
        `&redirect_uri=${encodeURIComponent(redirect)}&state=${state}` +
        // 只要 email,不要 openid:带 openid 会让 GoTrue 签发 OIDC id_token,
        // 项目若没配非对称签名密钥会 500;我们只需要 access_token(用户会话 JWT)。
        `&code_challenge=${challenge}&code_challenge_method=S256&scope=${encodeURIComponent("email")}` +
        // 浏览器导航带不了请求头,把 anon apikey 放进 query 让 Kong 网关放行(anon key 本就是公开的)
        `&apikey=${encodeURIComponent(app.anonKey)}`;
      console.error(`Sign in and authorize in your browser (if it does not open automatically, visit this URL):\n  ${url}`);
      openBrowser(url);
      timer = setTimeout(() => {
        server.close();
        reject(new Error("Login timed out (no callback within 3 minutes)"));
      }, 180_000);
    });
  });

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirect,
    client_id: clientId,
    code_verifier: verifier,
  });
  const res = await fetch(tokenUrl!, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", apikey: app.anonKey },
    body: form.toString(),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error(`Token exchange failed, HTTP ${res.status}: ${JSON.stringify(body)}`);
  const claims = decodeJwt(body.access_token);
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_at: body.expires_at ?? (body.expires_in ? Math.floor(Date.now() / 1000) + body.expires_in : claims?.exp),
    strategy: "browser",
  };
}

// Not yet implemented: otp (email one-time code) / custom (app's own non-browser login endpoint)
export function notImplemented(id: StrategyId): never {
  throw new Error(`Login strategy "${id}" is not yet implemented. Use --token as a fallback for now.`);
}

// ---- OAuth 2.1 server 对接(discovery + DCR)----

async function discover(app: AppConfig): Promise<{ authorize: string; token: string; register?: string }> {
  const res = await fetch(`${app.baseUrl}/auth/v1/.well-known/openid-configuration`, {
    headers: { apikey: app.anonKey },
  });
  if (!res.ok) throw new Error(`Failed to fetch OIDC discovery, HTTP ${res.status} (the backend OAuth server may be disabled)`);
  const d: any = await res.json();
  // discovery 端点可能是绝对 URL,也可能是相对 /oauth/... (经 Kong 挂在 /auth/v1 下)
  const abs = (p?: string): string | undefined =>
    !p ? undefined : /^https?:\/\//.test(p) ? p : `${app.baseUrl}/auth/v1${p.startsWith("/") ? p : "/" + p}`;
  const authorize = abs(d.authorization_endpoint);
  const token = abs(d.token_endpoint);
  if (!authorize || !token) {
    throw new Error("Discovery is missing the authorization/token endpoint (is the backend OAuth server enabled?)");
  }
  return { authorize, token, register: abs(d.registration_endpoint) };
}

async function dynamicRegister(app: AppConfig, registrationUrl: string, port: number): Promise<string> {
  const res = await fetch(registrationUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", apikey: app.anonKey },
    body: JSON.stringify({
      client_name: "superun",
      redirect_uris: [`http://localhost:${port}`, `http://127.0.0.1:${port}`],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "native",
    }),
  });
  const b: any = await res.json().catch(() => ({}));
  if (!res.ok || !b.client_id) {
    throw new Error(`Dynamic client registration failed, HTTP ${res.status}: ${JSON.stringify(b)}`);
  }
  return b.client_id;
}

function clientCacheFile(app: AppConfig): string {
  return join(app.runtimeDir, "oauth-client.json");
}
function readCachedClientId(app: AppConfig, port: number): string | undefined {
  const f = clientCacheFile(app);
  if (!existsSync(f)) return undefined;
  try {
    const c = JSON.parse(readFileSync(f, "utf8"));
    return c.port === port ? c.client_id : undefined;
  } catch {
    return undefined;
  }
}
function writeCachedClientId(app: AppConfig, port: number, clientId: string): void {
  mkdirSync(app.runtimeDir, { recursive: true });
  writeFileSync(clientCacheFile(app), JSON.stringify({ client_id: clientId, port }, null, 2) + "\n");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function openBrowser(url: string): void {
  if (process.env.SUPERUN_NO_OPEN) return;
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd as string, args as string[], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* 打不开就靠上面打印的 URL 手动访问 */
  }
}
