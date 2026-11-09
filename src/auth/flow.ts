/** 现有登录命令与 MCP 共用的授权进度和取消接口。@author xiuyu.yi */
export interface LoginFlowOptions {
  signal?: AbortSignal;
  /** 公开授权地址及截止时间（epoch 毫秒），不传递授权码或私有轮询凭据。 */
  onAuthorizationReady?: (value: { url: string; expiresAt: number }) => void;
}

export class LoginFlowError extends Error {
  constructor(
    readonly status: "denied" | "expired" | "cancelled" | "failed",
    message: string,
  ) {
    super(message);
  }
}

/** 保留原有请求超时，同时允许 MCP 关闭或授权到期时取消；兼容早期 Node.js 20。 */
export function loginRequestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  const controller = new AbortController();
  for (const source of [signal, timeout]) {
    if (source.aborted) {
      controller.abort(source.reason);
      break;
    }
    source.addEventListener("abort", () => controller.abort(source.reason), { once: true, signal: controller.signal });
  }
  return controller.signal;
}
