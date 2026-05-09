# 计划：为 Slock Daemon 构建沙箱执行环境

## Context

用户想让远程调用者通过 Slock 平台在其机器上启动 Agent（Claude/Codex）执行任务。

需求：
1. Agent 保留 `--dangerously-skip-permissions`（自主运行，无交互）
2. 远程调用者只对**指定输出目录**有完全控制权
3. Agent 不能访问输出目录以外的文件系统
4. 项目源码**只读挂载**（Agent 可读但不能改）
5. 运行环境：macOS（Docker Desktop / OrbStack）

核心矛盾：`--dangerously-skip-permissions` 跳过所有软件级权限检查，
因此**必须在 OS 层面做隔离**。Docker 是 macOS 上最实用的隔离方案。

## 产出物

创建以下文件（在当前目录 `docs/demo001/` 下）：

### 1. `sandbox/Dockerfile`

Docker 镜像定义：
- 基于 `node:22-slim`
- 安装 Claude Code、Codex CLI、@slock-ai/daemon
- 创建 `/workspace`（只读）、`/output`（读写）、`/home/agent/.slock`（Agent 持久工作区）
- 以 `slock-daemon` 作为 ENTRYPOINT

### 2. `sandbox/run-sandboxed.sh`

启动脚本，用法：
```bash
SLOCK_API_KEY=sk_machine_xxx \
SLOCK_PROJECT_DIR=/path/to/source-code \
SLOCK_OUTPUT_DIR=/path/to/output \
./run-sandboxed.sh
```

关键 Docker 参数：
- `-v $PROJECT_DIR:/workspace:ro` — 项目源码只读挂载
- `-v $OUTPUT_DIR:/output:rw` — 输出目录读写挂载
- `-v slock-agent-data:/home/agent/.slock` — Agent 工作区持久化
- `--network bridge` — 网络隔离
- `--memory 8g --cpus 4` — 资源限制
- `--cap-drop ALL --security-opt no-new-privileges` — 安全加固

### 3. `sandbox/sandbox-exec-profile.sb`（macOS 原生备选方案）

为不想安装 Docker 的 macOS 用户提供 `sandbox-exec` 配置：
- 允许读写输出目录和 `~/.slock`
- 允许只读访问项目目录
- 允许网络连接到 `api.slock.ai`
- 拒绝其他所有文件系统和网络访问

## 验证方式

1. `docker build -t slock-daemon-sandbox sandbox/`
2. 启动容器，在容器内执行：
   - `touch /output/test` → 成功（读写权限）
   - `touch /workspace/test` → Permission denied（只读）
   - `cat /etc/shadow` → 不存在或无权限（隔离生效）
   - `ls ~/.ssh` → 不存在（宿主机文件不可见）
3. 通过 Slock 平台发送任务，确认 Agent 能读取项目源码并将结果写入 /output
