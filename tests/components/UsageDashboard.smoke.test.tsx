import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UsageDashboard } from "@/components/usage/UsageDashboard";

/**
 * 不 mock 子组件，把整页（指标、趋势图、各个页签）真渲染一遍，接口用假数据。
 */

const usageApiMock = vi.hoisted(() => ({
  getUsageSummary: vi.fn(),
  getUsageSummaryByApp: vi.fn(),
  getUsageTrends: vi.fn(),
  getProjectStats: vi.fn(),
  getSessionStats: vi.fn(),
  getHourlyActivity: vi.fn(),
  getModelStats: vi.fn(),
  getRequestLogs: vi.fn(),
  getRequestDetail: vi.fn(),
  getModelPricing: vi.fn(),
  getModelsDevSyncConfig: vi.fn(),
  saveModelsDevSyncConfig: vi.fn(),
  syncSessionUsage: vi.fn(),
  getSessionUsageLastSync: vi.fn().mockResolvedValue(null),
  rebuildCodexUsage: vi.fn(),
}));

// t 要稳定：真实的 i18next 也只在切语言时换 t，组件里有依赖 t 的 effect
const i18nMock = vi.hoisted(() => ({
  t: (key: string, options?: unknown) =>
    options && typeof options === "object" && "count" in options
      ? `${key}:${(options as { count: unknown }).count}`
      : key,
  i18n: { resolvedLanguage: "zh", language: "zh" },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => i18nMock,
}));

vi.mock("@/hooks/useUsageEventBridge", () => ({
  useUsageEventBridge: () => {},
}));

vi.mock("@/lib/api/usage", () => ({ usageApi: usageApiMock }));

vi.mock("@/lib/query/subscription", () => ({
  useSubscriptionQuota: () => ({ data: undefined }),
}));

const summary = {
  totalRequests: 3120,
  totalCost: "42.100000",
  totalInputTokens: 1_000_000,
  totalOutputTokens: 400_000,
  totalCacheCreationTokens: 200_000,
  totalCacheReadTokens: 16_600_000,
  successRate: 99.5,
  realTotalTokens: 18_200_000,
  cacheHitRate: 0.7161,
};

