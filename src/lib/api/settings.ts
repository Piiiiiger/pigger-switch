import { invoke } from "@tauri-apps/api/core";

export type LanguageCode = "zh" | "zh-TW" | "en" | "ja";

/** 与后端 `AppSettings` 对应（camelCase） */
export interface AppSettings {
  showInTray: boolean;
  minimizeToTrayOnClose: boolean;
  launchOnStartup: boolean;
  silentStartup: boolean;
  language?: LanguageCode | null;
  usageDashboardRefreshIntervalMs?: number | null;
  sessionAutoSyncEnabled: boolean;
  claudeConfigDir?: string | null;
  codexConfigDir?: string | null;
  networkProxyUrl?: string | null;
  dailyBudgetUsd?: number | null;
  monthlyBudgetUsd?: number | null;
  quotaAlertPercent?: number | null;
}

export interface AppInfo {
  version: string;
  dataDir: string;
  claudeDir: string;
  claudeDirExists: boolean;
  codexDir: string;
  codexDirExists: boolean;
  ccSwitchDb: string;
  ccSwitchDbExists: boolean;
  ccSwitchImportedAt?: number | null;
}

export interface ImportResult {
  detailRows: number;
  detailSkipped: number;
  rollupRows: number;
  rollupDaysSkipped: number;
  dedupRows: number;
}

export const settingsApi = {
  get: (): Promise<AppSettings> => invoke("get_settings"),
  save: (settings: AppSettings): Promise<AppSettings> =>
    invoke("save_settings", { settings }),
  getAppInfo: (): Promise<AppInfo> => invoke("get_app_info"),
  importCcSwitchHistory: (path?: string): Promise<ImportResult> =>
    invoke("import_cc_switch_history", { path }),
  saveTextFile: (path: string, content: string): Promise<void> =>
    invoke("save_text_file", { path, content }),
  openDataDir: (): Promise<void> => invoke("open_data_dir"),
};
