# Pigger Switch

**Claude Code** 和 **Codex** 的用量统计，两个工具各有各的页面：用了多少 token、按 API 价格折算值多少钱、花在了哪些项目上，以及订阅的 5 小时和每周额度实际是多少。

[English](README.md) | 中文

Pigger Switch 读取 Claude Code（`~/.claude/projects`）和 Codex（`~/.codex/sessions`）本来就会写在电脑上的会话日志，不需要代理，不需要 API Key，也不改动这两个工具的任何配置。

## 两个工具分开看

侧栏分成 **Claude Code** 和 **Codex** 两组，每组有自己的**用量统计**和**订阅额度**页，名字旁边是它今天的花费。两边的数从不混在一起：一个工具页里的每个数字、图表、表格和导出都只属于这个工具。**模型价格**和**设置**是两个工具共用的。

## 订阅额度

订阅只告诉你每个窗口用了百分之几、什么时候重置。Pigger Switch 把它和这个工具在本机同一窗口里的用量放在一起，每个窗口就有了实际的数：

- **每个窗口**：Claude 的 5 小时窗口、每周窗口和各模型的每周窗口（Opus、Sonnet、Fable），以及 Codex 用的 ChatGPT 订阅的各个窗口。
- **已用 / 额度 / 剩余**：这个窗口到现在用了多少（按 API 价格折算的美元和 token）、估出的窗口总额度和它的范围、还剩多少。
- **速度**：照现在的速度，什么时候用完，或者到重置时用到几成。
- **每周额度按 5 小时分**：这周剩下的额度平均分到重置前的每个 5 小时。
- **历史窗口**：之前的每个 5 小时和每周窗口：请求数、token、花费、订阅报过的最高百分比，以及由这个读数算出的额度。开始记录读数之前的窗口按你的请求推算，拿典型额度来比。

估算方法：额度 ≈ 窗口里的用量 ÷ 订阅给的百分比。每次读数都会记下，每个窗口用它最高的那次。窗口用得还很少（不到 10%）时，整数百分比太粗，改用最近几个窗口的中位数。claude.ai 网页版、别的电脑和 Codex 云端任务的使用也算进同一个额度，但不在本机的日志里，所以用到它们时估出来会偏低。

## 用量统计

- **概览**：任意时间段的花费、请求数、token 数、缓存命中率，并和上一个同样长的时段对比；趋势图、年度热力图。
- **项目**：按会话所在的目录统计用量，点一个项目就把整页筛到它。
- **会话**：最贵的会话（带 Claude Code 自己起的标题），点进去看这个会话的每一条请求。
- **模型**：按模型统计用量和花费。
- **活跃时段**：星期 × 小时热力图，看你什么时候用得最多。
- **导出 CSV**：每日汇总、项目、模型、会话或每一条请求。

花费是**按 API 价格折算**的：这些 token 按各模型的 API 单价值多少钱。用订阅的话，这是订阅给你带来的价值，不是实际扣的钱。

## 其他

- **模型价格**：两个工具共用一张可以手改的价目表，也可以从 [models.dev](https://models.dev) 同步。
- **提醒**：额度用到设定的比例、或者当天 / 当月花费超过预算时发桌面通知。
- **托盘**：菜单栏 / 系统托盘里每个工具各占一块：它今天和本月的花费、它的订阅额度。
- **同步到 Pigger**：每 10 分钟把用量推送到 [Pigger](https://github.com/Piiiiiger/Proxypigger) 面板的「AI 用量」页，用的令牌只能上传用量。
- **从 CC Switch 导入**：从已有的 CC Switch 数据库（`~/.cc-switch/cc-switch.db`）导入更早的历史，已经统计过的日子会跳过。

## 命令行

```bash
pigger-switch --limits claude   # 扫一遍日志、查一次额度，把每个窗口的估算打成 JSON
pigger-switch --limits codex
pigger-switch --sync-once       # 扫一遍日志、把全部用量推到 Pigger，给没有桌面的机器配定时任务用
```

## 隐私

所有数据都留在本机的 `~/.pigger-switch/` 里。只有这些网络请求：

- 订阅额度：用 Claude Code、Codex 已有的登录信息只读地查询 `api.anthropic.com` 和 `chatgpt.com`。
- 从 `models.dev` 同步价格（打开了才会同步）。
- 同步到 Pigger（设置了才会同步）：按项目目录和模型的每日汇总、会话标题和花费、电脑名称、订阅额度读数，发到你填的面板地址。

## 构建

需要 Node.js 22+、pnpm 10、Rust 1.95，以及所在系统的 [Tauri 2 依赖](https://tauri.app/start/prerequisites/)。

```bash
pnpm install
pnpm dev          # 开发模式运行
pnpm build        # 打包安装包到 src-tauri/target/release/bundle
pnpm test:unit    # 前端测试
cd src-tauri && cargo test   # 后端测试
```

## 致谢

Pigger Switch 是 Jason Young 的 [CC Switch](https://github.com/farion1231/cc-switch) 的精简分支：保留了 CC Switch 的用量统计引擎，去掉了其余功能。MIT 许可证。
