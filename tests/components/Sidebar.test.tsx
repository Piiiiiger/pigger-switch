import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { budget, today } = vi.hoisted(() => ({
  budget: { current: undefined as unknown },
  today: { current: undefined as unknown },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { resolvedLanguage: "en", language: "en" },
  }),
}));

vi.mock("@/lib/query/usage", () => ({
  useBudgetStatus: () => ({ data: budget.current }),
  useUsageSummaryByApp: () => ({ data: today.current }),
}));

import { Sidebar, pageTool, parsePage } from "@/components/shell/Sidebar";

const summary = (totalCost: string) => ({
  totalRequests: 1,
  totalCost,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheCreationTokens: 0,
  totalCacheReadTokens: 0,
  successRate: 100,
  realTotalTokens: 0,
  cacheHitRate: 0,
});

describe("Sidebar", () => {
  beforeEach(() => {
    budget.current = {
      todayCost: 60,
      monthCost: 900,
      dailyBudget: null,
      monthlyBudget: null,
    };
    today.current = [{ appType: "claude", summary: summary("60.08") }];
  });

  it("gives Claude Code and Codex their own group with their own pages", async () => {
    const user = userEvent.setup();
    const onSelectPage = vi.fn();
    render(<Sidebar page="claude.usage" onSelectPage={onSelectPage} />);

    const claude = screen.getByRole("group", { name: "Claude Code" });
    const codex = screen.getByRole("group", { name: "Codex" });
    expect(within(claude).getByText("$60.08")).toBeInTheDocument();
    expect(within(codex).getByText("$0.00")).toBeInTheDocument();
    expect(
      within(claude).getByRole("button", { name: "nav.usage" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      within(codex).getByRole("button", { name: "nav.usage" }),
    ).not.toHaveAttribute("aria-current");

    await user.click(within(codex).getByRole("button", { name: "nav.limits" }));
    expect(onSelectPage).toHaveBeenLastCalledWith("codex.limits");
    await user.click(screen.getByRole("button", { name: "nav.prices" }));
    expect(onSelectPage).toHaveBeenLastCalledWith("prices");
    // 没超预算时不显示合计
    expect(screen.queryByText(/overDailyBudget|overMonthlyBudget/)).toBeNull();
  });

  it("warns when a budget is passed", () => {
    budget.current = {
      todayCost: 60,
      monthCost: 900,
      dailyBudget: 50,
      monthlyBudget: null,
    };
    render(<Sidebar page="settings" onSelectPage={vi.fn()} />);
    expect(screen.getByText("nav.overDailyBudget")).toBeInTheDocument();
  });

  it("reads stored pages, sending the old combined ones to Claude", () => {
    expect(parsePage("usage")).toBe("claude.usage");
    expect(parsePage("limits")).toBe("claude.limits");
    expect(parsePage("codex.limits")).toBe("codex.limits");
    expect(parsePage("settings")).toBe("settings");
    expect(parsePage("gemini.usage")).toBeNull();
    expect(parsePage(null)).toBeNull();
    expect(pageTool("codex.usage")).toBe("codex");
    expect(pageTool("prices")).toBeNull();
  });
});
