import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import "./i18n";
import { QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MotionConfig } from "framer-motion";
import { queryClient } from "@/lib/query";
import { Toaster } from "@/components/ui/sonner";
import { FrontendErrorBoundary } from "./components/FrontendErrorBoundary";
import {
  installGlobalErrorHandlers,
  reportFrontendError,
} from "./lib/frontendLogger";
import {
  MODELS_DEV_SYNC_CONFIG_QUERY_KEY,
  syncModelsDevPricingOnStartup,
} from "./lib/modelsDevAutoSync";
import { initializeWindowActivity } from "@/lib/windowActivity";
import { initializeInputModality } from "@/lib/inputModality";

installGlobalErrorHandlers();

// 根据平台添加 body class，便于平台特定样式
try {
  const ua = navigator.userAgent || "";
  const plat = (navigator.platform || "").toLowerCase();
  if (/mac/i.test(ua) || plat.includes("mac")) {
    document.body.classList.add("is-mac");
  }
} catch {
  // 忽略平台检测失败
}

initializeWindowActivity();
initializeInputModality();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <FrontendErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider defaultTheme="system" storageKey="pigger-switch-theme">
          {/* 系统开了「减少动态效果」时，framer-motion 的位移动画一律跳过 */}
          <MotionConfig reducedMotion="user">
            <TooltipProvider delayDuration={0} skipDelayDuration={0}>
              <App />
            </TooltipProvider>
          </MotionConfig>
          <Toaster />
        </ThemeProvider>
      </QueryClientProvider>
    </FrontendErrorBoundary>
  </React.StrictMode>,
);

// models.dev 价格自动同步（用户在定价页打开了才会真的去拉）
void syncModelsDevPricingOnStartup()
  .then((result) => {
    if (!result.skipped) {
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: ["usage"] }),
        queryClient.invalidateQueries({
          queryKey: MODELS_DEV_SYNC_CONFIG_QUERY_KEY,
        }),
      ]);
    }
  })
  .catch((error) => {
    // 离线或 models.dev 暂时不可用不应阻塞应用启动。
    reportFrontendError("models_dev_startup_sync", error);
    void queryClient.invalidateQueries({
      queryKey: MODELS_DEV_SYNC_CONFIG_QUERY_KEY,
    });
  });
