# 任务交付的浏览器系统推送

本轮扩展既有完成提醒：左侧栏「提醒」保存权威未读状态；用户主动开启「系统推送」后，离开页面也可由浏览器展示系统通知。仅新交付触发，不发送订阅前的历史提醒。关闭推送保留侧栏提醒；查看提醒不等于验收 Task。

## 配置与部署

Node 24；发送库锁定 web-push 3.6.7。Server 未配置下列变量时保持侧栏正常工作，并在面板显示「系统推送尚未启用」。部分配置、非法 subject 或不匹配的密钥会拒绝启动。

- AGENTBEAN_WEB_PUSH_PUBLIC_KEY：VAPID 公钥，只有此项可返回浏览器。
- AGENTBEAN_WEB_PUSH_PRIVATE_KEY：VAPID 私钥，仅存服务端 Secret。
- AGENTBEAN_WEB_PUSH_SUBJECT：真实运维联系地址（mailto:）或 HTTPS 联系页面。

生成一次后持久保管，勿每次部署重新生成：

```sh
node scripts/generate-web-push-keys.mjs /安全目录/agentbean-push.env mailto:实际运维邮箱
```

脚本以 0600 写入新文件，不覆盖既有文件、不打印密钥。将这三项配置到生产 Server 的环境变量后正常部署；脚本本身不修改远端配置或触发部署。

Web 必须使用 HTTPS（本地 localhost/loopback 可开发），并能从自身 origin 返回 /agentbean-push-sw.js；该文件位于 web-next/public，随常规 Next 构建与部署发布。响应禁缓存，scope 为 /；Worker 没有 fetch 缓存，不改变应用请求。VAPID 换钥后，用户再次打开页面会清理旧订阅，并可重新开启推送。

### 生产发布步骤

部署目标沿用 `.github/workflows/ci-cd.yml` 的 Railway 项目 `c6b70675-f7d5-47a1-a8e7-05b37d13e476`、`production` 环境 `e9c1a221-28b1-49c0-b279-be249a428737`、`api` 服务 `7b1dce9b-b7e7-4cfb-bb3f-ef86d10e8647`。服务以 `npm start` 启动，从 Railway 运行时环境读取推送配置，无需将私钥放入前端构建变量或仓库文件。

1. 获得本轮 Git 发布与生产配置授权后，建立关联 Issue 和 Session Claim，提交当前分支并创建中文 Draft PR。CI、最新 head Review 和 `check:pr-merge-readiness` 按项目门禁执行。
2. 合并前再次检查 Railway 的三个配置项是否存在，仅输出存在性；若已有配置，保留并核验，不能自动换钥。当前候选配置使用项目 Issues 页面 `https://github.com/xiaojichao/agentbean/issues` 作为 VAPID 联系 URI。
3. 将三个候选值通过 `railway variable set <变量名> --stdin --skip-deploys` 逐项写入上述明确 project/service/environment。使用进程 stdin 传值并捕获 CLI 输出，私钥不进入命令行参数、终端日志或 Git。全部写入后只读回查并在内存中验证与候选一致；任何一项失败都不能继续部署。
4. 门禁 READY 后合并，由现有 main CI/CD 一次性部署代码及完整配置。不要在逐项配置期间触发重启；不要借手动 dispatch 跳过发布或生产 smoke 门禁。
5. 核对 main CI/CD、Deploy production、生产 smoke、`https://api.agentbean.dev/healthz`。再用 ego-browser 验证登录后的推送开关可用，SW 脚本返回正确 MIME 与禁缓存头。以受控测试账号完成一次离站交付、系统通知展示、通知跳转、侧栏已读同步、退出后停止推送的生产验收。

回退优先恢复上一成功部署，不删除提醒、订阅或迁移表。`0088`、`0089` 为新增表/触发器，旧版应用无需反向迁移；保留持久数据及同一 VAPID 密钥以便恢复。若需停用系统推送而保留新版侧栏提醒，应一次性清空三个运行时配置后再部署，不可只删一个导致启动校验失败。回退后重新验证 health 与侧栏，并单独记录系统推送未启用。

2026-09-04 发布前只读核对：GitHub 与 Railway 均无这三个推送配置项；生产 health 为 `ok: true`。后续获得用户授权，已建立 Issue #1302 与 PR #1303，并使用 `--skip-deploys` 写入三个 Railway 配置、回查一致。部署与验收状态以 PR 和 main CI/CD 的最新记录为准；再次执行时需刷新状态。

## 投递契约

完成提醒落库后，独立 1 秒投递泵从未读提醒和有效订阅中预留最多 10 条；网络操作在数据库事务外执行，单次请求 socket timeout 5 秒。预留租约 60 秒，可在 Server 重启后续跑；暂时失败指数退避，最多 5 次，最多追溯 24 小时内提醒。发送到浏览器服务的 TTL 为 1 小时，urgency 为 high。404/410 移除失效订阅，400/401/403/413 不重试该次投递。

