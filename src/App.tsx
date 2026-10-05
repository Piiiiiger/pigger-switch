import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Sidebar, type Page } from "@/components/shell/Sidebar";
import { UsagePage } from "@/components/usage/UsagePage";
import { LimitsPage } from "@/components/limits/LimitsPage";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { useSettings } from "@/hooks/useSettings";
import { useSubscriptionQuotaBridge } from "@/lib/query/subscription";

const PAGE_STORAGE_KEY = "pigger-switch-page";

function readStoredPage(): Page {
  try {
    const stored = window.localStorage.getItem(PAGE_STORAGE_KEY);
    if (stored === "usage" || stored === "limits" || stored === "settings") {
      return stored;
    }
  } catch {
    // localStorage 不可用时用默认页
  }
  return "usage";
}

export default function App() {
  const { i18n } = useTranslation();
  const { settings } = useSettings();
  const [page, setPage] = useState<Page>(readStoredPage);

  useSubscriptionQuotaBridge();

  // 设置里选了语言就用它（没选时 i18n 已按系统语言初始化）
  useEffect(() => {
    const language = settings?.language;
    if (language && i18n.language !== language) {
      void i18n.changeLanguage(language);
    }
  }, [i18n, settings?.language]);

  const selectPage = (next: Page) => {
    setPage(next);
    try {
      window.localStorage.setItem(PAGE_STORAGE_KEY, next);
    } catch {
      // 忽略
    }
  };

  return (
    <div className="flex h-screen min-h-0 w-full overflow-hidden bg-surface text-fg-1">
      <Sidebar page={page} onSelectPage={selectPage} />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {page === "usage" && (
          <UsagePage
            onOpenLimits={() => selectPage("limits")}
            onOpenSettings={() => selectPage("settings")}
          />
        )}
        {page === "limits" && (
          <LimitsPage onOpenSettings={() => selectPage("settings")} />
        )}
        {page === "settings" && <SettingsPage />}
      </main>
    </div>
  );
}
