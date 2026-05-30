import type { AppConfig } from "../config/app.js";
import { saveSession, type Session } from "../auth/session.js";

export interface RequestOpts {
  method?: string;
  /** 接在 baseUrl 后,须以 / 开头 */
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** 为 true 且有 session 时附 Authorization: Bearer */
  auth?: boolean;
  query?: Record<string, string | undefined>;
}

export interface ApiResult {
  status: number;
  body: any;
  raw: Response;
}

/** access_token 还剩这么多秒(含已过期)就提前续期,避开"刚好卡过期点"的请求。 */
const REFRESH_SKEW_SEC = 60;

function shouldRefresh(s: Session | null): s is Session {
  if (!s?.refresh_token || !s.expires_at) return false;
  return s.expires_at - Math.floor(Date.now() / 1000) < REFRESH_SKEW_SEC;
}

/**
 * 用 refresh_token 换新 session(GoTrue: POST /auth/v1/token?grant_type=refresh_token)。
 * 成功则回写 session.json 并返回新 session;失败(refresh_token 也过期/被吊销)返回 null,
 * 让调用方按原状继续(通常随后拿到 401,提示重新 login)。
 */
async function refreshSession(app: AppConfig, s: Session): Promise<Session | null> {
  try {
    const url = new URL(app.baseUrl + "/auth/v1/token");
    url.searchParams.set("grant_type", "refresh_token");
    const res = await fetch(url, {
      method: "POST",
      headers: { apikey: app.anonKey, "content-type": "application/json", connection: "close" },
      body: JSON.stringify({ refresh_token: s.refresh_token }),
    });
    if (!res.ok) return null;
    const b: any = await res.json().catch(() => ({}));
    if (!b.access_token) return null;
    const next: Session = {
      access_token: b.access_token,
      // GoTrue 会轮换 refresh_token,优先用新的;没返回则沿用旧的
      refresh_token: b.refresh_token ?? s.refresh_token,
      expires_at: b.expires_at ?? (b.expires_in ? Math.floor(Date.now() / 1000) + b.expires_in : s.expires_at),
      strategy: s.strategy,
    };
    saveSession(app.id, next);
    return next;
  } catch {
    return null;
  }
}

/**
 * 统一出口:固定带 apikey(anonKey);需要身份时叠加当前 session 的 bearer。
 * 自动续期:① 主动 —— access_token 临近/已过期且有 refresh_token,先换新再发;
 *           ② 被动 —— 仍撞 401 时用 refresh_token 续期并重试一次。
 */
export async function request(app: AppConfig, session: Session | null, opts: RequestOpts): Promise<ApiResult> {
  const url = new URL(app.baseUrl + opts.path);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) if (v != null) url.searchParams.set(k, v);
  }
  const bodyStr = opts.body != null ? JSON.stringify(opts.body) : undefined;

  const send = (sess: Session | null): Promise<Response> => {
    const headers: Record<string, string> = {
      apikey: app.anonKey,
      ...(opts.body != null ? { "content-type": "application/json" } : {}),
      ...opts.headers,
    };
    if (opts.auth && sess?.access_token) headers.authorization = `Bearer ${sess.access_token}`;
    return fetch(url, { method: opts.method ?? "GET", headers, body: bodyStr });
  };

  // ① 主动续期:过期前(含已过期)先换新
  if (opts.auth && shouldRefresh(session)) {
    const next = await refreshSession(app, session);
    if (next) session = next;
  }

  let res = await send(session);

  // ② 被动兜底:真撞 401 且手里有 refresh_token,续期后重试一次
  if (res.status === 401 && opts.auth && session?.refresh_token) {
    const next = await refreshSession(app, session);
    if (next) res = await send(next);
  }

  const text = await res.text();
  let body: any = text;
  if ((res.headers.get("content-type") ?? "").includes("json") && text) {
    try {
      body = JSON.parse(text);
    } catch {
      /* 保留原始 text */
    }
  }
  return { status: res.status, body, raw: res };
}
