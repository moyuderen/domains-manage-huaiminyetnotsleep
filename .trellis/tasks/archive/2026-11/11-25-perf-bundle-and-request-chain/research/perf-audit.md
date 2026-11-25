# 性能审计记录

提交 97d8af4 上的全量审计。只记录结论和证据，需求与验收标准见 `../prd.md`。

## 体积问题（批次 A 的依据）

生产构建后，按路由的入口 chunk 做签名串定位和逐字节比较，得到：

| 事实 | 证据 |
| --- | --- |
| zod + react-hook-form 在五个路由的入口 chunk 里各有一份 | `/domains`、`/sites`、`/accounts`、`/accounts/[accountId]`、`/domains/[domainId]` 各有一个 319,972 字节的入口 chunk，字节数完全相同，含 `ZodError`×13、`shouldUnregister`×12。其中 zod 约占 262KB 未压缩，react-hook-form 及 resolver 约 17KB |
| `/domains` 入口 chunk 混入 Supabase 客户端与 `next/cache` | chunk `0eo.u669qiqy6.js`（225,107 字节）中，`GoTrueClient` 等签名集中在 16.8KB 到 104.7KB 区间，约 92KB 未压缩 / 23KB gzip；同一 chunk 含 `unstable_cache`×13、`SUPABASE_SERVICE_ROLE_KEY`×2 |
| 引入链路 | `components/domains/domain-cells.tsx:2`、`components/domains/DomainDetailsDialog.tsx:8` 从 `lib/data/accounts.ts` 导入 `resolveAccountDisplay`。该文件第 1 行 import `unstable_cache`，第 8 行 import `createSupabaseAdminClient`，第 65、357 行在模块顶层调用 `unstable_cache(...)` |
| `/domains` 另带日期选择器 | 同一 chunk 的 118KB 到 200KB 区间为 react-day-picker 与 date-fns，连同日历 UI 约 35KB gzip |
| `/dashboard` 为入场动画加载 framer-motion | chunk `0gmdtor8z~w_a.js`（538KB）中 framer-motion 签名集中在 365KB 到 467KB，约 108KB 未压缩 / 35KB gzip。引用点只有 `components/dashboard/StatsCards.tsx:5` 和 `components/dashboard/AccountCharts.tsx:6` |
| `isEmail` 拖入 zod | `schemas/accountSchemas.ts:13` 的 `isEmail` 是纯正则，但与 `accountSchema` 同文件。`AccountsPageClient`、`AccountCardList`、`lib/data/accounts.ts` 都引用它 |
| `server-only` 标记缺失 | `lib/data/domains.ts`、`settings.ts`、`job-runs.ts`、`notifications.ts` 有；`accounts.ts`、`sites.ts`、`activity-logs.ts`、`dashboard.ts` 没有 |

说明：Supabase service-role 密钥的值不会进客户端产物（Next 只内联 `NEXT_PUBLIC_*`），所以这是体积和模块边界问题，不是密钥泄露。

## 请求链路（批次 B 的依据）

- `lib/data/activity-logs.ts:191-196`：`getActivityLogSummary` 并发 4 个 `count` 请求。`total` 等于 `auth + changes`。
- `app/actions/domains.ts:49-66`：`getDomainById` → `getAccountsByIds` 与 `getSitesByIds` → `updateDomain` → `ensureAccountSiteRelations`，共 4 次串行往返。第 63 行的查询结果只用于第 68 行的 `buildDomainUpdateDetailFromForm`。
- `app/actions/accounts.ts:48-57`：`getAccountById` → `getSitesByIds` → 唯一性校验 → 更新，共 4 次。前两次只用于日志明细。
- `app/actions/sites.ts:43-47`：`getSiteById` → 更新，共 2 次。
- `lib/data/domains.ts:35-38`：有 `keyword` 时先查 `sites`、`accounts` 再查 `domains`，两跳串行；第 33 行的 `name.ilike.%${keyword}%` 未转义。同文件第 108-114 行在非默认排序时全量拉取并在内存排序，本次不改。

Next 16.2.2 源码核实（`node_modules/next/dist/server/web/spec-extension/revalidate.js`）：`updateTag` 只能在 Server Action 内调用，action 体内收集的 tag 在响应时刷新。这是不给日志汇总加缓存的原因之一：日志行是在其后的 `after()` 里才写入的。

## 交互细节（批次 C 的依据）

- `components/accounts/AccountsPageClient.tsx:67` 与 `:84-86`：props 复制进 `useState` 再用 effect 同步。`:433-437` 表单关闭必然 `router.refresh()`。
- `components/accounts/AccountDetailsPage.tsx:197-201`：同样必然 `router.refresh()`。`AccountFormDialog.tsx:108` 与 `:127` 中，更新成功和取消都是无参 `onClose()`，调用方无法区分。
- 四个列表页同时渲染桌面表格和移动卡片：`DomainsPageClient.tsx:256`/`:275`、`AccountsPageClient.tsx:302`/`:401`、`LogsPageClient.tsx:244`/`:310`、`JobRunsPageClient.tsx:221`/`:270`。

## 审计中被更正或缩小的结论

- **详情页没有 `loading.tsx`（原第 8 条）**：原判断是“点击后要等服务器返回才有反馈”，不成立。`node_modules/next/dist/client/components/layout-router.js` 的 `LoadingBoundaryProvider` 会把父级的 loading 数据传给子路由，`/domains/[domainId]` 挂起时显示的就是 `domains/loading.tsx` 的骨架屏。不列入本次范围。
- **日志页统计（原第 5 条）**：4 个 count 与列表查询并发，不增加等待时间。加缓存的收益只是减少请求数，而且失效时机依赖 `after()` 之后的写入，沙箱里无法验证。本次只去掉冗余的 `total`。

## 沙箱里验证不了的行为

mock 模式下所有写入都会失败。下面这些只能靠代码走查保证，汇报时必须标为“未验证”：

- 新增、更新、删除成功之后的界面更新与提示。
- 操作日志的写入内容，通知的发送。
- 关键字搜索在真实 Supabase 上的查询结果。
