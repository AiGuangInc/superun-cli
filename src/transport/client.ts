import type { AppConfig } from "../config/app.js";
import { decodeJwt, loadSession, saveSession, type Session } from "../auth/session.js";
import { AuthRequiredError, AuthRefreshError } from "../auth/errors.js";

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
 * 用 refresh_token 换新 session(常规 GoTrue 或 managed 会话的 OAuth token 端点)。
 * 成功后沿用原有保存逻辑；失败保留原因并提供重新登录入口。
 */
async function refreshSession(app: AppConfig, s: Session): Promise<Session> {
  const storedBefore = loadSession(app.scopeId);
  try {
    // 旧浏览器会话只补续期参数；过期 JWT 用于读取 client_id，身份仍由服务端校验 refresh_token。
    if (s.strategy === "browser" && !s.oauth) {
      const claims = decodeJwt(s.access_token);
      const clientId = typeof claims?.client_id === "string" ? claims.client_id.trim() : "";
      if (!clientId || (claims?.iss && claims.iss !== `${app.baseUrl}/auth/v1`))
        throw new AuthRequiredError(app, "oauth_information_missing");
      s = { ...s, oauth: { client_id: clientId, token_url: `${app.baseUrl}/auth/v1/oauth/token` } };
    }
    const url = new URL(s.oauth?.token_url ?? app.baseUrl + "/auth/v1/token");
    // A session belongs to one selected project/environment; never refresh elsewhere.
    if (s.oauth && url.href !== `${app.baseUrl}/auth/v1/oauth/token`)
      throw new AuthRefreshError("AUTH_REFRESH_FAILED", "oauth_endpoint_mismatch", app);
    if (!s.oauth) url.searchParams.set("grant_type", "refresh_token");
    const form = s.oauth ? new URLSearchParams({ grant_type: "refresh_token",
      refresh_token: s.refresh_token!, client_id: s.oauth.client_id }) : undefined;
    const res = await fetch(url, {
      method: "POST",
      headers: { apikey: app.anonKey, "content-type": form ? "application/x-www-form-urlencoded" : "application/json", connection: "close" },
      body: form?.toString() ?? JSON.stringify({ refresh_token: s.refresh_token }),
      ...(s.oauth ? { redirect: "error" as const, signal: AbortSignal.timeout(15_000) } : {}),
    });
    const b: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const code = b?.error_code ?? b?.code ?? b?.error;
      if ((res.status === 400 || res.status === 401) && ["invalid_grant", "invalid_refresh_token", "refresh_token_not_found",
        "refresh_token_already_used", "session_expired", "session_not_found", "validation_failed"].includes(code)) {
        throw new AuthRequiredError(app, "refresh_token_invalid");
      }
      throw new AuthRefreshError(res.status === 429 || res.status >= 500 ? "AUTH_TEMPORARY_FAILURE" : "AUTH_REFRESH_FAILED", `refresh_http_${res.status}`, app);
    }
    if (typeof b.access_token !== "string" || !b.access_token)
      throw new AuthRefreshError("AUTH_TEMPORARY_FAILURE", "invalid_refresh_response", app);
    const next: Session = {
      access_token: b.access_token,
      // GoTrue 会轮换 refresh_token,优先用新的;没返回则沿用旧的
      refresh_token: b.refresh_token ?? s.refresh_token,
      expires_at: b.expires_at ?? (b.expires_in ? Math.floor(Date.now() / 1000) + b.expires_in : s.expires_at),
      strategy: s.strategy,
      ...(s.oauth ? { oauth: s.oauth } : {}),
    };
    const current = loadSession(app.scopeId);
    if (current?.access_token !== storedBefore?.access_token) {
      // 授权或退出已改变会话时不写回旧结果；同账号的并发续期复用最新凭据。
      const previousSub = decodeJwt(s.access_token)?.sub;
      if (current && previousSub && decodeJwt(current.access_token)?.sub === previousSub) return current;
      throw new AuthRefreshError("AUTH_REFRESH_FAILED", "session_changed", app);
    }
    saveSession(app.scopeId, next);
    return next;
  } catch (error) {
    if (error instanceof AuthRequiredError || error instanceof AuthRefreshError) throw error;
    throw new AuthRefreshError("AUTH_TEMPORARY_FAILURE", "refresh_unavailable", app);
  }
}

/** 仅识别明确的 JWT/会话认证失败；业务 401 和 403 不触发授权或重放写请求。 */
async function authenticationRejected(res: Response): Promise<boolean> {
  if (res.status !== 401) return false;
  const body: any = await res.clone().json().catch(() => null);
  const code = body?.error_code ?? body?.code ?? body?.error;
  if (["PGRST301", "PGRST302", "PGRST303", "bad_jwt", "session_not_found", "session_expired"].includes(code)) return true;
  const explicitCode = body?.error_code ?? body?.code;
  if (typeof explicitCode === "string" && explicitCode !== "401") return false;
  const message = body?.message ?? body?.msg ?? body?.error;
  return typeof message === "string" && /^(invalid JWT|JWT (has )?expired|missing authorization header|invalid or expired JWT)$/i.test(message);
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
  let requestSent = false;
  const safeToRetry = () => !requestSent || ["GET", "HEAD"].includes((opts.method ?? "GET").toUpperCase());
  const refresh = async (current: Session) => {
    try { return await refreshSession(app, current); }
    catch (error) {
      if (error instanceof AuthRequiredError || error instanceof AuthRefreshError) error.safeToRetry = safeToRetry();
      throw error;
    }
  };

  const send = (sess: Session | null): Promise<Response> => {
    const headers: Record<string, string> = {
      apikey: app.anonKey,
      ...(opts.body != null ? { "content-type": "application/json" } : {}),
      ...opts.headers,
    };
    if (opts.auth && sess?.access_token) headers.authorization = `Bearer ${sess.access_token}`;
    requestSent = true;
    return fetch(url, { method: opts.method ?? "GET", headers, body: bodyStr });
  };

  // ① 主动续期:过期前(含已过期)先换新
  let refreshed = false;
  if (opts.auth && session && !session.refresh_token && session.expires_at && session.expires_at <= Date.now() / 1000)
    throw new AuthRequiredError(app, "missing_refresh_token");
  if (opts.auth && shouldRefresh(session)) {
    session = await refresh(session);
    refreshed = true;
  }

  let res = await send(session);

  // ② 被动兜底:真撞 401 且手里有 refresh_token,续期后重试一次
  if (opts.auth && await authenticationRejected(res)) {
    if (session?.refresh_token && !refreshed) {
      let next: Session;
      try { next = await refresh(session); }
      catch (error) { await res.body?.cancel(); throw error; }
      await res.body?.cancel();
      res = await send(next);
    }
    if (await authenticationRejected(res)) {
      const error = new AuthRequiredError(app, session ? "token_rejected" : "no_session");
      error.safeToRetry = safeToRetry();
      await res.body?.cancel();
      throw error;
    }
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
