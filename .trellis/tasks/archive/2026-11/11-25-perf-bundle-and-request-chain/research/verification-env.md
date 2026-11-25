# 验收环境

## 为什么需要沙箱

仓库主人正在仓库目录里运行 `next dev`（端口 3000，连接真实数据库）。在同一个目录里再起一个 dev server 或执行生产构建会共用 `.next`，可能干扰这个服务。所以**所有需要运行或构建的操作都在沙箱副本里进行**，仓库目录只用来编辑代码和跑只读检查。

## 目录与端口

每个角色使用自己的沙箱目录和端口，互不干扰：

| 角色 | 沙箱目录 | 端口 |
| --- | --- | --- |
| 验收者 | `/tmp/dm-accept-sandbox` | 3457 |
| 开发者 | `/tmp/dm-dev-sandbox` | 3458 |
| 总验收者 | `/tmp/dm-final-sandbox` | 3459 |

## 同步代码

每次验证前都重新执行，保证沙箱与工作区一致：

```bash
REPO=$(git rev-parse --show-toplevel)
SANDBOX_SCRIPT="$REPO/.trellis/tasks/archive/2026-11/11-25-perf-bundle-and-request-chain/research/sandbox.sh"
export DM_SANDBOX=/tmp/dm-accept-sandbox  # 换成自己角色的目录
export DM_PORT=3457
bash "$SANDBOX_SCRIPT" sync
```

`.env*` 被排除在外，沙箱里没有任何真实凭据。

## 启动 mock 模式的 dev server

```bash
bash "$SANDBOX_SCRIPT" dev
```

要点：

- Supabase 变量置空后，应用使用 mock 数据（只在开发模式下可用），不会连接任何数据库。
- 写入操作（新增、更新、删除、启停开关）在 mock 模式下会失败并弹出错误提示。这是预期行为，正好可以用来验证失败回滚。
- 必须用 `http://localhost:<port>` 访问。Next dev 默认拦截来自 `127.0.0.1` 的开发资源，页面会无法完成 hydration。
- 登录方式：在 `#login-secret` 输入 `smoke-test-key`，然后点击提交按钮。
- mock 数据的 id：域名 `mock-domain-1` 到 `mock-domain-4`，账号 `mock-account-1` 到 `mock-account-8`，站点 `mock-site-1` 到 `mock-site-8`。
- 首次访问某个路由需要现场编译，可能要等几秒。

## 生产构建与体积测量

```bash
bash "$SANDBOX_SCRIPT" build
bash "$SANDBOX_SCRIPT" measure
```

## 浏览器

通过 ZCode 的 `browser-use:control-browser` 在独立标签页访问沙箱地址，并用明确的 1440×900 和 390×844 视口分别检查。断点回归可从 767px 调至 768px。在未配置真实数据库的环境中只提交虚构数据，且仅验证预期的写入失败和回滚。浏览器的会话 Cookie 按主机而非端口隔离：同一浏览器并行访问多个 `localhost` 沙箱时，用相同的 mock 签名密钥，并把登出检查安排在其他验收结束后。

## 各项检查在哪里跑

| 检查 | 位置 | 命令 |
| --- | --- | --- |
| lint | 仓库目录（只读） | `npm run lint` |
| 类型检查 | 沙箱 | `npx tsc --noEmit` |
| 单元测试 | 沙箱 | `npm test` |
| 生产构建 | 沙箱 | 见上文 |
| UI 冒烟 | 沙箱 | 使用 ZCode 浏览器访问 sandbox 的 mock 服务 |

## 禁止事项

- 不读取、不复制 `.env.local`，里面有真实凭据。
- 不在仓库目录里运行 `next dev` 或 `next build`。
- 不占用 3000 端口，不碰仓库主人的 dev server 进程。
- 不在仓库目录里执行 `npm install`，不修改 `node_modules`、`package.json`、lockfile。
- 只停止自己启动的进程。不要用 `pkill`、`killall` 按进程名匹配 `next`。
- 验收者不修改 `research/` 以外的任何文件。
