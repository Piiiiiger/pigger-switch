export type CredentialStatus =
  | "valid"
  | "expired"
  // 访问令牌过期、刷新令牌还在：客户端下次运行时自己会换新的
  | "refresh_pending"
  | "not_found"
  | "parse_error";

export interface QuotaTier {
  name: string;
  utilization: number; // 0-100
  resetsAt: string | null;
}

export interface ExtraUsage {
  isEnabled: boolean;
  monthlyLimit: number | null;
  usedCredits: number | null;
  utilization: number | null;
  currency: string | null;
}

/** ChatGPT 订阅存下的限额重置：每一次的到期时间，先到期的在前，null 表示不过期 */
export interface ResetCredits {
  expiresAt: (string | null)[];
}

export interface SubscriptionPlan {
  /** 小写原值：pro / max / plus / team … */
  id: string;
  /** 展示名：Max 5x / Plus … */
  label: string;
  activeUntil?: string | null;
}

export interface SubscriptionQuota {
  tool: string;
  credentialStatus: CredentialStatus;
  credentialMessage: string | null;
  success: boolean;
  tiers: QuotaTier[];
  extraUsage: ExtraUsage | null;
  /** 只有 ChatGPT 订阅有；没查到时缺省 */
  resetCredits?: ResetCredits | null;
  plan?: SubscriptionPlan | null;
  error: string | null;
  queriedAt: number | null;
}

export type QuotaTool = "claude" | "codex";

/** 本机一段时间里的用量（输入不含缓存） */
export interface WindowUsage {
  requests: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

/** current：本窗口自己的读数；typical：最近几个窗口的中位数 */
export type EstimateBasis = "current" | "typical";

/** 窗口总额度的估算（本机用量 ÷ 接口给的百分比），带可能的范围 */
export interface LimitEstimate {
  costUsd: number;
  costLow: number;
  costHigh: number;
  tokens: number;
  tokensLow: number;
  tokensHigh: number;
  basis: EstimateBasis;
  windows: number;
}

/** 当前的一个额度窗口（时间为 Unix 秒） */
export interface CurrentWindow {
  tier: string;
  start: number | null;
  end: number | null;
  reportedUtilization: number | null;
  reportedAt: number | null;
  estimatedUtilization: number | null;
  used: WindowUsage;
  limit: LimitEstimate | null;
  remainingCostUsd: number | null;
  remainingTokens: number | null;
  projectedUtilization: number | null;
  exhaustsAt: number | null;
  fiveHourWindowsLeft: number | null;
  perFiveHourCostUsd: number | null;
  perFiveHourTokens: number | null;
}

/** 过去（和当前）的一个窗口；exact 为假时边界是按本机请求推算的 */
export interface PastWindow {
  start: number;
  end: number;
  exact: boolean;
  current: boolean;
  used: WindowUsage;
  peakUtilization: number | null;
  limit: LimitEstimate | null;
}

export interface QuotaWindowsReport {
  tool: string;
  windows: CurrentWindow[];
  fiveHourHistory: PastWindow[];
  weeklyHistory: PastWindow[];
}
