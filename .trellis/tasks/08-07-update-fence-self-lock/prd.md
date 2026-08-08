# PRD:修复 agentbean update 自锁 LEGACY_RUNTIME_FENCE_ACTIVE(#1114)

## 背景

`agentbean update`(0.3.40→0.3.41,2026-08-07)反复报 `LEGACY_RUNTIME_FENCE_ACTIVE` 并回滚;三次重试同样失败。手动路径(device stop + npm i -g + device install)正常。静态分析+逐秒 ps 监视(0.3.40 dist matcher)在重试窗口内**零匹配**——要么 offender 只在首次窗口存在,要么重试失败另有其因(error.log 无时间戳,update 的原因摘要引用历史日志行,无法区分)。

## 需求

1. fence 触发时**留下现场**:匹配到的 pid+command 写进 service 日志(现状只抛枚举值,无任何线索)。
2. 用带现场的版本复现 update,拿到真凶后修匹配/排除逻辑。
3. 修完 `agentbean update` 端到端通过(含版本确认)。

## 验收

- AC1:fence 触发时 device-service 日志含 offender 的 pid+command。
- AC2:本机 `agentbean update` 成功(或拿到 offender 后的修复版成功)。
- AC3:matcher 既有测试不回归(现代 CLI/npm/shell 排除规则不变)。

## 策略

先现场后修复,不盲改匹配规则。

## 实施要点

- `discoverUnregisteredLegacyRuntimePids` 加 `onMatch({pid,command})` 回调;`device-service-runtime.ts` fence 检查处 console.warn 匹配现场(service stderr → device-service.error.log)。
- 发 0.3.44(现场版)→ 本机 `agentbean update`(0.3.43→0.3.44)复现:
  - fence 再触发 → 日志给真凶 → 修匹配逻辑发 0.3.45;
  - 不再触发 → 首发现场已消失,保留现场日志能力,关闭 issue 标注间歇性。
