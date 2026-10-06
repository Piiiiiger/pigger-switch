import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CurrentWindow,
  PastWindow,
  QuotaWindowsReport,
  SubscriptionQuota,
  WindowUsage,
} from "@/types/subscription";

const { getQuota, getWindows } = vi.hoisted(() => ({
  getQuota: vi.fn(),
  getWindows: vi.fn(),
}));

// 插值的值拼在键后面，断言时能看到具体内容
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${Object.values(options).join("|")}` : key,
    i18n: { resolvedLanguage: "en", language: "en" },
  }),
}));

vi.mock("@/lib/api/subscription", () => ({
  subscriptionApi: { getQuota, getWindows },
}));

vi.mock("@/hooks/useSettings", () => ({
  useSettings: () => ({ settings: { quotaAlertPercent: 80 } }),
}));

import { LimitsPage } from "@/components/limits/LimitsPage";

const NOW = Math.floor(Date.now() / 1000);

function usage(costUsd: number, totalTokens = 1_000_000): WindowUsage {
  return {
    requests: 10,
    costUsd,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens,
  };
}

function current(over: Partial<CurrentWindow>): CurrentWindow {
  return {
    tier: "five_hour",
    start: NOW - 3600,
    end: NOW + 4 * 3600,
    reportedUtilization: 40,
    reportedAt: NOW - 60,
    estimatedUtilization: 48,
    used: usage(12),
    limit: {
      costUsd: 25,
      costLow: 24.69,
      costHigh: 25.32,
      tokens: 2_500_000,
      tokensLow: 2_400_000,
      tokensHigh: 2_600_000,
      basis: "current",
      windows: 1,
    },
    remainingCostUsd: 13,
    remainingTokens: 1_500_000,
    projectedUtilization: 120,
    exhaustsAt: NOW + 2 * 3600,
    fiveHourWindowsLeft: null,
    perFiveHourCostUsd: null,
    perFiveHourTokens: null,
    ...over,
  };
}

function past(over: Partial<PastWindow>): PastWindow {
  return {
    start: NOW - 30 * 3600,
    end: NOW - 25 * 3600,
    exact: true,
    current: false,
    used: usage(10),
    peakUtilization: 50,
    limit: null,
    ...over,
  };
}

const quota: SubscriptionQuota = {
  tool: "claude",
  credentialStatus: "valid",
  credentialMessage: null,
  success: true,
  tiers: [],
  extraUsage: null,
  plan: { id: "max", label: "Max 5x" },
  error: null,
  queriedAt: Date.now(),
};

const limitOf = (costUsd: number) => ({
  costUsd,
  costLow: costUsd,
  costHigh: costUsd,
  tokens: 0,
  tokensLow: 0,
  tokensHigh: 0,
  basis: "current" as const,
  windows: 1,
});

const report: QuotaWindowsReport = {
  tool: "claude",
  windows: [
    current({
      tier: "seven_day_opus",
      limit: null,
      remainingCostUsd: null,
      estimatedUtilization: null,
      projectedUtilization: null,
      exhaustsAt: null,
    }),
    current({
      tier: "seven_day",
      start: NOW - 2 * 86400,
      end: NOW + 5 * 86400,
      exhaustsAt: null,
      projectedUtilization: 84,
      fiveHourWindowsLeft: 24,
      perFiveHourCostUsd: 6.25,
      perFiveHourTokens: 60_000,
      limit: { ...current({}).limit!, basis: "typical", windows: 3 },
    }),
    current({}),
    // 本机一个请求都没有，订阅却说用了 4%：用在了别处
    current({
      tier: "seven_day_fable",
      reportedUtilization: 4,
      estimatedUtilization: null,
      used: { ...usage(0, 0), requests: 0 },
      limit: null,
      remainingCostUsd: null,
      projectedUtilization: null,
      exhaustsAt: null,
    }),
  ],
  fiveHourHistory: [
    past({
      current: true,
      start: NOW - 3600,
      end: NOW + 4 * 3600,
      peakUtilization: 40,
    }),
    past({ limit: limitOf(20) }),
    past({ start: NOW - 40 * 3600, end: NOW - 35 * 3600, limit: limitOf(30) }),
    // 没有读数的窗口：按 $20 和 $30 的中位数 $25 折算，$10 是 40%
    past({
      start: NOW - 50 * 3600,
      end: NOW - 45 * 3600,
      exact: false,
      peakUtilization: null,
    }),
  ],
  weeklyHistory: [
    past({
      start: NOW - 9 * 86400,
      end: NOW - 2 * 86400,
      peakUtilization: 70,
      used: usage(140),
    }),
  ],
};

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <LimitsPage tool="claude" />
    </QueryClientProvider>,
  );
}

const card = (tier: string) =>
  screen.getByRole("region", { name: `limits.tier.${tier}:${tier}` });

describe("LimitsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getQuota.mockResolvedValue(quota);
    getWindows.mockResolvedValue(report);
  });

  it("gives every window its usage, estimated limit and what is left, shortest first", async () => {
    renderPage();
    await screen.findByRole("region", { name: /five_hour/ });

    const regions = screen
      .getAllByRole("region")
      .map((r) => r.getAttribute("aria-label"))
      .filter((label) => label?.startsWith("limits.tier."));
    expect(regions).toEqual([
      "limits.tier.five_hour:five_hour",
      "limits.tier.seven_day:seven_day",
      "limits.tier.seven_day_opus:seven_day_opus",
      "limits.tier.seven_day_fable:seven_day_fable",
    ]);

    const fiveHour = card("five_hour");
    expect(within(fiveHour).getByText(/^≈ \$25\.00/)).toBeInTheDocument();
    expect(within(fiveHour).getByText(/^≈ \$13\.00/)).toBeInTheDocument();
    expect(
      within(fiveHour).getByText(/limits\.window\.runsOutAt/),
    ).toBeInTheDocument();
    expect(
      within(fiveHour).getByText("limits.window.nowAbout:48"),
    ).toBeInTheDocument();

    const weekly = card("seven_day");
    expect(
      within(weekly).getByText(/^limits\.window\.basisTypical:3/),
    ).toBeInTheDocument();
    expect(
      within(weekly).getByText(/^limits\.window\.perFiveHour:24\|\$6\.25/),
    ).toBeInTheDocument();

    // 估不出额度的窗口也画同样的几行，几张卡对齐
    const opus = card("seven_day_opus");
    expect(
      within(opus).getByText("limits.window.noEstimate"),
    ).toBeInTheDocument();
    expect(
      within(card("seven_day_fable")).getByText("limits.window.usedElsewhere"),
    ).toBeInTheDocument();
    for (const region of [fiveHour, weekly, opus]) {
      expect(region.querySelectorAll("dt")).toHaveLength(4);
    }
    expect(screen.getByText("Max 5x")).toBeInTheDocument();
  });

  it("lists past windows and switches between 5-hour and weekly", async () => {
    const user = userEvent.setup();
    renderPage();
    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(4);
    expect(within(rows[0]).getByText("limits.history.now")).toBeInTheDocument();
    expect(within(rows[1]).getByText("50%")).toBeInTheDocument();
    expect(within(rows[1]).getByText("≈ $20.00")).toBeInTheDocument();
    // 推算的窗口：标星，按典型额度折算
    expect(within(rows[3]).getByText("*")).toBeInTheDocument();
    expect(within(rows[3]).getByText("≈ 40%")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "limits.history.weekly" }),
    );
    const weekly = within(screen.getByRole("table"))
      .getAllByRole("row")
      .slice(1);
    expect(weekly).toHaveLength(1);
    expect(within(weekly[0]).getByText("70%")).toBeInTheDocument();
    expect(within(weekly[0]).getByText("$140.00")).toBeInTheDocument();
  });

  it("says why there is nothing to show when the tool is not signed in", async () => {
    getQuota.mockResolvedValue({
      ...quota,
      success: false,
      credentialStatus: "not_found",
      plan: null,
    });
    renderPage();
    expect(
      await screen.findByText("limits.notSignedIn.claude"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /five_hour/ })).toBeNull();
    // 没有窗口时也不讲怎么估的
    expect(screen.queryByText("limits.estimateNote.claude")).toBeNull();
  });

  it("stops splitting a weekly window into 5-hour budgets once it is used up", async () => {
    getWindows.mockResolvedValue({
      ...report,
      windows: [
        current({
          tier: "seven_day",
          remainingCostUsd: 0,
          remainingTokens: 0,
          exhaustsAt: null,
          fiveHourWindowsLeft: 6,
          perFiveHourCostUsd: 0,
          perFiveHourTokens: 0,
        }),
      ],
    });
    renderPage();
    const weekly = await screen.findByRole("region", {
      name: "limits.tier.seven_day:seven_day",
    });
    expect(
      within(weekly).getByText("limits.window.usedUp"),
    ).toBeInTheDocument();
    expect(within(weekly).queryByText(/perFiveHour/)).toBeNull();
  });
});
