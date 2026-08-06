# 发版、canonical daemon、cutover-audit 同步

## 何时适用

发 daemon 新版本、bump `apps/daemon-next/package.json` 版本、动 npm dist-tag、改 CI 发版流水线、动 `cutover-audit.test.ts` mock。

## 发版流水线（CI）

发版在 `.github/workflows/ci-cd.yml`：

1. **构建+打包**（`:511-512`）：`npm run build:daemon-next` → `node scripts/prepare-agentbean-next-daemon-release.mjs --out .agentbean-next-release/daemon`。prepare 脚本把 daemon-next 产物复制成 canonical `@agentbean/daemon` 包结构。
2. **取版本号**（`:516-517`）：`DAEMON_NEXT_VERSION` 来自 `apps/daemon-next/package.json` 的 `version`（现 `0.3.32`）；`CANONICAL_DAEMON_VERSION` 来自打包后 `.agentbean-next-release/daemon/package.json` 的 `version`，作为 step output `canonical_daemon_version`。
3. **去重检查**（`:534`/`:541`）：若 `@agentbean/daemon-next@$DAEMON_NEXT_VERSION` 或 `@agentbean/daemon@$CANONICAL_DAEMON_VERSION` 已在 npm，本次不发新版本（只 `::warning::`），设备 `agentbean update` 停在旧版。
4. **publish**：分别发 `@agentbean/daemon-next`（`:566` working-directory=`apps/daemon-next`）与 canonical `@agentbean/daemon`。

## canonical daemon 的 dist-tag

- `@agentbean/daemon-next@$DAEMON_NEXT_VERSION` 发到默认 tag（dev/内部通道）。
- canonical `@agentbean/daemon@$CANONICAL_DAEMON_VERSION` 是**设备实际 `npm install` 的包**。
- **`latest` dist-tag 不自动指向新版本**：手动 promote（见下）。CI 在 `:590-597` 轮询确认 `latest` 已传播。

## 手动 promote latest

`ci-cd.yml:37-38` 定义 workflow_dispatch 入参 `promote_agentbean_daemon_latest`，描述为「Promote canonical @agentbean/daemon npm latest dist-tag to the daemon-next version. Outward-facing; run only when ready to make daemon-next the default npm install.」。

触发后执行（`:580`）：

```bash
npm dist-tag add "@agentbean/daemon@${canonical_daemon_version}" latest
```

**只有 promote 后**，新装设备 `npm install -g @agentbean/daemon` 才拿到新版本；已装设备 `agentbean update` 才会升。promote 是对外发布动作，验证完再按。

## legacy dist-tag 必须钉 0.1.35

CI 在 `:495-496` 守卫：`npm view @agentbean/daemon dist-tags.legacy` 必须等于 `0.1.35`，否则报 `::error::` 终止发版。legacy dist-tag 指向历史归档包，**永远不要动**。改 canonical 发版逻辑时这条守卫必须保留。

## 关键陷阱：bump 版本必须同步 cutover-audit mock

`apps/server-next/tests/cutover-audit.test.ts` 硬编码了 daemon 版本字面量。bump `apps/daemon-next/package.json` 的 `version`（如从 `0.3.32` 升到下一版）时，**必须同步改**该测试 mock 中的 6+ 处 `0.3.32`：

- `:24-25`：`'@agentbean/daemon-next@0.3.32': '0.3.32'`、`'@agentbean/daemon@0.3.32': '0.3.32'`
- `:28`：`'@agentbean/daemon': { latest: '0.3.32', legacy: '0.1.35' }`
- `:110`：dist-tag JSON `{ latest: '0.3.32', legacy: '0.1.35' }`
- `:115-116`：`'@agentbean/daemon-next@0.3.32'`、`'@agentbean/daemon@0.3.32'`
- `:151`：dist-tag JSON（同 :110）
- `:156-157`：版本 map（同 :115-116）

漏改任何一处，`cutover-audit` 审计会在 CI 挂掉。它校验「npm registry 与 GitHub 配置就绪」，mock 的版本号必须与真实 `package.json` 一致。

## 本地模式（bump 版本清单）

1. 改 `apps/daemon-next/package.json` 的 `version`。
2. **同步改** `apps/server-next/tests/cutover-audit.test.ts` 全部 `0.3.32` 字面量（grep 一遍确认没漏）。
3. 跑 `npm run test:server-next-ci -- cutover-audit` 确认 mock 通过。
4. 不要动 `legacy` dist-tag（`0.1.35` 守卫）。
5. commit 后让 CI 走完 build+publish；验证完再手动 promote `latest`。

## 佐证文件

- `.github/workflows/ci-cd.yml:37-38,495-496,511-512,516-517,534,541,566,580,590-597`
- `apps/daemon-next/package.json`（`version`=`0.3.32`、`bin`、`name`）
- `apps/server-next/tests/cutover-audit.test.ts:24-25,28,110,115-116,151,156-157`
- `scripts/prepare-agentbean-next-daemon-release.mjs`

## 反模式

- **bump 版本不改 cutover-audit mock**：CI 直接挂，是最常见的发版回归。
- **手动 `npm dist-tag add ... latest` 绕过 workflow**：跳过了 CI 的去重/守卫/轮询，且 `legacy` 容易误碰。永远走 workflow_dispatch。
- **动 `legacy` dist-tag 或改 `0.1.35` 守卫**：历史归档包不可变。
- **改 `DAEMON_NEXT_VERSION` 取值来源**：它读 `apps/daemon-next/package.json`，改来源会让 prepare 脚本与 CI 失配。

## 验证命令

```bash
# bump 后扫所有待改的 mock 字面量（把 0.3.32 换成新版本号）
grep -n '0\.3\.32' apps/server-next/tests/cutover-audit.test.ts
# 确认当前 daemon-next 版本
grep '"version"' apps/daemon-next/package.json
# 确认 CI legacy 守卫仍在
grep -nE '0\.1\.35|legacy' .github/workflows/ci-cd.yml
# 确认 promote 入参与 dist-tag 命令
grep -nE 'promote_agentbean_daemon_latest|dist-tag add' .github/workflows/ci-cd.yml
```
