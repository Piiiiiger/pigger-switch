import { invoke } from "@tauri-apps/api/core";
import type { QuotaTool, SubscriptionQuota } from "@/types/subscription";

export const subscriptionApi = {
  getQuota: (tool: QuotaTool): Promise<SubscriptionQuota> =>
    invoke("get_subscription_quota", { tool }),
};
