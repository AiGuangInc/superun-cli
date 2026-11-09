/** 登录恢复的机器可读结果，不包含令牌或业务请求内容。@author xiuyu.yi */
import type { AppConfig } from "../config/app.js";

function loginCommands(project: string, environment: string) {
  const args = ["--app", project, "--env", environment, "login"];
  return {
    browser: { command: "superun", args: [...args, "--browser"] },
    managed: { command: "superun", args: [...args, "--managed"] },
  };
}

export class AuthRequiredError extends Error {
  readonly code = "AUTH_REQUIRED";
  safeToRetry = true;
  readonly project: string;
  readonly environment: string;
  constructor(
    app: AppConfig,
    readonly reason: string,
  ) {
    super("项目登录已失效或尚未登录，请重新登录后继续。");
    this.project = app.id;
    this.environment = app.environment;
  }
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      reason: this.reason,
      project: this.project,
      environment: this.environment,
      nextAction: "start_authorization",
      safeToRetry: this.safeToRetry,
      loginCommands: loginCommands(this.project, this.environment),
    };
  }
}

export class AuthRefreshError extends Error {
  safeToRetry = true;
  readonly project: string;
  readonly environment: string;
  constructor(
    readonly code: "AUTH_TEMPORARY_FAILURE" | "AUTH_REFRESH_FAILED",
    readonly reason: string,
    app: AppConfig,
  ) {
    super(
      reason === "session_changed"
        ? "登录会话已发生变化，请核对当前账号后重新发起操作。"
        : code === "AUTH_TEMPORARY_FAILURE"
          ? "自动续期暂时失败，请重新登录后继续。原登录信息已保留。"
          : "自动续期失败，请重新登录后继续。原登录信息已保留。",
    );
    this.project = app.id;
    this.environment = app.environment;
  }
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      reason: this.reason,
      project: this.project,
      environment: this.environment,
      safeToRetry: this.safeToRetry,
      nextAction: this.reason === "session_changed" ? "confirm_account" : "start_authorization",
      ...(this.reason === "session_changed" ? {} : { loginCommands: loginCommands(this.project, this.environment) }),
    };
  }
}

export function authErrorData(error: unknown) {
  return error instanceof AuthRequiredError || error instanceof AuthRefreshError ? error.toJSON() : null;
}
