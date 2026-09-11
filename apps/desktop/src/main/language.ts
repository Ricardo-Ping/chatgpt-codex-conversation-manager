import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { MAIN_STRINGS } from "./strings.js";

export type AppLanguage = "zh" | "en";

let currentLanguage: AppLanguage = "zh";

export function appLanguage(): AppLanguage {
  return currentLanguage;
}

export function setAppLanguage(next: AppLanguage): void {
  currentLanguage = next;
}

/** 主进程统一文案入口：始终返回当前语言的字符串表，模块间共享而无需传递 LANG。 */
export function M() {
  return MAIN_STRINGS[currentLanguage];
}

function isLanguage(value: unknown): value is AppLanguage {
  return value === "zh" || value === "en";
}

export async function loadLanguagePreference(userData: string, fallback: AppLanguage = "zh"): Promise<AppLanguage> {
  try {
    const language = (JSON.parse(await readFile(join(userData, "language-preferences.json"), "utf8")) as { language?: unknown }).language;
    return isLanguage(language) ? language : fallback;
  } catch { return fallback; }
}

export async function saveLanguagePreference(userData: string, language: AppLanguage): Promise<void> {
  await mkdir(userData, { recursive: true });
  await writeFile(join(userData, "language-preferences.json"), `${JSON.stringify({ language }, null, 2)}\n`, "utf8");
}
