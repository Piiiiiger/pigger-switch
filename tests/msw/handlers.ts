import { http, HttpResponse } from "msw";

const TAURI_ENDPOINT = "http://tauri.local";

const success = <T>(payload: T) => HttpResponse.json(payload as any);

const emptySummary = {
  totalRequests: 0,
  totalCost: "0",
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheCreationTokens: 0,
  totalCacheReadTokens: 0,
  successRate: 0,
  realTotalTokens: 0,
  cacheHitRate: 0,
};

export const defaultSettings = {
  showInTray: true,
  minimizeToTrayOnClose: true,
  launchOnStartup: false,
  silentStartup: false,
  sessionAutoSyncEnabled: true,
};

/** 后端命令的默认假数据：用例里用 server.use(...) 按需覆盖 */
export const handlers = [
  http.post(`${TAURI_ENDPOINT}/get_settings`, () => success(defaultSettings)),
  http.post(`${TAURI_ENDPOINT}/save_settings`, async ({ request }) => {
    const body = (await request.json()) as { settings: unknown };
    return success(body.settings);
  }),
  http.post(`${TAURI_ENDPOINT}/get_app_info`, () =>
    success({
      version: "1.0.0",
      dataDir: "/home/mock/.pigger-switch",
      claudeDir: "/home/mock/.claude",
      claudeDirExists: true,
      codexDir: "/home/mock/.codex",
      codexDirExists: true,
      ccSwitchDb: "/home/mock/.cc-switch/cc-switch.db",
      ccSwitchDbExists: false,
      ccSwitchImportedAt: null,
    }),
  ),
  http.post(`${TAURI_ENDPOINT}/get_usage_summary`, () => success(emptySummary)),
  http.post(`${TAURI_ENDPOINT}/get_usage_summary_by_app`, () => success([])),
  http.post(`${TAURI_ENDPOINT}/get_usage_trends`, () => success([])),
  http.post(`${TAURI_ENDPOINT}/get_project_stats`, () => success([])),
  http.post(`${TAURI_ENDPOINT}/get_model_stats`, () => success([])),
  http.post(`${TAURI_ENDPOINT}/get_session_stats`, () => success([])),
  http.post(`${TAURI_ENDPOINT}/get_hourly_activity`, () => success([])),
  http.post(`${TAURI_ENDPOINT}/get_budget_status`, () =>
    success({ todayCost: 0, monthCost: 0 }),
  ),
  http.post(`${TAURI_ENDPOINT}/get_request_logs`, () =>
    success({ data: [], total: 0, page: 0, pageSize: 20 }),
  ),
  http.post(`${TAURI_ENDPOINT}/get_session_usage_last_sync`, () =>
    success(null),
  ),
  http.post(`${TAURI_ENDPOINT}/get_model_pricing`, () => success([])),
  http.post(`${TAURI_ENDPOINT}/get_subscription_quota`, async ({ request }) => {
    const body = (await request.json()) as { tool: string };
    return success({
      tool: body.tool,
      credentialStatus: "not_found",
      credentialMessage: null,
      success: false,
      tiers: [],
      extraUsage: null,
      error: null,
      queriedAt: null,
    });
  }),
];