describe("UsageDashboard (smoke)", () => {
  beforeEach(() => {
    usageApiMock.getUsageSummary.mockResolvedValue(summary);
    usageApiMock.getUsageSummaryByApp.mockResolvedValue([
      { appType: "claude", summary },
    ]);
    usageApiMock.getUsageTrends.mockResolvedValue([
      {
        date: "2026-09-30T00:00:00+08:00",
        requestCount: 290,
        totalCost: "4.1",
        totalTokens: 1_800_000,
        totalInputTokens: 100_000,
        totalOutputTokens: 50_000,
        totalCacheCreationTokens: 10_000,
        totalCacheReadTokens: 1_640_000,
      },
    ]);
    usageApiMock.getProjectStats.mockResolvedValue([
      {
        project: "/home/me/code/pigger-switch",
        requestCount: 720,
        totalTokens: 4_300_000,
        totalCost: "6.1",
        claudeCost: "4.1",
        codexCost: "2.0",
        sessionCount: 12,
        lastActiveAt: Math.floor(Date.now() / 1000) - 120,
      },
    ]);
    usageApiMock.getSessionStats.mockResolvedValue([
      {
        appType: "claude",
        sessionId: "11111111-2222-3333-4444-555555555555",
        title: "Fix the login flow",
        project: "/home/me/code/pigger-switch",
        model: "claude-opus-5-5",
        requestCount: 64,
        totalTokens: 900_000,
        cacheReadTokens: 12_000_000,
        totalCost: "3.25",
        firstAt: Math.floor(Date.now() / 1000) - 3600,
        lastAt: Math.floor(Date.now() / 1000) - 60,
      },
    ]);
    usageApiMock.getHourlyActivity.mockResolvedValue([
      {
        weekday: 2,
        hour: 14,
        requestCount: 40,
        totalTokens: 500_000,
        totalCost: "2.5",
      },
    ]);
    usageApiMock.getModelStats.mockResolvedValue([
      {
        model: "kimi-k2.6",
        requestCount: 980,
        totalTokens: 5_700_000,
        totalCost: "11.2",
        avgCostPerRequest: "0.0114",
      },
    ]);
    usageApiMock.getRequestLogs.mockResolvedValue({
      data: [],
      total: 0,
      page: 0,
      pageSize: 20,
    });
    usageApiMock.getModelPricing.mockResolvedValue([
      {
        modelId: "deepseek-v4-pro",
        displayName: "DeepSeek V4 Pro",
        inputCostPerMillion: "1.32",
        outputCostPerMillion: "3.96",
        cacheReadCostPerMillion: "0.044",
        cacheCreationCostPerMillion: "0",
      },
    ]);
    usageApiMock.getModelsDevSyncConfig.mockResolvedValue({
      configPath: "/tmp/model-pricing.json",
      config: {
        autoSyncEnabled: true,
        includeCommonModels: true,
        selectedModelKeys: [],
        excludedCommonModelKeys: [],
        lastSyncAt: Date.now() - 2 * 60 * 60 * 1000,
        lastSyncError: null,
      },
    });
  });

  it("renders metrics, trend, and every tab with real children", async () => {
    const user = userEvent.setup();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <UsageDashboard />
      </QueryClientProvider>,
    );

    // 指标卡
    expect(await screen.findByText("$42.10")).toBeInTheDocument();
    expect(screen.getByText("18.2M")).toBeInTheDocument();
    // 「全部」时由各应用的 token 重新算：16.6M ÷ (1M + 0.2M + 16.6M)
    expect(screen.getByText("93.3%")).toBeInTheDocument();
    expect(screen.getByText("usage.trend.title")).toBeInTheDocument();

    // 更多指标
    await user.click(
      screen.getByRole("button", { name: "usage.metrics.more" }),
    );
    expect(
      screen.getByRole("button", { name: "usage.metrics.more" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("usage.cacheWrite")).toBeInTheDocument();

    // 项目：目录名 + 会话数 + 花费
    await user.click(screen.getByRole("tab", { name: "usage.tabs.projects" }));
    const projectRow = (await screen.findByText("pigger-switch")).closest(
      "tr",
    )!;
    expect(within(projectRow).getByText("12")).toBeInTheDocument();
    expect(within(projectRow).getByText("$6.10")).toBeInTheDocument();

    // 会话：标题；点进去回到请求日志并按会话筛选
    await user.click(screen.getByRole("tab", { name: "usage.tabs.sessions" }));
    const sessionRow = (await screen.findByText("Fix the login flow")).closest(
      "tr",
    )!;
    expect(within(sessionRow).getByText("$3.25")).toBeInTheDocument();
    await user.click(sessionRow);
    expect(
      screen.getByRole("tab", { name: "usage.requestLogs" }),
    ).toHaveAttribute("aria-selected", "true");
    expect(usageApiMock.getRequestLogs).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessionId: "11111111-2222-3333-4444-555555555555",
      }),
      0,
      20,
    );

    // 活跃时段：最忙的钟头
    await user.click(screen.getByRole("tab", { name: "usage.tabs.activity" }));
    expect(
      await screen.findByText(/usage\.activity\.busiest/),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "usage.tabs.models" }));
    expect(await screen.findByText("kimi-k2.6")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "usage.tabs.pricing" }));
    expect(await screen.findByText("DeepSeek V4 Pro")).toBeInTheDocument();
    expect(screen.getByText("$1.32")).toBeInTheDocument();
    expect(screen.getByText("$0.044")).toBeInTheDocument();
    expect(
      await screen.findByText("usage.pricing.modelsDevTitle"),
    ).toBeInTheDocument();
  });
});
