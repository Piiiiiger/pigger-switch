import claudeSvg from "@/assets/brands/claude.svg?raw";
import openaiSvg from "@/assets/brands/openai.svg?raw";
import type { AppType } from "@/types/usage";
import { cn } from "@/lib/utils";

/** 应用名：品牌名不翻译，四种语言都写原文。 */
export const APP_DISPLAY_NAME: Record<AppType, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

/** 图表里区分两个应用用的颜色（Claude 橙、Codex 青绿） */
export const APP_COLOR: Record<AppType, string> = {
  claude: "#D97757",
  codex: "#10A37F",
};

const APP_SVG: Record<AppType, string> = {
  claude: claudeSvg,
  codex: openaiSvg,
};

interface AppGlyphProps {
  app: AppType;
  size?: number;
  className?: string;
}

/** 应用图标（装饰性，名称由旁边的文字或按钮的 aria-label 提供）。 */
export function AppGlyph({ app, size = 16, className }: AppGlyphProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center [&>svg]:h-full [&>svg]:w-full",
        app === "claude" ? "text-[#D97757]" : "text-fg-1",
        className,
      )}
      style={{ width: size, height: size }}
      dangerouslySetInnerHTML={{ __html: APP_SVG[app] }}
    />
  );
}
