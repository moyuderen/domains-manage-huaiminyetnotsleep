# 性能优化：首屏 JS 体积与请求链路

## Goal

在不改变现有功能与视觉的前提下：

1. 降低域名、账号、站点、看板页面的首屏 JS 体积。
2. 减少保存与关键字搜索链路上的串行数据库往返。
3. 修正两处影响流畅度的列表交互细节。

本任务基于一次全量性能审计（证据与基线数字见 `research/perf-audit.md`），按“首屏 JS → 请求链路 → 交互细节”三个批次推进。每个批次由开发者实现、验收者验收；全部批次通过后，由总验收者做全量回归。

## 角色与流程

| 角色 | 职责 | 能否改源码 |
| --- | --- | --- |
| 开发者 | 按 PRD 实现优化并自检（lint、类型、测试、沙箱构建、体积测量、UI 冒烟），如实汇报 | 能 |
| 验收者 | 验收“改动是否符合 PRD”：静态检查、体积测量、沙箱 UI 冒烟并与基线对比 | 不能，只能新增或修改 `research/` 下的验收脚本与产物 |
| 总验收者 | 验收全部改动，并保证原有功能不受影响：全量回归、规范符合性、改动范围 | 不能 |

- 任何角色都不得执行 `git commit`、`git push`、`git stash`、`git checkout`、`git reset`，不得切换分支。
- 验收环境的搭建方式、端口分配和禁用事项见 `research/verification-env.md`。在仓库目录里直接跑 `next dev` 或 `next build` 会干扰仓库主人正在运行的服务，禁止这样做。

## 基线（提交 97d8af4，生产构建，gzip）

| 路由 | 首屏 JS | 其中仅该路由加载 |
| --- | --- | --- |
| `/domains` | 259.0 KB | 166.9 KB |
| `/dashboard` | 252.0 KB | 169.3 KB |
| `/sites` | 195.7 KB | 113.1 KB |
| `/accounts` | 190.3 KB | 98.2 KB |
| `/accounts/[accountId]` | 187.6 KB | 95.6 KB |
| `/domains/[domainId]` | 172.1 KB | 88.8 KB |
| `/logs` | 104.3 KB | 12.2 KB |
| `/settings` | 103.0 KB | 20.3 KB |
| `/job-runs` | 102.9 KB | 19.7 KB |
| `/login` | 76.5 KB | 42.4 KB |

三个结构性问题：

- zod + react-hook-form（未压缩 312 KB / 75 KB gzip）在 `/domains`、`/sites`、`/accounts` 和两个详情页的入口 chunk 里各有一份，五个文件字节数完全相同。
- `/domains` 的入口 chunk 里混进了 `@supabase/supabase-js`（约 92 KB 未压缩 / 23 KB gzip）和日期选择器（约 35 KB gzip）。
- `/dashboard` 的入口 chunk 里 framer-motion 约 108 KB 未压缩 / 35 KB gzip，只用于卡片入场动画。

现有测试：3 个文件、18 个用例，全部通过。

## 批次 A：减小首屏 JS

### A1 服务端数据模块不得进入客户端 bundle

**现象**：`components/domains/domain-cells.tsx:2` 与 `components/domains/DomainDetailsDialog.tsx:8` 都从 `lib/data/accounts.ts` 引入纯函数 `resolveAccountDisplay`，而这两个模块会被打进浏览器代码。`lib/data/accounts.ts` 没有 `server-only`，顶层执行了 `unstable_cache(...)`，还 import 了 `createSupabaseAdminClient`。结果 `/domains` 的入口 chunk 里出现了 `@supabase/supabase-js`、`next/cache` 和 `SUPABASE_SERVICE_ROLE_KEY` 字样。

**要求**：

1. 把 `AccountLookup` 类型、`buildAccountLookup`、`resolveAccountDisplay` 迁出 `lib/data/accounts.ts`，放进一个不依赖 `next/cache`、`@supabase/*`、zod 的纯模块。放在哪里遵循 `.trellis/spec/frontend/directory-structure.md`。所有引用方改为从新模块导入，`lib/data/accounts.ts` 不保留转发导出。
2. 给 `lib/data/accounts.ts`、`lib/data/sites.ts`、`lib/data/activity-logs.ts`、`lib/data/dashboard.ts` 补上 `import 'server-only'`。
3. 行为不变：域名表格、卡片、详情里账号列的显示、高亮和“绑定邮箱”提示保持一致。

**验收点**：

- 生产构建的 `static/chunks` 中，没有任何 chunk 含 `supabase-js`、`GoTrueClient`、`PostgrestClient`、`unstable_cache`、`SUPABASE_SERVICE_ROLE_KEY`。
- `/domains` 首屏 JS 比基线至少少 20 KB gzip。

### A2 看板入场动画改用 CSS

**现象**：`components/dashboard/StatsCards.tsx` 和 `components/dashboard/AccountCharts.tsx` 只用 `motion.div` 做一次性“淡入 + 上移”。

**要求**：