投递采用至少一次语义，不能承诺外部服务严格恰好一次。浏览器以提醒 ID 作为 tag，并在 IndexedDB 保留最近 200 个已展示 ID，减少网络重试和 Worker 重启导致的重复。系统策略、省电、网络或通知权限可能延迟/阻止实际展示；侧栏提醒不会因此丢失。

每次发送重新校验用户、Team、频道访问和未读状态。订阅按服务端登录身份绑定，每账号最多 20 个浏览器订阅；有效期最多 30 天，访问页面时续期。推送地址仅允许已知 Chrome/Firefox/Safari/Edge 服务域名的 HTTPS 443 端点，拒绝凭据、片段、私网和任意自定义 URL。新增浏览器服务需先核验官方域名再扩展白名单。

### 容量与历史保留（#1304）

- 新建或续期订阅前，在同一事务中删除该用户 `expiresAt <= now` 的端点及关联投递记录，再检查 20 个有效订阅上限。删除订阅、清理提醒时同时删除其投递记录。
- 每个 Team/接收者的已读提醒，按 `readAt` 保留最近 30 天且最多 100 条；查询列表和提交已读时执行清理。未读提醒不自动过期；完成来源的去重记录保留，清理不会重放旧提醒，也不修改 Task、消息或交付事实。长期不访问的接收者在下次查询时清理。
- `notifications:list` 固定按 `createdAt DESC, id ASC` 返回最多 50 条，`nextCursor: { createdAt, id } | null` 指向下一页。客户端原样回传 cursor；新增首页提醒不改变旧游标位置。权限过滤在服务端执行，所以一页可能不足 50 条、甚至为空；只要 `nextCursor` 非空就可继续读取，不能用 `items.length` 判断结束。
- `unreadCount` 是当前接收者在整个 Team 中仍有访问权限的未读总数，不是本页数量。服务端按频道/任务范围聚合后校验权限，不传输完整未读历史正文；费用随不同权限范围数增长，不按已读历史条数增长。游标不提供访问权限。
- 侧栏提供「更早提醒」「返回最新提醒」，每次仅显示一页；浏览旧页时仍同步首页的新提醒与全量角标，常规刷新不将旧页重置到首页。推送点击和发送前检查直接按 Team、接收者、提醒 ID 查询并重新鉴权，目标无需出现在首页。
- `0090` 增加查询索引及投递记录清理触发器，并清理已有孤立投递记录。回退旧应用无需反向迁移，但已经按策略清理的已读提醒不会恢复。

ego-browser 现场订阅返回 `jmt17.google.com`。它是 [Chromium 官方定义的 staging GCM 端点](https://chromium.googlesource.com/chromium/src/+/refs/tags/143.0.7489.0/components/push_messaging/push_messaging_constants.cc)，因此精确允许该主机；不开放整个 `google.com`，不改写浏览器返回的端点。

系统通知仅显示「AgentBean 有新的任务交付 / 点击查看结果」，不携带任务正文。点击使用同一任务/消息深链接，页面加载后调用侧栏的同一已读命令。未登录或当前账号无访问权限时，不会读取原用户的提醒。

关闭推送或退出账号时，先清理本机 IndexedDB 绑定与已展示通知，再取消浏览器订阅并向 Server 解绑。浏览器不保存应用登录 token 到 Worker；账号切换后的旧 recipient payload 不显示。不要把关闭浏览器页面视为退出账号。

## 验收

- 开启必须由用户点击触发浏览器权限请求；拒绝权限显示可操作说明。
- 开启后关闭所有 AgentBean 标签页，模拟一次真实 Agent 交付，收到系统通知；点击后打开正确结果、侧栏变为已读，Task 保持待验收。
- Server 在发送前重启、供应商暂时失败、重复请求、已读、撤权、关闭推送、换账号均有针对性自动化覆盖。
- 本地自动化使用可控 sender 和浏览器 Worker 环境；真实供应商及操作系统送达需要已授权浏览器的现场验收，不能用模拟结果代替。

### 2026-09-04 本地现场记录

使用 ego-browser、合成测试账号与手动写入的测试交付事实，连接真实 Google 推送服务。离开 AgentBean 页面后，完成事实于 `1788492754520` 毫秒写入，供应商于 `1788492756938` 毫秒接受（约 2.4 秒）；随后 `ServiceWorkerRegistration.getNotifications()` 确认后台已展示对应系统通知。读取该通知实际携带的 URL 并打开后，显示正确任务与交付回复，提醒已读，Task 仍为待审核。系统通知的原生鼠标点击未人工验收，Worker 点击处理有自动化覆盖。

现场同时修复了 ego 的合法推送域名被拒绝的问题。此机器的 Google 出站网络依赖现有代理，测试 Server 使用 Node 24 的 `NODE_USE_ENV_PROXY=1`；没有修改系统代理或生产配置。上述约 2.4 秒是单次本地投递观测，不是生产时延保证。

依据：[PushManager.subscribe](https://developer.mozilla.org/en-US/docs/Web/API/PushManager/subscribe)、[showNotification](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/showNotification)、[web-push 官方 API](https://github.com/web-push-libs/web-push#sendnotificationpushsubscription-payload-options)。
