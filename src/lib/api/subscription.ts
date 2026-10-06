import { invoke } from "@tauri-apps/api/core";
import type {
  QuotaTool,
  QuotaWindowsReport,
  SubscriptionQuota,
} from "@/types/subscription";

export const subscriptionApi = {
  getQuota: (tool: QuotaTool): Promise<SubscriptionQuota> =>
    invoke("get_subscription_quota", { tool }),
  getWindows: (tool: QuotaTool): Promise<QuotaWindowsReport> =>
    invoke("get_quota_windows", { tool }),
};