1. 用 `app/globals.css` 里的 `@keyframes` 加 Tailwind v4 的 `--animate-*` theme 变量（或等价的 utility）实现同样的效果：透明度 0 → 1，`translateY` 从 12px 到 0（风险卡片为 8px），时长和缓动接近现状，逐张卡片延迟 50ms。
2. 保留现有 DOM 语义：`StatsCards` 中带链接的卡片最外层仍是 `<a>`。`__tests__/components/dashboard/stats-cards.test.tsx` 必须继续通过。
3. 不改 `package.json` 和 lockfile。
4. 不顺手调整卡片的其他样式。

**验收点**：

- 三个标签页的统计卡片和账户风险卡片入场动画可见，无布局跳动。
- `/dashboard` 首屏 JS 比基线至少少 25 KB gzip，产物中不再出现 framer-motion 的特征字符串。

### A3 表单弹窗按需加载

**现象**：`DomainFormDialog`（内含账号/站点快捷新建和日期选择器）、`AccountFormDialog`、`SiteFormDialog`、`SubdomainFormDialog` 都是静态 import，弹窗关着也会随列表页下载。

**要求**：

1. 这四类表单弹窗改为首次打开时才挂载（`next/dynamic` 加 `ssr: false`）。挂载后保持挂载，保证关闭动画、焦点归还和重复打开时的表单重置行为不变。
2. 空闲预加载可选，且不得抢占首屏网络；如果做不到，保留仅首次打开时加载。
3. 抽成一个共享的小 helper（hook 或组件），不要在多个调用点各写一份。
4. `isEmail` 和 `EMAIL_REGEX` 从 `schemas/accountSchemas.ts` 迁到一个不引入 zod 的小模块，所有引用方改为从新模块导入。
5. 行为必须保持：新增、编辑、复制三种模式的回填与校验；域名表单内嵌的账号/站点快捷新建；输入型弹窗禁止点遮罩关闭；提交成功后的提示与刷新；失败时的错误提示。

**验收点**：

- `/domains`、`/accounts`、`/sites`、`/accounts/[accountId]`、`/domains/[domainId]` 的入口 chunk 不再包含 zod、react-hook-form、react-day-picker，它们只出现在按需 chunk 中。
- 首屏 JS：`/domains` 比基线少至少 90 KB gzip；`/accounts` 和 `/sites` 各少至少 60 KB gzip。
- 沙箱冒烟：每个弹窗打开后渲染正确、可关闭、可重复打开，控制台无报错。

## 批次 B：减少请求往返

### B1 日志汇总去掉一次冗余查询

**现象**：`lib/data/activity-logs.ts` 的 `getActivityLogSummary` 并发 4 个 `count` 请求，其中 `total` 恒等于 `auth + changes`（`category` 非空，只有 `auth` 与非 `auth` 两类）。

**要求**：去掉 `total` 的查询，改为 `auth + changes`，返回结构不变。不加缓存。

**验收点**：日志页顶部四个数字与改动前一致；该函数的请求数从 4 降到 3。

### B2 仅用于写操作日志的查询移出响应路径

**现象**：下面这些查询在 action 返回前执行，但结果只用于生成操作日志的变更明细。

- `app/actions/domains.ts` `updateDomainAction`：`getAccountsByIds` 和 `getSitesByIds`。保存域名现在是 4 次串行往返（查旧记录 → 查账号/站点 → 更新 → 补账号站点关系）。
- `app/actions/accounts.ts` `updateAccountAction`：`getAccountById`、`getSitesByIds`，共 4 次串行往返。
- `app/actions/sites.ts` `updateSiteAction`：`getSiteById`，共 2 次串行往返。
- `deleteAccountAction`、`deleteSiteAction`：`getAccountById` / `getSiteById` 只用于日志里的资源名兜底。

**要求**：

1. 仅把不依赖写前状态的名称补全和明细格式化移到 `after()`；域名更新的账号/站点名称与账号更新的站点名称属于这一类。
2. `requireAccess()`、Zod 校验、写库、`ensureAccountSiteRelations`、失效调用和所有更新/删除前的旧记录读取均保留原有顺序。不能在写后重新读取旧值；站点路径没有可独立移动的查询则保持原状。
3. 名称补全失败时按原明细的 ID 兜底继续写日志，不阻止业务写入；保留旧值、新值、事件及失效契约。

**验收点**：

- 单测或走查确认写前快照仍在写前读取，日志查名称不再阻塞域名/账号保存，回调失败有兜底。
- 原有关联维护、受影响路由和缓存失效保持不变；不把代码预计减少的往返换算成未经测量的线上延迟。

### B3 域名关键字搜索从两跳降为一跳，并修正过滤串转义

**现象**：`lib/data/domains.ts` 的 `getDomains` 在有 `keyword` 时，先查 `sites`、`accounts` 两张表拿匹配 id，再查 `domains`，两个阶段串行。另外 `name.ilike.%${keyword}%` 没有转义就拼进 `.or()`，关键字含逗号、括号或引号时过滤条件会被拆坏。

