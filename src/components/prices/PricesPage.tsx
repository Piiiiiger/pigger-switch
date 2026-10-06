import { useTranslation } from "react-i18next";
import { Tags } from "lucide-react";
import { AppPageHeader } from "@/components/shell/AppPageHeader";
import { HelpTip } from "@/components/ui/help-tip";
import { PricingConfigPanel } from "@/components/usage/PricingConfigPanel";

/** 模型价格：两个工具共用的一张价目表（API 等价花费按它算），可从 models.dev 同步 */
export function PricesPage() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AppPageHeader
        icon={<Tags className="h-5 w-5" strokeWidth={1.5} />}
        title={t("nav.prices")}
        titleExtra={
          <HelpTip title={t("nav.prices")}>{t("prices.help")}</HelpTip>
        }
      />
      <div
        id="main-content"
        className="flex min-h-0 flex-1 flex-col overflow-y-auto scroll-stable px-6 pb-6 pt-2"
      >
        <PricingConfigPanel />
      </div>
    </div>
  );
}
