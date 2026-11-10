/** 向当前项目认证服务核验非匿名用户，复用原有续期和登录恢复。@author xiuyu.yi */
import type { AppConfig } from "../config/app.js";
import { request } from "../transport/client.js";
import { AuthRequiredError, AuthRefreshError, authErrorData } from "./errors.js";
import { decodeJwt, loadSession } from "./session.js";

export interface VerifiedIdentity {
  sub: string;
  email: string | null;
  role: string;
  isAnonymous: false;
}

export async function verifyUserIdentity(app: AppConfig): Promise<VerifiedIdentity> {
  const session = loadSession(app.scopeId);
  if (!session) throw new AuthRequiredError(app, "no_session");

  let result;
  try {
    result = await request(app, session, {
      path: "/auth/v1/user",
      auth: true,
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
  } catch (error) {
    if (authErrorData(error)) throw error;
    throw new Error("无法完成项目服务端身份验证，请检查网络或认证服务后重试。");
  }
  if (result.status === 401) throw new AuthRequiredError(app, "token_rejected");
  if (result.status !== 200) throw new Error(`项目服务端身份验证失败，HTTP ${result.status}。`);
  const user = result.body;
  if (user?.is_anonymous === true || user?.role === "anon") {
    throw new AuthRequiredError(app, "anonymous_identity");
  }
  if (
    typeof user?.id !== "string" || !user.id.trim() ||
    typeof user.role !== "string" || !user.role || user.role === "service_role" ||
    user.is_anonymous !== false
  ) {
    throw new Error("认证服务未返回可核验的非匿名用户，不能报告登录验收成功。");
  }
  // 请求可能触发续期；核对最新会话，避免将退出或换号前的验证用于后续任务。
  const current = loadSession(app.scopeId);
  if (!current || decodeJwt(current.access_token)?.sub !== user.id) {
    throw new AuthRefreshError("AUTH_REFRESH_FAILED", "session_changed", app);
  }
  return {
    sub: user.id,
    email: typeof user.email === "string" ? user.email : null,
    role: user.role,
    isAnonymous: false,
  };
}
