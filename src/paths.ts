import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 跨平台配置根目录:
 *   Windows  → %APPDATA%\superun
 *   mac/linux → $XDG_CONFIG_HOME 或 ~/.config 下的 superun
 * 可用 SUPERUN_HOME 整体覆盖(便于测试 / 便携模式)。
 */
export function configRoot(): string {
  if (process.env.SUPERUN_HOME) return process.env.SUPERUN_HOME;
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "superun");
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "superun");
}

/**
 * 跨平台缓存根目录:
 *   Windows  → %LOCALAPPDATA%\superun
 *   mac/linux → $XDG_CACHE_HOME 或 ~/.cache 下的 superun
 */
export function cacheRoot(): string {
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "superun");
  }
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "superun");
}
