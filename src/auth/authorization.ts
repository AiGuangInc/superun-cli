/** 为固定项目提供可查询的授权流程，复用现有登录实现，不保存或重放业务请求。@author xiuyu.yi */
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config/app.js";
import { loginWithBrowser } from "./strategies.js";
import { loginWithManaged } from "./managed.js";
import { LoginFlowError } from "./flow.js";
import { decodeJwt, loadSession, saveSession, type Session } from "./session.js";

type Mode = "browser" | "managed";
type Status = "starting" | "pending" | "authorized" | "denied" | "expired" | "cancelled" | "failed";
interface Attempt {
  id: string;
  mode: Mode;
  status: Status;
  expiresAt: number;
  url?: string;
  identity?: { sub: string; email: string | null };
  requiresAccountConfirmation: boolean;
  baseline: Session | null;
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  ready: Promise<void>;
  done: Promise<void>;
  resolveReady: () => void;
  resolveDone: () => void;
}

const pending = (attempt: Attempt) => attempt.status === "starting" || attempt.status === "pending";
const subject = (session: Session | null) =>
  typeof session?.access_token === "string" ? decodeJwt(session.access_token)?.sub : undefined;

export class AuthorizationManager {
  private attempt?: Attempt;
  private closed = false;
  constructor(private readonly app: AppConfig) {}

  async start(mode: Mode) {
    if (this.closed) throw new Error("连接已关闭，请重新连接 MCP。");
    if (this.attempt && pending(this.attempt)) {
      const active = this.attempt;
      await active.ready;
      return this.snapshot(active);
    }
    let resolveReady!: () => void;
    let resolveDone!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const attempt: Attempt = {
      id: randomUUID(),
      mode,
      status: "starting",
      expiresAt: Date.now() + 15_000,
      requiresAccountConfirmation: false,
      baseline: loadSession(this.app.scopeId),
      controller: new AbortController(),
      ready,
      done,
      resolveReady,
      resolveDone,
    };
    this.attempt = attempt;
    const expire = () => {
      attempt.status = attempt.status === "starting" ? "failed" : "expired";
      attempt.controller.abort();
      attempt.resolveReady();
      attempt.resolveDone();
    };
    attempt.timer = setTimeout(expire, 15_000);
    attempt.timer.unref();
    const options = {
      signal: attempt.controller.signal,
      onAuthorizationReady: ({ url, expiresAt }: { url: string; expiresAt: number }) => {
        if (attempt.controller.signal.aborted || !pending(attempt)) return;
        clearTimeout(attempt.timer);
        attempt.status = "pending";
        attempt.url = url;
        attempt.expiresAt = expiresAt;
        attempt.timer = setTimeout(expire, Math.max(1, expiresAt - Date.now()));
        attempt.timer.unref();
        attempt.resolveReady();
      },
    };
    const login =
      mode === "managed"
        ? loginWithManaged(this.app, undefined, options)
        : loginWithBrowser(this.app, {
            port: 8976,
            authorizeUrl: this.app.authorizeUrl,
            tokenUrl: this.app.tokenUrl,
            clientId: this.app.oauthClientId,
            ...options,
          });
    void login
      .then((session) => {
        if (attempt.controller.signal.aborted || !pending(attempt)) return;
        const current = loadSession(this.app.scopeId);
        // 等待期间发生退出或另一次换号登录时，不覆盖用户的新选择。
        if (
          current?.access_token !== attempt.baseline?.access_token &&
          (!current || !attempt.baseline || !subject(current) || subject(current) !== subject(attempt.baseline))
        ) {
          throw new LoginFlowError("cancelled", "Session changed during authorization");
        }
        const claims = decodeJwt(session.access_token);
        if (typeof claims?.sub !== "string" || !claims.sub)
          throw new LoginFlowError("failed", "Missing authorized identity");
        attempt.requiresAccountConfirmation = !!attempt.baseline && subject(attempt.baseline) !== claims.sub;
        saveSession(this.app.scopeId, session);
        attempt.identity = { sub: claims.sub, email: typeof claims.email === "string" ? claims.email : null };
        attempt.status = "authorized";
      })
      .catch((error) => {
        if (!pending(attempt)) return;
        // 不将授权服务器的原始响应、授权码或轮询凭据返回给 Agent。
        attempt.status = error instanceof LoginFlowError ? error.status : "failed";
      })
      .finally(() => {
        clearTimeout(attempt.timer);
        attempt.baseline = null;
        attempt.resolveReady();
        attempt.resolveDone();
      });
    await ready;
    return this.snapshot(attempt);
  }

  async status(id: string, waitSeconds = 0) {
    const attempt = this.attempt;
    if (!attempt || attempt.id !== id)
      return {
        code: "AUTHORIZATION_NOT_FOUND",
        status: "not_found",
        project: this.app.id,
        environment: this.app.environment,
        canContinueTask: false,
        nextAction: "start_authorization",
        message: "未找到本次登录，请重新发起登录。",
      };
    if (pending(attempt) && waitSeconds > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          attempt.done,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, Math.min(20, Math.max(0, waitSeconds)) * 1000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    return this.snapshot(attempt);
  }

  close() {
    this.closed = true;
    const attempt = this.attempt;
    if (!attempt || !pending(attempt)) return;
    attempt.status = "cancelled";
    clearTimeout(attempt.timer);
    attempt.controller.abort();
    attempt.resolveReady();
    attempt.resolveDone();
  }

  private snapshot(attempt: Attempt) {
    const sessionStillMatches =
      attempt.status === "authorized" && subject(loadSession(this.app.scopeId)) === attempt.identity?.sub;
    const canContinueTask = sessionStillMatches && !attempt.requiresAccountConfirmation;
    const status = attempt.status === "authorized" && !sessionStillMatches ? "cancelled" : attempt.status;
    return {
      authorizationId: attempt.id,
      project: this.app.id,
      environment: this.app.environment,
      mode: attempt.mode,
      status,
      expiresAt: Math.floor(attempt.expiresAt / 1000),
      ...(status === "pending" ? { authorizationUrl: attempt.url, nextAction: "authorization_status" } : {}),
      ...(status === "authorized"
        ? {
            identity: attempt.identity,
            requiresAccountConfirmation: attempt.requiresAccountConfirmation,
            canContinueTask,
            nextAction: canContinueTask ? "resume_task_if_safe" : "confirm_account",
            resumeInstruction: "核对原失败操作的 safeToRetry；为 false 的写操作先核验结果，避免重复执行。",
          }
        : {}),
      ...(!["starting", "pending", "authorized"].includes(status)
        ? {
            code: `AUTHORIZATION_${status.toUpperCase()}`,
            canContinueTask: false,
            message:
              status === "denied"
                ? "用户未同意本次登录，请停止需要该身份的任务。"
                : status === "expired"
                  ? "登录已超时，需要用户重新发起。"
                  : status === "cancelled"
                    ? "登录已取消或账号发生变化，请重新核对账号。"
                    : "登录失败，请检查网络、登录方式或联系项目管理员。原登录信息已保留。",
          }
        : {}),
    };
  }
}
