import { t } from "./strings.js";

export function message(error: unknown): string { return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error:\s*/, ""); }
/** 桥接报告浏览器当前登录里没有桌面端选中的账号（登录已切换），渲染端据此自动切换 */
export function isAccountMismatch(error: unknown): boolean { return message(error).startsWith("ACCOUNT_NOT_FOUND"); }
export function friendlyError(error: unknown): string {
  const text = message(error).replace(/^ACCOUNT_NOT_FOUND:\s*/, "");
  if (/extension code is outdated/i.test(text)) return t("浏览器扩展运行的不是最新代码，自动升级未能生效——请在 chrome://extensions 重新加载该扩展（或重启浏览器），再点击“完整刷新”重试。");
  if (/request timed out/i.test(text)) return t("同步或操作超时：浏览器可能正在休眠或网络较慢，请稍后点击“完整刷新”重试。");
  if (/unsupported bridge command/i.test(text)) return t("浏览器扩展版本过旧，请在 chrome://extensions 中重新加载扩展后重试。");
  return text;
}
