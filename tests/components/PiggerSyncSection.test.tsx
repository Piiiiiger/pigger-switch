import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, PiggerSyncInfo } from "@/lib/api/settings";

const { status, syncNow, toastSuccess, toastError } = vi.hoisted(() => ({
  status: vi.fn(),
  syncNow: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

// 插值的值拼在键后面，断言时能看到具体内容
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${Object.values(options).join("|")}` : key,
    i18n: { resolvedLanguage: "en" },
  }),
}));

vi.mock("@/lib/toast", () => ({
  toast: { success: toastSuccess, error: toastError },
}));

vi.mock("@/lib/api/settings", () => ({
  piggerSyncApi: { status, syncNow },
}));

import { PiggerSyncSection } from "@/components/settings/PiggerSyncSection";

const idle: PiggerSyncInfo = {
  running: false,
  lastRows: 0,
  lastSessions: 0,
  defaultDeviceName: "workstation",
};

function settings(patch: Partial<AppSettings> = {}): AppSettings {
  return {
    showInTray: true,
    minimizeToTrayOnClose: true,
    launchOnStartup: false,
    silentStartup: false,
    sessionAutoSyncEnabled: true,
    piggerSyncEnabled: false,
    ...patch,
  };
}

/** 和设置页一样：保存后拿回存下的设置 */
function Harness({
  initial,
  save,
}: {
  initial: AppSettings;
  save: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const [value, setValue] = useState(initial);
  return (
    <PiggerSyncSection
      settings={value}
      save={async (patch) => {
        await save(patch);
        setValue((current) => ({ ...current, ...patch }));
      }}
    />
  );
}

function renderSection(value: AppSettings) {
  const save = vi.fn().mockResolvedValue(undefined);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Harness initial={value} save={save} />
    </QueryClientProvider>,
  );
  return save;
}

describe("PiggerSyncSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    status.mockResolvedValue(idle);
  });

  it("keeps sync off until the address and token are filled in", async () => {
    renderSection(settings());
    expect(
      screen.getByRole("switch", { name: "settings.pigger.enabled" }),
    ).toBeDisabled();
    expect(screen.getByText("settings.pigger.needsSetup")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /settings.pigger.syncNow/ }),
    ).toBeDisabled();
  });

  it("saves the address, the token and the name as they are entered", async () => {
    const user = userEvent.setup();
    const save = renderSection(settings());
    await screen.findByPlaceholderText("workstation");

    await user.type(
      screen.getByLabelText("settings.pigger.url"),
      "https://panel.example.com/abc123/panel/{Enter}",
    );
    const token = screen.getByLabelText("settings.pigger.token");
    expect(token).toHaveAttribute("type", "password");
    await user.type(token, "upload-only{Enter}");
    await user.type(
      screen.getByLabelText("settings.pigger.deviceName"),
      "laptop{Enter}",
    );

    expect(save.mock.calls.map(([patch]) => patch)).toEqual([
      { piggerUrl: "https://panel.example.com/abc123/panel/" },
      { piggerToken: "upload-only" },
      { piggerDeviceName: "laptop" },
    ]);
  });

  it("says why the last sync failed", async () => {
    status.mockResolvedValue({
      ...idle,
      lastAttemptAt: Math.floor(Date.now() / 1000) - 120,
      lastError: "HTTP 401",
    });
    renderSection(
      settings({
        piggerSyncEnabled: true,
        piggerUrl: "https://panel.example.com",
        piggerToken: "t",
      }),
    );
    const line = await screen.findByText(/settings.pigger.failed:.*HTTP 401/);
    expect(line).toHaveClass("text-danger-text");
  });

  it("pushes everything on Sync now and reports what went", async () => {
    const user = userEvent.setup();
    syncNow.mockResolvedValue({
      reports: 2,
      rows: 140,
      sessions: 12,
      full: true,
    });
    renderSection(
      settings({
        piggerSyncEnabled: true,
        piggerUrl: "https://panel.example.com",
        piggerToken: "t",
      }),
    );
    await screen.findByText("settings.pigger.never");

    await user.click(
      screen.getByRole("button", { name: /settings.pigger.syncNow/ }),
    );

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        "settings.pigger.syncDone:140|12",
      ),
    );
    expect(syncNow).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
  });
});
