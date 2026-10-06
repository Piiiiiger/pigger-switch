# Pigger Switch

Usage statistics for **Claude Code** and **Codex**, each on its own pages: how many tokens you use, what they would cost at API prices, where they go, and what your plan's 5-hour and weekly limits actually come to.

[English](README.md) | [中文](README_ZH.md)

Pigger Switch reads the session logs that Claude Code (`~/.claude/projects`) and Codex (`~/.codex/sessions`) already write on your computer. It needs no proxy, API key or change to either tool.

## Two tools, kept apart

The sidebar has a **Claude Code** group and a **Codex** group, each with its own **Usage** and **Plan limits** pages and today's spend next to its name. Nothing mixes the two: every number, chart, table and export on a tool's page is that tool alone. **Model prices** and **Settings** are shared.

## Plan limits

The plans only report a percentage per window and when it resets. Pigger Switch puts that next to what the tool used on this computer in the same window, so each window gets real numbers:

- **Every window**: Claude's 5-hour window, the weekly window and the per-model weekly windows (Opus, Sonnet, Fable), and Codex's windows from your ChatGPT plan.
- **Used / limit / left**: what the window has used so far in API-equivalent dollars and tokens, the window's estimated total limit with its range, and how much is left.
- **Pace**: at the current pace, when the window runs out, or how full it will be at the reset.
- **Weekly budget per 5 hours**: what is left of the week, split over the 5-hour stretches until the weekly reset.
- **Past windows**: each earlier 5-hour and weekly window with its requests, tokens, cost, the highest percentage the plan reported and the limit that reading implies. Windows from before readings were recorded are rebuilt from your requests and measured against the typical limit.

How the estimate works: limit ≈ usage in the window ÷ reported percentage. Every reading is saved, and each window uses its highest one. A window used only a little (under 10%) borrows the median of recent windows instead, because a whole-number percentage is too coarse there. Usage on claude.ai, other computers or Codex cloud tasks counts toward the same limit but is not in this computer's logs, so the estimate runs low when you use them.

## Usage

- **Overview**: cost, requests, tokens and cache hit rate for any time range, compared with the previous period, with a trend chart and a yearly heatmap.
- **Projects**: usage grouped by the folder each session ran in. Click a project to filter the page.
- **Sessions**: the most expensive sessions with Claude Code's own session titles. Click one to see every request in it.
- **Models**: usage and cost per model.
- **Active hours**: a weekday × hour heatmap of when you use the tool most.
- **CSV export**: daily totals, projects, models, sessions or every request.

Costs are **API-equivalent**: what the tokens would cost at the per-model API prices. On a subscription this is the value you got out of the plan, not what you were charged.

## Also

- **Model prices**: one editable price table for both tools, which can sync from [models.dev](https://models.dev).
- **Alerts**: desktop notifications when a limit window reaches a chosen percentage, or when daily or monthly spend passes a budget.
- **Tray**: each tool on its own in the menu bar or system tray: its spend today and this month, and its plan windows.
- **Sync to Pigger**: pushes usage every 10 minutes to the AI usage page of a [Pigger](https://github.com/Piiiiiger/Proxypigger) panel, with a token that can only upload usage.
- **Import from CC Switch**: brings in older history from an existing CC Switch database (`~/.cc-switch/cc-switch.db`). Days that are already counted are skipped.

## Command line

```bash
pigger-switch --limits claude   # scan the logs, read the plan, print every window's estimate as JSON
pigger-switch --limits codex
pigger-switch --sync-once       # scan the logs and push everything to Pigger, for a timer on a machine without a desktop
```

## Privacy

Everything stays on your computer, in `~/.pigger-switch/`. The app makes only these network requests:

- Plan limits: `api.anthropic.com` and `chatgpt.com`, using the logins Claude Code and Codex already have (read-only).
- Price sync from `models.dev`, only if you turn it on.
- Sync to Pigger, only if you set it up: daily totals per project folder and model, session titles and costs, the computer's name and plan readings go to the panel address you enter.

## Build

Requirements: Node.js 22+, pnpm 10, Rust 1.95 and the [Tauri 2 prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```bash
pnpm install
pnpm dev          # run in development
pnpm build        # build installers into src-tauri/target/release/bundle
pnpm test:unit    # frontend tests
cd src-tauri && cargo test   # backend tests
```

## Credits

Pigger Switch is a trimmed-down fork of [CC Switch](https://github.com/farion1231/cc-switch) by Jason Young. It keeps CC Switch's usage-statistics engine and drops everything else. Licensed under MIT.
