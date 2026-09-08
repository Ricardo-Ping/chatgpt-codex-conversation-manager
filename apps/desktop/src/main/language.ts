import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export type AppLanguage = "zh" | "en";

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
