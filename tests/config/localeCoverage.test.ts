import { describe, expect, it } from "vitest";
import en from "@/i18n/locales/en.json";
import ja from "@/i18n/locales/ja.json";
import zhTW from "@/i18n/locales/zh-TW.json";
import zh from "@/i18n/locales/zh.json";

type TranslationTree = Record<string, unknown>;

function flattenStrings(
  value: unknown,
  path: string[] = [],
  result = new Map<string, string>(),
): Map<string, string> {
  if (typeof value === "string") {
    result.set(path.join("."), value);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      flattenStrings(child, [...path, key], result);
    }
  }
  return result;
}

function interpolationVariables(value: string): string[] {
  return Array.from(
    value.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g),
    ([, name]) => name,
  ).sort();
}

/** 复数形式的键在各语言里不一样多（日语只有 _other），比较时归到同一个基础键 */
const pluralBase = (key: string) =>
  key.replace(/_(zero|one|two|few|many|other)$/, "");

const reference = flattenStrings(en);
const referenceBases = new Set([...reference.keys()].map(pluralBase));
const locales = [
  ["zh", zh],
  ["ja", ja],
  ["zh-TW", zhTW],
] as const;

describe("locale coverage", () => {
  it.each(locales)("covers every English key in %s", (_name, tree) => {
    const translations = flattenStrings(tree as TranslationTree);
    const bases = new Set([...translations.keys()].map(pluralBase));
    const missing = [...referenceBases].filter((key) => !bases.has(key));
    const extra = [...bases].filter((key) => !referenceBases.has(key));
    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
  });

  it.each(locales)("keeps every interpolation variable in %s", (_name, tree) => {
    const translations = flattenStrings(tree as TranslationTree);
    const mismatched = [...reference].flatMap(([key, expected]) => {
      const actual = translations.get(key);
      return actual !== undefined &&
        interpolationVariables(actual).join("\0") !==
          interpolationVariables(expected).join("\0")
        ? [key]
        : [];
    });
    expect(mismatched).toEqual([]);
  });

  it("never mentions the old product as if it were this app", () => {
    const offenders = [en, zh, ja, zhTW].flatMap((tree) =>
      [...flattenStrings(tree as TranslationTree)].filter(
        ([key, value]) =>
          /CC Switch/.test(value) &&
          !key.startsWith("settings.import.") &&
          key !== "usage.detail.sourceProxy" &&
          key !== "usage.speedHelp",
      ),
    );
    expect(offenders).toEqual([]);
  });
});
