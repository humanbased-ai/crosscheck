<div align="right">
  <h5><a href="./get-started.md">🌐 &nbsp;English</a></h5>
</div>

# crosscheck — 快速上手

## 目录

- [前提条件](#前提条件)
- [安装](#安装)
- [环境变量](#环境变量)
- [第一步 — 配置 crosscheck](#第一步--配置-crosscheck)
- [第二步 — 用单个 PR 测试](#第二步--用单个-pr-测试)
- [第三步 — 选择部署模式](#第三步--选择部署模式)
- [第四步 — 验证运行正常](#第四步--验证运行正常)
- [命令](#命令)
  - [init](#crosscheck-init)
  - [onboard](#crosscheck-onboard)
  - [review](#crosscheck-review-pr-url)
  - [run](#crosscheck-run-pr-url)
  - [watch](#crosscheck-watch)
  - [serve](#crosscheck-serve-beta)
  - [status](#crosscheck-status)
  - [diagnose](#crosscheck-diagnose)
  - [optimize](#crosscheck-optimize)
  - [impact](#crosscheck-impact)
  - [issue](#crosscheck-issue)
- [自定义根目录](#自定义根目录)
- [配置](#配置)
- [工作原理](#工作原理)
- [审查后自动修复](#审查后自动修复)
- [常见问题](#常见问题)

---

## 前提条件

运行 crosscheck 之前，你需要安装并认证以下三个 CLI 工具。

### Claude Code

```bash
npm install -g @anthropic-ai/claude-code
claude   # 按提示登录 claude.ai
```

需要 Claude Pro 或 Max 订阅计划。审查使用你的订阅配额，无需按 token 计费。

### Codex

```bash
npm install -g @openai/codex
codex login --device-auth   # 使用 ChatGPT 账号 OAuth 登录
```

需要 ChatGPT Plus 或 Pro 订阅。通过 `--device-auth` 认证后，审查消耗订阅配额，无需 API Key。

如果你更倾向于使用 OpenAI API Key：

```bash
printenv OPENAI_API_KEY | codex login --with-api-key
```

然后在配置中设置 `auth: api-key` 以启用模型选择。

### GitHub CLI

```bash
brew install gh       # macOS
gh auth login
```

用于克隆 PR 分支，在 watch 模式下自动注册 Webhook。

---

## 安装

**稳定版（推荐）：**

```bash
npm install -g @humanbased/crosscheck
```

**Beta 版（最新特性，可能存在问题）：**

```bash
npm install -g @humanbased/crosscheck@beta
```

**npx — 无需安装：**

```bash
npx @humanbased/crosscheck <命令>
npx @humanbased/crosscheck@beta <命令>
```

**从源码安装：**

```bash
git clone https://github.com/humanbased-ai/crosscheck
cd crosscheck
npm install && npm run build && npm link
```

---

## 环境变量

### GitHub 认证 — 两种方式（选其一）

**方式一 — gh CLI（推荐）：** 认证一次，crosscheck 自动获取 Token：

```bash
gh auth login
```

**方式二 — Personal Access Token：** 适合 CI 环境或偏好显式 Token：

```bash
export GITHUB_TOKEN=ghp_...
```

Classic PAT 需要 `repo` 和 `admin:org_hook` 权限（Org 级别 Webhook 需要 `admin:org_hook`；仅 Repo 级别只需 `repo`）。在 [github.com/settings/tokens](https://github.com/settings/tokens) 生成。

如果两者都存在，crosscheck 优先使用 `gh` keyring 中的 Token（始终最新），以 `GITHUB_TOKEN` 为备选。

### Webhook Secret — 自动管理

`CROSSCHECK_WEBHOOK_SECRET` 是**可选的**。如果未设置，crosscheck 会在首次使用时生成一个随机 Secret，保存到 `~/.crosscheck/webhook-secret`（仅本人可读），之后每次运行自动复用。

稍后查询（例如需要手动注册 Webhook 时）：

```bash
cat ~/.crosscheck/webhook-secret
```

如需使用自定义 Secret，在 shell 配置文件中设置：

```bash
export CROSSCHECK_WEBHOOK_SECRET=your-secret
```

---

## 第一步 — 配置 crosscheck

```bash
crosscheck onboard
```

`crosscheck onboard` 是推荐的首次配置方式。它会检查你的 CLI 环境，引导你完成部署模式选择、仓库选择、审查模式和工作流流水线，然后一次性写入可用的配置。详见 [`crosscheck onboard`](#crosscheck-onboard) 命令参考。

完成后直接运行 `crosscheck watch` 即可，无需单独执行 init 步骤。

> 如果你希望跳过向导手动配置，可运行 `crosscheck init` 生成初始配置，然后直接编辑 `~/.crosscheck/config.yml`。

---

## 第二步 — 用单个 PR 测试

在持续运行之前，先用一个 PR 验证端到端流程：

```bash
crosscheck review https://github.com/owner/repo/pull/123 --reviewer codex
```

此命令会克隆 PR 分支，运行 Codex 审查，并在 PR 中发布评论。如果无报错完成，说明你的配置正常。

也可以用 Claude 作为审查者：

```bash
crosscheck review https://github.com/owner/repo/pull/123 --reviewer claude
```

---

## 第三步 — 选择部署模式

### 个人模式 vs 团队模式

首次运行时，`crosscheck watch`（或 `crosscheck serve`）会询问使用方式：

```
How are you using crosscheck?

  [1] personal  — monitor all your repos and orgs; review only PRs you author
  [2] team      — monitor org repos only; review all PRs from any author

  Choice [1]:
```

选择会以 `deployment: personal` 或 `deployment: team` 的形式保存到 `crosscheck.config.yml`。

**个人模式**（默认，个人开发者推荐）
- 监控你 GitHub 账号下的所有个人仓库 + 所属所有 Org
- 只审查你提交的 PR，忽略其他人的
- 自动将 `routing.allowed_authors` 设置为你的 GitHub 登录名

**团队模式**（共享机器推荐）
- 只监控你所属 Org 的仓库（不含个人仓库）
- 审查所有人提交的 PR，不过滤作者

单次会话覆盖已保存的选择（不修改配置）：

```bash
crosscheck watch --personal   # 本次会话使用个人模式
crosscheck watch --team       # 本次会话使用团队模式
```

重新运行提示并永久修改选择：

```bash
crosscheck watch --reconfigure
```

### Watch 模式 — 适合开发机器

启动本地服务器，通过 `localhost.run`（SSH，无需额外安装）开通公网隧道，让 GitHub 能访问你的本地机器。自动注册 Webhook，支持 Org 级或 Repo 级覆盖，终端开启期间持续运行。

```bash
# 监控整个 Org（在 crosscheck.config.yml 中配置）
crosscheck watch

# 或在仓库目录内运行 — 自动从 git remote 检测
cd /path/to/your/repo && crosscheck watch
```

```
crosscheck watch

  orgs      humanbased-ai, codatta
  mode      cross-vendor
  quality   balanced
  config    ./crosscheck.config.yml  ← 编辑可修改以上配置

  ✓ tunnel ready: https://abc123.lhr.life
  tunnel    https://abc123.lhr.life
  ✓ webhook registered for humanbased-ai

Waiting for PR events — Ctrl+C to stop.
```

按下 `Ctrl+C` 后，SSH 隧道和已注册的 Webhook 会自动清理。

**Org Webhook 所需 Token 权限：** `GITHUB_TOKEN` 需要 `write:org` 权限用于 Org 级覆盖，Repo 级只需 `repo` 权限。

### Serve 模式 [BETA] — 适合常驻机器（mac-mini、家庭服务器）

> **Beta：** `serve` 功能可用，但尚未经过充分生产验证。欢迎在 [github.com/humanbased-ai/crosscheck/issues](https://github.com/humanbased-ai/crosscheck/issues) 报告问题。

监听固定端口，Webhook 只需手动注册一次，永久生效。

```bash
crosscheck serve
```

```
crosscheck serving
⚠  serve is in beta — report issues at github.com/humanbased-ai/crosscheck/issues

  mode      cross-vendor
  quality   balanced
  port      7891
  endpoint  http://your-machine.local:7891/webhook

Register the endpoint above as a GitHub org webhook (content-type: application/json).
  → https://github.com/organizations/humanbased-ai/settings/hooks
  → https://github.com/organizations/codatta/settings/hooks
```

**Org 级覆盖**（覆盖 Org 下所有仓库），在以下位置注册：
`https://github.com/organizations/<org>/settings/hooks`

**Repo 级覆盖**，在以下位置注册：
`https://github.com/<owner>/<repo>/settings/hooks`

- Payload URL：`http://your-machine:7891/webhook`
- Content type：`application/json`
- Secret：`CROSSCHECK_WEBHOOK_SECRET` 的值
- 触发事件：仅 **Pull requests**

**macOS launchd 后台服务配置：**

```xml
<!-- ~/Library/LaunchAgents/dev.crosscheck.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.crosscheck</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/crosscheck</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>GITHUB_TOKEN</key><string>ghp_your_token</string>
    <key>CROSSCHECK_WEBHOOK_SECRET</key><string>your_secret</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/crosscheck.log</string>
  <key>StandardErrorPath</key><string>/tmp/crosscheck.error.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/dev.crosscheck.plist
launchctl start dev.crosscheck
```

**pm2 运行（跨平台）：**

```bash
npm install -g pm2
pm2 start crosscheck -- serve
pm2 save && pm2 startup
```

---

## 第四步 — 验证运行正常

提交一个 PR（或向已有 PR 推送）。你应该看到：

1. 事件到达时，终端中出现日志行
2. 约 60 秒内，PR 中发布代码审查评论

如果没有出现，运行 `crosscheck status` 检查认证和配置，然后在 GitHub 的 `Settings → Webhooks → Recent Deliveries` 查看 Webhook 投递日志。

---

## 命令

### `crosscheck init`

检查环境并生成初始配置文件。

```bash
crosscheck init
crosscheck init --config /path/to/crosscheck.config.yml
```

检查内容：`codex` CLI、`claude` CLI、`gh` CLI、`GITHUB_TOKEN`、`CROSSCHECK_WEBHOOK_SECRET`。

| 参数 | 说明 |
|---|---|
| `-c, --config <path>` | 将配置文件写入指定路径 |

---

### `crosscheck onboard`

推荐的首次配置命令，交互式引导完成七个步骤并写入可用配置。

```bash
crosscheck onboard
crosscheck onboard --yes          # 非交互式，接受所有默认值
crosscheck onboard --personal     # 本次会话强制使用个人模式
crosscheck onboard --team         # 本次会话强制使用团队模式
crosscheck onboard --reconfigure  # 即使配置已存在也重新运行设置
```

**七个步骤：**

**步骤 1 — 环境检查。** 验证 codex CLI、claude CLI、gh CLI 和 GitHub Token。至少需要一个 AI CLI 已认证；gh auth 始终必须。打印 ✓/✗ 及修复提示。

**步骤 2 — 部署模式。** 选择 crosscheck 的工作范围：
- `personal` — 监控你的个人仓库 + 所属所有 Org；只审查你提交的 PR
- `team` — 只监控 Org 仓库；审查所有人提交的 PR

**步骤 3 — 仓库选择。** 列出可访问的仓库和 Org，选择要监控的目标。选择 Org 级别可用一个 Webhook 覆盖该 Org 下所有仓库。

**步骤 4 — 审查模式。** 如果两个 CLI 都可用，选择：
- `cross-vendor` — Claude 审查 Codex 的 PR；Codex 审查 Claude 的 PR（同时使用两个 Agent 时推荐）
- `single-vendor` — 一个 AI 审查所有 PR（只安装了一个 CLI 时默认）

**步骤 5 — 工作流流水线。** 选择审查后的行为：

```
  [1] review only              — AI 发布评论；由你处理修复
  [2] review → fix             — AI 审查，然后自动应用修复（推荐）
  [3] review → fix → re-check  — 完整闭环：审查、修复、再次审查确认
```

选择 `review → fix → re-check` 会写入包含三个流水线步骤的 `~/.crosscheck/workflow.yml`。

**步骤 6 — 连接方式。** 选择 GitHub Webhook 如何到达本地服务器：
- `localhost.run` — 零配置 SSH 隧道；自动重连，无需安装 *（默认）*
- `smee.io` — Webhook 中继；离线时事件排队，频道 URL 稳定（需要 `npm install -g smee-client` 和配置中的 `tunnel.smee_channel`）

**步骤 7 — 确认并写入配置。** 展示所有选择的摘要并写入 `~/.crosscheck/config.yml`（以及选择了 re-check 时的 `workflow.yml`）。

```
crosscheck onboard

  Step 1 — environment check
  ✓ codex CLI            codex-cli 0.128.0 — authenticated
  ✓ claude CLI           2.1.x (Claude Code)
  ✓ gh CLI               gh version 2.65.0
  ✓ GITHUB_TOKEN         set (gh auth login)

  Step 2 — deployment mode
  [1] personal  [2] team
  Choice [1]: 1

  Step 3 — select repos to monitor
  [1] humanbased-ai (org · 12 repos)
  [2] codatta (org · 5 repos)
  [3] your-github-login (personal · 8 repos)
  Select [all]: 1,3

  Step 4 — review mode
  [1] cross-vendor  [2] single-vendor
  Choice [1]: 1

  Step 5 — workflow pipeline
  [1] review only  [2] review → fix  [3] review → fix → re-check
  Choice [2]: 3

  Step 6 — connection type
  [1] localhost.run  [2] smee.io
  Choice [1]: 1

  Step 7 — review and write config
  deployment   personal
  connection   localhost.run
  orgs         humanbased-ai
  users        your-github-login (8 repos)
  mode         cross-vendor
  pipeline     review-fix-recheck
  config       ~/.crosscheck/config.yml

  ✓ config written to ~/.crosscheck/config.yml
  ✓ workflow written to ~/.crosscheck/workflow.yml

  Next: run  crosscheck watch  to start reviewing PRs.
```

> **`crosscheck init` vs `crosscheck onboard`** — `init` 只做轻量级环境检查（无仓库选择，无流水线提示）。适合快速健康检查或 CI 场景。`onboard` 是完整的首次配置向导。

| 参数 | 说明 |
|---|---|
| `-c, --config <path>` | 将配置写入指定路径 |
| `-y, --yes` | 非交互式，接受所有默认值 |
| `--personal` | 本次会话使用个人部署模式 |
| `--team` | 本次会话使用团队部署模式 |
| `--reconfigure` | 即使配置中已设置 `deployment` 也重新运行设置 |

---

### `crosscheck review <pr-url>`

手动触发对单个 PR 的审查。

```bash
crosscheck review https://github.com/owner/repo/pull/123
crosscheck review https://github.com/owner/repo/pull/123 --reviewer codex
crosscheck review https://github.com/owner/repo/pull/123 --reviewer claude
```

| 参数 | 说明 |
|---|---|
| `-r, --reviewer codex\|claude` | 跳过自动检测，强制使用指定审查者 |
| `-c, --config <path>` | 使用指定配置文件 |

---

### `crosscheck run <pr-url>`

对单个 PR 执行完整配置的工作流：审查 → 自动修复 → 复查。`crosscheck review` 在发布评论后停止，`crosscheck run` 会完成闭环——如果发现问题，原作者 Agent 会打开修复 PR，crosscheck 随后对其进行复查。

```bash
crosscheck run https://github.com/owner/repo/pull/123
crosscheck run https://github.com/owner/repo/pull/123 --reviewer claude
crosscheck run https://github.com/owner/repo/pull/123 --fixer claude
crosscheck run https://github.com/owner/repo/pull/123 --vendor claude
crosscheck run https://github.com/owner/repo/pull/123 --steps review,fix
crosscheck run https://github.com/owner/repo/pull/123 --dry-run
```

执行的工作流从仓库根目录的 `.crosscheck/workflow.yml`（如存在）加载，否则回退到内置默认流水线（仅审查）。使用 `crosscheck run` 对真实 PR 进行端到端完整流水线测试。

| 参数 | 说明 |
|---|---|
| `-r, --reviewer codex\|claude` | 强制 review/recheck 步骤使用该 vendor，并跳过审查路由自动检测 |
| `--fixer codex\|claude` | 强制 fix 步骤使用该 vendor |
| `--vendor codex\|claude` | 强制 review、recheck、fix 步骤都使用该 vendor |
| `--steps <list>` | 只运行列出的步骤类型，逗号分隔：`review`、`fix`、`recheck` |
| `--dry-run` | 运行审查但不发布评论或应用修复 |
| `-c, --config <path>` | 使用指定配置文件 |

---

### `crosscheck watch`

本地开发模式。自动创建隧道，注册 Webhook，退出时自动清理。

```bash
cd /path/to/your/repo
crosscheck watch
```

使用 `localhost.run`（SSH）开通公网隧道——SSH 在 macOS/Linux 预装，无需额外安装或注册账号。Org 级覆盖需要 `GITHUB_TOKEN` 拥有 `write:org` 权限，Repo 级只需 `repo` 权限。

| 参数 | 说明 |
|---|---|
| `-c, --config <path>` | 使用指定配置文件 |

---

### `crosscheck serve` [BETA]

常驻模式，监听固定端口，Webhook 只需手动注册一次。

```bash
crosscheck serve
```

| 参数 | 说明 |
|---|---|
| `-c, --config <path>` | 使用指定配置文件 |

---

### `crosscheck status`

显示认证状态、配置摘要和 CLI 版本信息。

```bash
crosscheck status
```

```
crosscheck status

  Auth
  ✓ codex                  authenticated
  ✓ claude                 2.1.x (Claude Code)
  ✓ GITHUB_TOKEN           via gh auth login
  ✓ WEBHOOK_SECRET         auto-managed at ~/.crosscheck/webhook-secret

  Config
    mode                   cross-vendor
    quality tier           balanced
    codex auth             subscription
    claude model           sonnet
    per-review budget      $2.00/review

  Impact
    summary                47 reviews · ~43h saved · 19 issues caught
                           (run crosscheck impact for details)

  Logs
    path                   ~/.crosscheck/logs/
    today                  2026-05-08.ndjson  (12 entries)

  CLIs
    codex                  codex-cli 0.128.0
    claude                 2.1.x (Claude Code)
```

| 参数 | 说明 |
|---|---|
| `-c, --config <path>` | 检查指定配置文件的状态 |

---

### `crosscheck diagnose`

读取 `~/.crosscheck/logs/`，找出失败模式、审查者表现和改进建议。

```bash
crosscheck diagnose
crosscheck diagnose --since 2026-05-01
crosscheck diagnose --json
```

```
crosscheck diagnose

  Period   2026-05-07 → 2026-05-08  (1 log file)

  Reviews
    total       6
    successful  3
    failed      3  (50% failure rate)

  Reviewer performance
    codex    1/4 success  25%
    claude   2/2 success  100%

  Verdict distribution
    APPROVE     2  (67%)
    NEEDS WORK  1  (33%)
    BLOCK       0  (0%)

  Error patterns
    ✗ command not found: tsc                    ×2  (codex)
    ✗ base branch missing: staging              ×2

  Languages detected
    typescript, nodejs

  Suggestions
    → tsc: command not found ×2 (codex)
      add to workflow.yml review step instructions: "Do not run tsc, ts-node, or tsx."
    → base branch 'staging' not found ×2 — verify branch is fetched before review

  Run `crosscheck optimize` to apply suggestions automatically.
```

| 参数 | 说明 |
|---|---|
| `--json` | 以 JSON 格式输出完整报告（用于脚本或传给 `optimize`） |
| `--since <YYYY-MM-DD>` | 只分析该日期之后的日志 |

---

### `crosscheck optimize`

内部运行 `diagnose`，选择最优 AI Agent，为 `~/.crosscheck/workflow.yml` 中的 review 步骤生成改进指令。默认为预览模式（只显示 diff，不写入文件）。

```bash
crosscheck optimize             # 仅显示 diff
crosscheck optimize --apply     # 应用更改
crosscheck optimize --agent codex --apply
```

```
  Running diagnose...
  agent    claude  (default — both enabled, no data)

  diff  /Users/you/.crosscheck/workflow.yml (review step)

  +## Constraints
  +
  +- Do not run tsc, ts-node, or tsx.
  +- Do not run npm, npx, yarn, or pnpm.
  ...

  Run with --apply to write changes to /Users/you/.crosscheck/workflow.yml (review step)
```

**`optimize` 使用哪个 Agent？**

`optimize` 根据你的配置和日志历史自动选择：

1. 只启用了一个供应商 → 使用该供应商。
2. 两个都启用 → 使用近期日志中成功率更高的那个。
3. 成功率相同或没有日志数据 → 默认使用 `claude`。
4. `--agent claude|codex` 覆盖以上所有逻辑。

| 参数 | 说明 |
|---|---|
| `--apply` | 将改进指令写入 `~/.crosscheck/workflow.yml` 中的 review 步骤（默认为预览模式） |
| `--dry-run` | 显示 diff 不写入（默认行为，显式别名） |
| `--agent <claude\|codex>` | 强制使用指定 Agent，忽略配置和日志数据 |
| `--since <YYYY-MM-DD>` | 限制作为输入的 diagnose 时间窗口 |
| `-c, --config <path>` | 配置文件路径 |

---

### `crosscheck impact`

报告审查历史带来的累计价值：节省的时间、发现的问题和代码质量趋势。读取 `~/.crosscheck/logs/`，无网络请求。

```bash
crosscheck impact
crosscheck impact --money
crosscheck impact --since 2026-01-01
crosscheck impact --json
```

```
crosscheck impact  (all time · 47 reviews)

  Time saved
  ──────────────────────────────────────────────
  Reviews run              47
  Avg AI review time       ~14 min
  Assumed human time       60 min  ⓘ
  Total time saved         ~43 h

  Issues caught
  ──────────────────────────────────────────────
  APPROVE              28   (60%)
  NEEDS WORK           14   (30%)  ← actionable feedback
  BLOCK                 5   (11%)  ← potential bugs / breaking changes
  Total issues caught  19

  Code quality trend  (BLOCK rate, weekly)
  ──────────────────────────────────────────────
  May W1    ████████████████  22%
  May W2    ████████████      17%
  May W3    ████████          11%   ↓ improving

  ⓘ assumes 60 min avg human review — set impact.assumed_human_review_minutes to adjust
  Run crosscheck impact --money for a rough monetary estimate.
```

| 参数 | 说明 |
|---|---|
| `--money` | 追加基于 `impact.hourly_rate_usd` 和 `impact.defect_cost_usd` 的货币估算 |
| `--since <YYYY-MM-DD>` | 只分析该日期之后的日志 |
| `--json` | 以 JSON 格式输出完整报告 |
| `-c, --config <path>` | 配置文件路径 |

货币估算公式：`(hours_saved × hourly_rate_usd) + (issues_caught × defect_cost_usd)`。默认值：`$150/hr`、`$150/issue`，均可在 `crosscheck.config.yml` 的 `impact` 节点中配置。

---

### `crosscheck issue`

读取近期错误日志，由你最优 AI Agent 起草 GitHub Issue，询问三个简短跟进问题，确认后提交到 `humanbased-ai/crosscheck`。无需手动翻日志或手写 Issue。

```bash
crosscheck issue               # 交互式 — 提交前确认草稿
crosscheck issue --dry-run     # 只打印草稿，不提交
crosscheck issue --yes         # 展示草稿后立即提交
crosscheck issue --since 2026-05-01
```

```
crosscheck issue

  Scanning logs (last 3 days)...
  Found error pattern: command_not_found: tsc  ×4  (codex)

  Can you reproduce this consistently?
    [1] Every time  [2] Sometimes  [3] Happened once
  Choice [1]: 1

  Which command triggered this?
    [1] watch  [2] serve  [3] review  [4] Unknown
  Choice [1]: 1

  Is this blocking you?
    [1] Blocked  [2] Degraded  [3] Cosmetic
  Choice [2]: 2

  Draft issue:
  ────────────────────────────────────────────────────────
  TITLE: codex: command not found: tsc during review in temp clone
  ...

  Submit to humanbased-ai/crosscheck? [y/N]: y
  ✓ https://github.com/humanbased-ai/crosscheck/issues/99
```

近期日志中若无错误，crosscheck 打印 `No errors found in recent logs — nothing to report` 并正常退出。

| 参数 | 说明 |
|---|---|
| `--since <YYYY-MM-DD>` | 将日志扫描限制在该日期之后（默认：最近 3 天） |
| `--dry-run` | 打印草稿但不提交 |
| `-y, --yes` | 展示草稿后立即提交（跳过确认） |
| `-c, --config <path>` | 配置文件路径 |

---

## 自定义根目录

`~/.crosscheck/` 是 crosscheck 所有学习成果和配置的持久化目录。迁移机器前备份该目录，重装后运行 `crosscheck onboard` 并一路回车确认即可恢复所有设置。

### `~/.crosscheck/` 中的文件

| 文件 | 由谁写入 | 由谁读取 | 用途 |
|---|---|---|---|
| `config.yml` | `onboard`、`init`、`watch`/`serve`（首次运行） | 所有命令 | 主配置——部署、仓库、模式、供应商、质量、隧道、路由、预算 |
| `workflow.yml` | `onboard`（仅首次） | `watch`、`serve`、`run` | 带有每步内联指令的全局流水线。首次 onboard 时写入；之后不会覆盖——可自由编辑 |
| `webhook-secret` | 首次使用时自动生成 | `watch`、`serve` | GitHub Webhook 签名验证的 HMAC Secret，重启后自动复用 |
| `logs/YYYY-MM-DD.ndjson` | `watch`、`serve` | `diagnose`、`optimize`、`impact`、`issue` | 结构化审查事件日志，每天一个文件 |

### 项目级覆盖（优先于全局文件）

| 文件 | 由谁读取 | 用途 |
|---|---|---|
| `.crosscheck/workflow.yml` *（仓库内）* | `watch`、`serve`、`run` | 项目级流水线——优先于 `~/.crosscheck/workflow.yml` |
| `.crosscheck/AGENT.md` *（仓库内）* | `optimize` | 项目级 Harness——优先于内置 `AGENT.md` |
| `AGENT.md` *（随 crosscheck 内置）* | `optimize` | 默认 Harness——随包附带，始终作为回退 |

### `crosscheck onboard` 负责的内容 vs 保留的内容

重新运行时，`onboard` 只更新它收集了答案的字段，其他内容保持不变。

**每次运行都会更新：** `deployment`、`orgs`、`repos`、`mode`、`vendors.*.enabled`、`vendors.*.effort`、`quality.tier`、`tunnel.*`、`post_review.auto_fix.*`

**首次运行初始化，之后不覆盖：** `routing.allowed_authors`、`routing.author_routes`、`routing.fallback_reviewer`

**onboard 从不修改：** `quality.focus`、`quality.custom_prompt`、`budget.*`、`branding.*`、`server.*`、`logs.*`、`backtrace.*`、`workflow.yml`（首次写入后）、Harness 文件

---

## 配置

crosscheck 默认将配置存储在 `~/.crosscheck/config.yml`——跨项目持久化，无需每个仓库都有配置文件。也会在以下位置查找（找到第一个为止）：

1. `~/.crosscheck/config.yml` ← **默认位置**
2. `./crosscheck.config.yml`
3. `./.crosscheck.yml`

运行 `crosscheck init` 生成带完整注释的 `~/.crosscheck/config.yml`。

日志写入 `~/.crosscheck/logs/YYYY-MM-DD.ndjson`，默认保留 30 天。

### 完整配置参考

```yaml
# ── 部署 ──────────────────────────────────────────────────────────────────────
# 首次运行时自动设置。通过以下命令重新运行提示：crosscheck watch --reconfigure
# personal — 监控你的仓库 + 所属 Org；只审查你提交的 PR
# team     — 只监控 Org 仓库；审查所有人提交的 PR
# deployment: personal

# ── 模式 ──────────────────────────────────────────────────────────────────────
# single-vendor: 由一个 AI 审查所有 PR
# cross-vendor:  Claude ↔ Codex 互相审查
mode: cross-vendor

# ── 供应商 ───────────────────────────────────────────────────────────────────
vendors:
  codex:
    enabled: true
    auth: subscription      # subscription | api-key
    model: gpt-5.6-terra    # 仅在 auth: api-key 时生效
    # timeout_sec: 1200     # 单次 CLI 调用最大秒数；不设 = 按 tier（300/600/1200）

  claude:
    enabled: true
    model: sonnet           # haiku | sonnet | opus
    effort: medium          # low | medium | high | max
    # timeout_sec: 1200     # 单次 CLI 调用最大秒数；不设 = 180。大 PR 可调高。

# ── 质量 ───────────────────────────────────────────────────────────────────
quality:
  tier: balanced            # fast | balanced | thorough
  focus:                    # 收窄审查范围（可选）
    - security
    - types
    - performance
  custom_prompt: |          # 追加到每次审查提示词末尾
    Be concise. Flag only issues that would block a merge.

# ── 预算 ────────────────────────────────────────────────────────────────────
budget:
  codex_monthly_usd: 20     # null = 不限；仅在 auth: api-key 时生效
  per_review_usd: 2.00      # 传给 claude --max-budget-usd

# ── Org — 一个 Webhook 覆盖 Org 下所有仓库 ──────────────────────────────────
orgs:
  - humanbased-ai
  - codatta

# ── Users — 监控个人 GitHub 账号下的所有仓库（非 Org）──────────────────────
# 启动时 crosscheck 枚举每个用户的仓库并注册 Webhook。
# 与 `orgs` 和 `repos` 可叠加，所有来源均生效。
users:
  - beingzy           # 你的个人账号
  # - my-agent-login  # 向自己仓库推送的 bot 账号

# ── Repo — 只监控指定仓库 ────────────────────────────────────────────────────
# 使用 `orgs`/`users` 时可省略。三者都为空时，从 git remote 自动检测。
repos:
  - owner: acme
    name: specific-repo

# ── 路由 ───────────────────────────────────────────────────────────────────
routing:
  # 来源检测使用四信号链：
  #   1. PR 正文模式（最快）
  #   2. Commit 消息中的 Co-Authored-By: trailer（API 调用，失败不影响流程）
  #   3. 分支前缀（claude/ 或 codex/）
  #   4. author_routes 配置回退（最后手段）
  codex_reviews_patterns:
    - "Generated with \\[Claude Code\\]"    # Claude Code 归因页脚
    - "Co-Authored-By: Claude"              # commit trailer
  claude_reviews_patterns:
    - "Generated with \\[OpenAI Codex\\]"   # Codex 归因页脚
    - "Co-Authored-By: codex"               # commit trailer

  # 分支前缀检测（信号 3）。Claude Code 使用 claude/，Codex 使用 codex/。
  claude_branch_prefixes:
    - "claude/"
  codex_branch_prefixes:
    - "codex/"

  # 将审查限制为这些 GitHub 账号提交的 PR。
  # 由 `crosscheck init` 或首次运行 `crosscheck watch` 时自动从 gh auth 检测并填入。
  # 为空 = 不限制（所有匹配的 PR 都会被审查）。
  allowed_authors:
    - your-github-login  # 从 gh auth 自动检测

  # 基于作者的路由回退（信号 4）——当无模式或前缀匹配时使用。
  author_routes:
    your-github-login: claude   # 你提交的 PR → 视为 Claude 所作 → Codex 审查

# ── 隧道（仅 watch 模式）──────────────────────────────────────────────────
# localhost.run（默认）—— SSH 隧道，零安装，重连后 URL 会变化。
# smee —— 通过 smee.io 中继；离线时事件排队。
#   设置：npm install -g smee-client，访问 https://smee.io/new
tunnel:
  backend: localhost.run
  # backend: smee
  # smee_channel: https://smee.io/your-channel-id

# ── Impact 报告 ──────────────────────────────────────────────────────────────
impact:
  assumed_human_review_minutes: 60   # 节省时间计算的基准
  hourly_rate_usd: 150               # 用于 --money 估算
  defect_cost_usd: 150               # 每个发现的问题，用于 --money 估算

# ── 审查后自动修复 ────────────────────────────────────────────────────────────
# 控制修复的交付方式。步骤排序（哪些步骤运行、何时运行、使用哪个供应商）
# 在 ~/.crosscheck/workflow.yml 中配置。
post_review:
  auto_fix:
    delivery:
      mode: pull_request      # pull_request | commit | comment
      # pull_request → 修复 PR 针对原始分支；人工审批后合并
      # commit       → 直接将修复推送到原始 PR 分支
      # comment      → 仅将建议修复作为审查评论发布
      pr_title: "fix: address CR issues in #{original_pr_title}"
      label: cr-autofix       # 应用于修复 PR 的 GitHub 标签

# ── 回溯审查 ──────────────────────────────────────────────────────────────────
# 启动时扫描监控范围内所有开放的 PR，对尚未收到 [crosscheck] 评论的 PR 进行审查。
# 默认关闭。启用方式：
#   backtrace.enabled: true  （持久——每次启动都运行）
#   --backtrace 参数         （仅本次会话）
#   --no-backtrace 参数      （即使 enabled: true 也抑制）
# backtrace:
#   enabled: true

# ── 服务器 ────────────────────────────────────────────────────────────────────
server:
  port: 7891
  webhook_path: /webhook
```

### 质量层级

| 层级 | 速度 | 深度 | 适合场景 |
|---|---|---|---|
| `fast` | ~10s | 仅核心问题 | 高频仓库、草稿 PR |
| `balanced` | ~30s | 完整审查，解释所有问题 | 大多数团队的默认选择 |
| `thorough` | ~60–90s | 深度多轮，架构 + 安全 | 合并到 main 之前 |

### 路由模式

模式对 PR 正文进行大小写不敏感的正则表达式匹配。

- `codex_reviews_patterns` — 匹配这些模式的 PR 由 Codex 审查
- `claude_reviews_patterns` — 匹配这些模式的 PR 由 Claude 审查

如需同时审查人工提交的 PR，添加通配符：

```yaml
routing:
  codex_reviews_patterns:
    - "Generated with \\[Claude Code\\]"
    - ".*"    # Codex 审查所有 PR
```

### 最简配置

```yaml
mode: cross-vendor
```

其他所有选项使用默认值。

---

## 工作原理

```
GitHub 仓库
    │  pull_request 事件（opened / synchronize）
    ▼
crosscheck webhook 服务器
    │
    ├─ 验证 HMAC-SHA256 签名
    ├─ 从 PR 正文模式检测来源
    ├─ 分配审查者（cross-vendor 模式下为对立供应商）
    │
    ▼
将 PR 分支克隆到临时目录
    │
    ├─ codex review --base <branch>       ← 非交互式 Codex 审查
    │  或
    └─ claude --print --bare ...          ← 非交互式 Claude 审查
            │
            ▼
    通过 GitHub API 在 PR 中发布评论
    删除临时克隆
            │
            ▼  post_review.auto_fix（如已启用且发现问题）
    原作者 Agent 读取审查评论
            │
    ├─ claude --print ...  （Claude 提交了该 PR）
    │  或
    └─ codex ...           （Codex 提交了该 PR）
            │
            ▼
    打开修复 PR → fix/cr-<pr-number>-review-issues → 原始分支
    （你审查并合并修复 PR；原始 PR 自动更新）
```

### PR 来源检测

crosscheck 使用四信号链确定 PR 是否由 Claude Code、Codex 或人工提交：

1. **PR 正文** — 查找归因页脚（如 `Generated with [Claude Code]`）
2. **Commit 消息** — 扫描所有 commit 消息中的 `Co-Authored-By:` trailer
3. **分支前缀** — `claude/` → Claude 来源；`codex/` → Codex 来源
4. **`author_routes`** — 配置中按登录名的回退

都不匹配时，来源为 `human`，cross-vendor 模式下跳过该 PR。

| 默认模式 | 匹配对象 |
|---|---|
| `Generated with \[Claude Code\]` | Claude Code 提交的 PR |
| `Generated with \[OpenAI Codex\]` | Codex CLI 提交的 PR |
| `Co-Authored-By: Claude` | Claude Code 的 commit trailer |
| `Co-Authored-By: codex` | Codex 的 commit trailer |
| 分支前缀 `claude/` | Claude 提交 PR 的命名约定 |
| 分支前缀 `codex/` | Codex 提交 PR 的命名约定 |

### 审查者分配

| 模式 | PR 来源 | 审查者 |
|---|---|---|
| `cross-vendor` | claude | Codex |
| `cross-vendor` | codex | Claude |
| `cross-vendor` | 人工 | 无 — 跳过 |
| `single-vendor` | 任意 | 第一个启用的供应商 |

### Codex 审查如何运行

```bash
codex review --base <base-branch> --title "<pr-title>"
```

`--base` 标志将当前 HEAD 与基础分支进行差异比较——与 PR diff 完全一致。使用 `auth: subscription` 时不传入模型参数。使用 `auth: api-key` 时，模型由质量层级决定（`fast` → `gpt-5.6-luna`，`balanced` → `gpt-5.6-terra`，`thorough` → `gpt-5.6-sol`）。

### Claude 审查如何运行

```bash
claude \
  --print --bare \
  --model claude-sonnet-5 \
  --effort medium \
  --max-budget-usd 2.00 \
  --output-last-message /tmp/review.md \
  --allowedTools "Bash(git diff),Bash(git log)" \
  "<prompt>"
```

`--bare` 使执行快速且确定性。`--allowedTools` 将 Claude 限制为只能在克隆的仓库上执行只读的 git 操作。

### 去重

GitHub 可能对同一次推送同时触发 `opened` 和 `synchronize` 事件。crosscheck 在内存中追踪 `owner/repo#pr@sha`，丢弃同一 commit 的重复事件。

### Watch vs Serve

| | `watch` | `serve` [BETA] |
|---|---|---|
| 隧道 | `localhost.run`（SSH，无需安装） | 无 — 直连端口 |
| Webhook | 自动管理，退出时清理 | 手动，永久有效 |
| 覆盖范围 | Org 级或 Repo 级 | Org 级或 Repo 级 |
| 目标机器 | 开发者笔记本 | mac-mini / 服务器 |
| 生命周期 | 与终端绑定 | Daemon / 服务 |

### 安全性

- **Webhook 签名** — 每个请求在解析前用 HMAC-SHA256 验证
- **临时隔离** — 每个 PR 克隆到独立临时目录，审查后删除
- **只读工具** — Claude 仅限使用 `git diff` 和 `git log`
- **不在克隆中存储凭证** — `gh repo clone` 使用 gh credential helper，不将 Token 写入磁盘

---

## 审查后自动修复

当 `post_review.auto_fix.enabled` 为 `true`（默认值）时，crosscheck 在每次发现问题的审查后自动完成完整闭环：

```
Agent 打开 PR #42  →  对立 AI 审查  →  发现问题？
                                            │ 是
                               原作者 Agent 生成修复
                                            │
                          修复 PR #43 打开 → feat/my-feature
                                            │
                          你审查并合并 PR #43
                                            │
                          PR #42 更新 → 你合并到 main
```

**关键设计决策：**

| 设置 | 默认值 | 原因 |
|---|---|---|
| `fixer: same-as-author` | 提交 PR 的供应商也负责修复 | 原作者 Agent 最了解自己的代码和风格 |
| `delivery: pull_request` | 新建 PR，不直接推送 | 你始终在环——不经你审批不会有代码落地 |
| `trigger: on_issues` | 只在审查者发现警告或更严重问题时触发 | 干净的 PR 跳过修复步骤 |
| `min_severity: warning` | 忽略 info/仅样式的发现 | 避免为纯样式评论产生噪声修复 PR |

**修复 PR 分支命名：** `fix/cr-<原始 PR 编号>-review-issues`

**原始 PR 编号永不改变。** 修复 PR 针对原始分支；合并后，其 commit 自动出现在原始 PR 中。

**禁用：** 在配置中设置 `post_review.auto_fix.enabled: false`，或设置 `trigger: never`。

---

## 常见问题

### crosscheck 如何随时间自我改进？

每次审查（成功或失败）都会追加到 `~/.crosscheck/logs/YYYY-MM-DD.ndjson`。运行 `crosscheck diagnose` 读取这些日志，找出规律：哪些命令失败了，哪个审查者表现不佳，哪些语言特定工具缺失。运行 `crosscheck optimize` 将该报告输入给表现最好的 AI Agent（由内置 `AGENT.md` 指导），并更新 `~/.crosscheck/workflow.yml` 中 review 步骤的 `instructions` 字段。改进在下一个 PR 即时生效。

### `crosscheck optimize` 使用哪个 Agent？

自动选择：
1. 配置中只启用了一个供应商 → 使用该供应商。
2. 两个都启用 → 使用近期日志中成功率更高的那个。
3. 成功率相同或没有数据 → 默认使用 `claude`。
4. 随时可以覆盖：`crosscheck optimize --agent codex`。

`optimize` 使用的 Agent 与审查你的 PR 的 Agent 相互独立——`optimize` 的目的是改进指令，而不是审查代码。

### 如何自定义审查者行为？

主要入口是 workflow 文件。每个步骤都有一个 `instructions` 字段，会逐字传递给审查者或修复 Agent：

```yaml
# .crosscheck/workflow.yml
steps:
  - name: review
    type: review
    reviewer: auto
    instructions: |
      Do not suggest TypeScript patterns — this is a Rust project.
      Focus on memory safety and error handling.
      ## Verdict
      End with: VERDICT: APPROVE | NEEDS_WORK | BLOCK
  - name: fix
    type: fix
    reviewer: origin
    when: "review.verdict != 'APPROVE'"
    instructions: "Only fix issues explicitly called out. Do not refactor unrelated code."
```

`crosscheck optimize --apply` 会更新 `~/.crosscheck/workflow.yml` 中 review 步骤的 `instructions` 字段，将学到的改进持久化到后续会话。

要将 review 步骤指令重置为默认值，删除 `~/.crosscheck/workflow.yml` 并重新运行 `crosscheck onboard`——它会用内置默认值重新生成该文件。

### 可以设置项目级工作流吗？

可以。在仓库根目录创建 `.crosscheck/workflow.yml`。crosscheck 会自动加载它，并以其替代内置默认流水线。这是自定义审查者行为的推荐方式——所有项目级设置都集中在一个受版本控制的文件中。

### `AGENT.md` 是什么？

`AGENT.md` 是指导 AI 在 `crosscheck optimize` 期间工作的 Harness 文档，定义了输入/输出约定、语言检测规则、约束编写指南和质量原则。随 crosscheck 捆绑提供，使 `optimize` 开箱即用。

你可以在项目根目录或 `.crosscheck/AGENT.md` 放置本地覆盖文件。crosscheck 优先查找本地覆盖，然后回退到内置版本。这允许团队针对自己的技术栈或规范自定义优化逻辑。

### 为什么审查失败，提示 "command not found"？

审查者（codex 或 claude）尝试运行一个在临时克隆中不存在的 CLI 工具（例如 `tsc`、`pytest`）。克隆是浅层 `git` checkout，没有 `node_modules` 或其他已安装的依赖。运行 `crosscheck diagnose` 查看哪些命令失败了，然后运行 `crosscheck optimize --apply` 在 `~/.crosscheck/workflow.yml` 的 review 步骤中添加相应约束，让审查者停止尝试这些命令。

### 为什么审查失败，提示 "no such branch"？

crosscheck 在临时克隆中获取 PR 基础分支（例如 `staging`）后再运行审查者。如果获取失败（网络问题、分支已删除、Token 权限不足），审查者无法正确进行差异比较。检查：
- 基础分支存在且可以用你的 Token 访问。
- `GITHUB_TOKEN` 拥有 `repo` 权限。
- PR 中的分支名与远程一致。

### 如何用 smee.io 代替 localhost.run？

`localhost.run`（默认）在你的笔记本离线时 GitHub 触发 Webhook 的事件会丢失。[smee.io](https://smee.io) 会将事件排队，等笔记本重新联网后重放——适合审查机器不总是在线的情况。

```bash
npm install -g smee-client
```

访问 [smee.io/new](https://smee.io/new) 并复制 Channel URL。然后在 `~/.crosscheck/config.yml` 中：

```yaml
tunnel:
  backend: smee
  smee_channel: https://smee.io/your-channel-id
```

crosscheck 会在首次 `watch` 启动时自动将 smee Channel URL 注册为 GitHub Webhook，无需手动注册。与 `localhost.run` 不同，重启后无需重新注册，离线期间的事件会在重连后重放。

### 可以禁用自动修复步骤吗？

可以。在配置中设置 `post_review.auto_fix.enabled: false`，或设置 `trigger: never`。也可以将 `min_severity` 提高到 `error`，将修复限制为仅阻塞性问题。

如需不经单独 PR 直接推送修复（跳过你的审查），切换到 `delivery: commit`。如需以审查评论形式获取建议修复而不推送任何代码，使用 `delivery: comment`。

### 为什么修复者使用与提交 PR 相同的供应商？

原作者 Agent 对自己的代码拥有最多上下文——包括原始改动背后的风格、约束和意图。使用 `fixer: same-as-author` 让反馈闭环保持紧凑：Agent 编写代码，另一个 Agent 审查，原 Agent 修复。如果你偏好其他安排，可以覆盖为 `same-as-reviewer`、`codex` 或 `claude`。

### optimize 会自动运行吗？

不会——`crosscheck optimize` 始终由用户手动触发。你在需要改进指令时才运行它，没有后台守护进程或定时任务。未来版本可能会增加可选的 `--schedule` 模式，但默认值将始终是手动触发，以保持你对 `~/.crosscheck/workflow.yml` 写入内容的掌控。