**要求**：

只有能验证数据库 `ILIKE` 的大小写、通配符、标点和大结果集语义均保持时，才用缓存取代前置查询。不引入 SQL 迁移，也不用近似匹配换速度；在当前隔离环境无法保证等价时，保留现有查询和 mock 路径，并在结果中说明。这一可选项未实现不阻断其他优化。

## 批次 C：交互细节

### C1 账号列表：数据改为派生，取消时不刷新

**现象**：

- `components/accounts/AccountsPageClient.tsx:67` 把 `paginatedAccounts.items` 复制进 `useState`，再用 effect 同步（`:84-86`）。每次筛选或翻页会先渲染一帧旧列表，再多渲染一次。
- 同文件 `:433-437`，账号表单关闭时无论保存还是取消都会调用 `router.refresh()`。`components/accounts/AccountDetailsPage.tsx:197-201` 也是如此。

**要求**：

1. 列表数据直接由 `paginatedAccounts.items` 派生。本地只保留按账号 id 的乐观覆盖（启停开关、站点管理两处），并在服务端数据变化时清掉对应覆盖，保证乐观更新和失败回滚的表现与现在一致。
2. 让 `AccountFormDialog` 能区分“保存成功”和“取消或直接关闭”。目前更新成功与取消都是无参的 `onClose()`。列表页和详情页只在保存成功后调用 `router.refresh()`。`DomainFormDialog` 内嵌的 `AccountFormDialog` 用法要保持可用。
3. 不改表单校验、提示文案和提交逻辑。

**验收点**：

- 筛选或翻页后首帧就是新数据，不再出现旧列表闪一帧。
- 启停开关的即时反馈和失败回滚不变。
- 取消表单不触发 `router.refresh()`，保存成功仍然触发。

### C2 桌面表格与移动卡片只保留当前视口的一套

**现象**：`DomainsPageClient`（`:256` 与 `:275`）、`AccountsPageClient`（`:302` 与 `:401`）、`LogsPageClient`（`:244` 与 `:310`）、`JobRunsPageClient`（`:221` 与 `:270`）都把桌面表格和移动卡片两套 DOM 全量渲染，再用 CSS 隐藏其中一套。

**要求**：

1. 首次渲染（服务端渲染和 hydration）保持现状，两套都渲染，避免闪烁和 hydration 不一致。
2. 挂载后根据 `matchMedia('(min-width: 768px)')` 只渲染当前视口对应的那一套，并监听断点变化。
3. 抽成一个共享 hook 放在 `hooks/` 下，四个页面共用。不要改两套布局自身的 JSX 和样式。
4. `SitesPageClient` 已经只挂载当前视图，不改。`SubdomainManager`、`AccountDetailsPage` 里的同类写法本次不改。

**验收点**：

- 桌面和移动两个视口下，hydration 完成后 DOM 里只有一套列表。
- 截图与基线一致，允许动画帧造成的差异。
- 窗口跨断点缩放时切换正常。筛选、翻页、刷新、行内操作不受影响。

## Out of Scope

- 给 `/domains/[domainId]`、`/accounts/[accountId]` 补 `loading.tsx`。经核实，父级的骨架屏已经覆盖子路由。
- 给日志或任务汇总加缓存。涉及 tag 失效时机，且无法在沙箱里验证。
- Vercel 函数区域（部署配置）。
- 按后缀排序时的全量拉取、`created_at` / `updated_at` 索引、`backdrop-blur`。
- 移除 `framer-motion` 依赖或其他依赖调整。
- 任何与上述各项无关的重构或样式调整。

## 总体验收标准

1. `npm run lint` 0 个错误；`npx tsc --noEmit` 通过；`npm test` 通过（原有 18 个用例加新增用例）。
2. 沙箱里的生产构建成功。
3. 各路由首屏 JS 满足上面各项的验收点，汇总成表。
4. 1440×900 和 390×844 两个视口下走完所有页面，控制台没有报错，没有 hydration 错误，关键元素与基线一致。
5. 符合 `.trellis/spec/**`、`.claude/CLAUDE.md` 的质量门槛，server/client 边界清晰。
6. 改动只涉及实现 A1 到 C2 所需的文件和测试，`package.json` 与 lockfile 没有变化。
7. 需要写数据库才能验证的行为（新增、更新、删除成功后的界面、日志写入、通知发送）在沙箱里无法执行，必须在汇报里明确列为“未验证”，不能当作已通过。

## 开发者汇报格式

每个批次完成后按下面的结构汇报，控制在 60 行以内：

```markdown
## 批次 X 实现完成

### 改动文件
- `路径` — 一句话说明

### 实现摘要
逐项说明做了什么，给出关键代码位置（file:line）。

### 自检结果
- lint / 类型 / 测试 / 沙箱构建
- 体积：各路由首屏 JS（与基线对比）
- 冒烟：跑了哪些场景，结果如何

### 与 PRD 的偏差、已知风险、未能验证的点
```
