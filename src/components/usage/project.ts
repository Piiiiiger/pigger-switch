import type { TFunction } from "i18next";

/** 路径最后一段（Windows 反斜杠也认），用作项目的短名 */
export function projectBaseName(project: string): string {
  const trimmed = project.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed || project;
}

/** 项目的展示名：目录名；未知项目（从 CC Switch 导入的路由记账行等）写「未知项目」 */
export function projectLabel(project: string | null | undefined, t: TFunction) {
  if (!project) return t("usage.unknownProject");
  return projectBaseName(project);
}

/** 把用户目录缩写成 ~，悬停提示里看完整路径时更短 */
export function shortenHome(path: string): string {
  return path
    .replace(/^\/home\/[^/]+/, "~")
    .replace(/^\/Users\/[^/]+/, "~")
    .replace(/^[A-Za-z]:\\Users\\[^\\]+/, "~");
}
