import { save } from "@tauri-apps/plugin-dialog";
import { usageApi } from "@/lib/api/usage";
import { settingsApi } from "@/lib/api/settings";
import { resolveUsageRange } from "@/lib/usageRange";
import type { UsageRangeSelection, UsageScopeFilters } from "@/types/usage";
import { getFreshInputTokens } from "@/types/usage";

export type CsvExportKind =
  | "daily"
  | "projects"
  | "models"
  | "sessions"
  | "requests";

export const CSV_EXPORT_KINDS: CsvExportKind[] = [
  "daily",
  "projects",
  "models",
  "sessions",
  "requests",
];

/** 一次最多导出多少条请求明细 */
const MAX_REQUEST_ROWS = 20000;

type Cell = string | number | null | undefined;

function escapeCell(value: Cell): string {
  if (value == null) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(headers: string[], rows: Cell[][]): string {
  // 带 BOM，Excel 打开中文不乱码
  return (
    "﻿" +
    [headers, ...rows]
      .map((row) => row.map(escapeCell).join(","))
      .join("\r\n") +
    "\r\n"
  );
}

const iso = (seconds: number) =>
  seconds > 0 ? new Date(seconds * 1000).toISOString() : "";

async function buildCsv(
  kind: CsvExportKind,
  range: UsageRangeSelection,
  filters: UsageScopeFilters,
): Promise<string> {
  const { startDate, endDate } = resolveUsageRange(range);
  const appType = filters.appType === "all" ? undefined : filters.appType;
  const { project, model } = filters;

  switch (kind) {
    case "daily": {
      const rows = await usageApi.getUsageTrends(
        startDate,
        endDate,
        appType,
        project,
        model,
      );
      return toCsv(
        [
          "date",
          "requests",
          "input_tokens",
          "output_tokens",
          "cache_write_tokens",
          "cache_read_tokens",
          "cost_usd",
        ],
        rows.map((r) => [
          r.date,
          r.requestCount,
          r.totalInputTokens,
          r.totalOutputTokens,
          r.totalCacheCreationTokens,
          r.totalCacheReadTokens,
          r.totalCost,
        ]),
      );
    }
    case "projects": {
      const rows = await usageApi.getProjectStats(
        startDate,
        endDate,
        appType,
        project,
        model,
      );
      return toCsv(
        [
          "project",
          "requests",
          "sessions",
          "tokens",
          "cost_usd",
          "claude_cost_usd",
          "codex_cost_usd",
          "last_active",
        ],
        rows.map((r) => [
          r.project,
          r.requestCount,
          r.sessionCount,
          r.totalTokens,
          r.totalCost,
          r.claudeCost,
          r.codexCost,
          iso(r.lastActiveAt),
        ]),
      );
    }
    case "models": {
      const rows = await usageApi.getModelStats(
        startDate,
        endDate,
        appType,
        project,
        model,
      );
      return toCsv(
        ["model", "requests", "tokens", "cost_usd", "avg_cost_per_request_usd"],
        rows.map((r) => [
          r.model,
          r.requestCount,
          r.totalTokens,
          r.totalCost,
          r.avgCostPerRequest,
        ]),
      );
    }
    case "sessions": {
      const rows = await usageApi.getSessionStats(
        startDate,
        endDate,
        appType,
        project,
        model,
        1000,
      );
      return toCsv(
        [
          "app",
          "session_id",
          "title",
          "project",
          "main_model",
          "requests",
          "tokens",
          "cache_read_tokens",
          "cost_usd",
          "first_request",
          "last_request",
        ],
        rows.map((r) => [
          r.appType,
          r.sessionId,
          r.title,
          r.project,
          r.model,
          r.requestCount,
          r.totalTokens,
          r.cacheReadTokens,
          r.totalCost,
          iso(r.firstAt),
          iso(r.lastAt),
        ]),
      );
    }
    case "requests": {
      const page = await usageApi.getRequestLogs(
        { appType, project, model, startDate, endDate },
        0,
        MAX_REQUEST_ROWS,
      );
      return toCsv(
        [
          "time",
          "app",
          "project",
          "session_id",
          "model",
          "input_tokens",
          "output_tokens",
          "cache_write_tokens",
          "cache_read_tokens",
          "cost_usd",
          "status",
          "request_id",
        ],
        page.data.map((r) => [
          iso(r.createdAt),
          r.appType,
          r.project,
          r.sessionId,
          r.model,
          getFreshInputTokens(r),
          r.outputTokens,
          r.cacheCreationTokens,
          r.cacheReadTokens,
          r.totalCostUsd,
          r.statusCode,
          r.requestId,
        ]),
      );
    }
  }
}

/**
 * 按当前筛选导出 CSV：选保存位置 → 取数 → 写文件。
 * 用户取消保存对话框时返回 null。
 */
export async function exportUsageCsv(
  kind: CsvExportKind,
  range: UsageRangeSelection,
  filters: UsageScopeFilters,
): Promise<string | null> {
  const stamp = new Date().toISOString().slice(0, 10);
  const path = await save({
    defaultPath: `pigger-usage-${kind}-${stamp}.csv`,
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
  if (!path) return null;
  const csv = await buildCsv(kind, range, filters);
  await settingsApi.saveTextFile(path, csv);
  return path;
}
