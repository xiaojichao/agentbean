// server-next 惯例:workspace 包一律用相对路径 import 源码(vitest 无 alias、CI 不构建 dist;
// 包名 import 会解析 node_modules 软链的 dist,CI 下失败——见 usecases.ts 同款写法)。
import type { ID, UnixMs } from '../../../../packages/contracts/src/index.js';
import type { ServerNextRepositories } from './repositories.js';
import {
  attemptOutputPackageFormation,
  type AttemptOutputPackageFormationInput,
  type AttemptOutputPackageFormationResult,
} from './output-package-handler.js';
import {
  submitPackageReviewCommand,
  type SubmitPackageReviewCommandInput,
  type SubmitPackageReviewResult,
} from './package-review-handler.js';
import {
  submitPackageBatchReviewCommand,
  type SubmitPackageBatchReviewCommandInput,
  type SubmitPackageBatchReviewResult,
} from './package-batch-review-handler.js';
import { bumpOutputPackageWatermark } from './output-package-consistency.js';
import type { ArtifactContentStore } from './usecases.js';

/**
 * OutputPackage 交付流水线深模块(#1059 epic;候选 01/02 深化第一刀)。
 *
 * 拥有 package 生命周期的**核心写事实**:
 * - formation:commit 成功后原子提交 collection+version+package+receipt,幂等键确定性派生自
 *   (channelId, publishId),失败只返回 rejected/conflict,不留部分事实,不推进 Task。
 * - review/finalize/reject-delivery:三个人类审核命令的写入(handler 调用)+ 成功后推进该频道
 *   output-package 水位(保证 read-your-writes 语义,旧 consistency token 查询随之 not_ready)。
 *
 * 本模块只产出**领域结果**(AttemptOutputPackageFormationResult / SubmitPackageReviewResult);
 * transport 面向的 ack 整形(packageReviewCommandAck,含 project-artifact 提升投影)留在
 * god-factory 作 adapter——那是另一个边界上下文(项目产物提升)的耦合点,不进本模块(切片 2 决议)。
 *
 * 依赖纯 in-process:{repositories, clock, ids},不回调 god-factory 任何关注点(D6 已验证)。
 */

export interface OutputPackageServiceDeps {
  readonly repositories: ServerNextRepositories;
  readonly artifactContentStore: ArtifactContentStore;
  readonly clock: { now(): UnixMs };
  readonly ids: { nextId(): ID };
  readonly editingEnabled: boolean;
}

/** review 写命令除 commandName 外的字段(commandName 由各方法按协议固定注入)。 */
export type ReviewWriteInput = Omit<SubmitPackageReviewCommandInput, 'commandName'>;

export interface OutputPackageService {
  /** commit 成功后 best-effort 形成 OutputPackage(幂等、原子、try/catch 不抛)。 */
  formPackage(input: AttemptOutputPackageFormationInput): Promise<AttemptOutputPackageFormationResult>;
  /** submit-package-artifact-review 核心:append-only review 写入 + 水位推进。 */
  submitReview(input: ReviewWriteInput): Promise<SubmitPackageReviewResult>;
  /** #1199 显式目标集合的全有或全无逐文件审核。 */
  submitBatchReview(input: SubmitPackageBatchReviewCommandInput): Promise<SubmitPackageBatchReviewResult>;
  /** submit-package-review-and-finalize 核心:通过并设为最终版(同事务两事实)+ 水位推进。 */
  finalize(input: ReviewWriteInput): Promise<SubmitPackageReviewResult>;
  /** submit-package-review-and-reject-delivery 核心:审核+退回 Task delivery(原子)+ 水位推进。 */
  rejectDelivery(input: ReviewWriteInput): Promise<SubmitPackageReviewResult>;
}

/**
 * 建立 OutputPackageService。handler 调用与水位推进的编排集中在此;调用方(god-factory
 * 的 review wrapper 与 commit)只负责传参与(可选的)ack 整形。
 */
export function createOutputPackageService(deps: OutputPackageServiceDeps): OutputPackageService {
  const { repositories, clock, ids } = deps;
  const handlerDeps = {
    repositories,
    artifactContentStore: deps.artifactContentStore,
    clock,
    ids,
    editingEnabled: deps.editingEnabled,
  };

  async function writeReview(
    commandName: SubmitPackageReviewCommandInput['commandName'],
    input: ReviewWriteInput,
  ): Promise<SubmitPackageReviewResult> {
    const result = await submitPackageReviewCommand(handlerDeps, { ...input, commandName });
    // #1065 AC7:写成功后推进该频道 output-package stream 水位,带旧 token 的查询据此 not_ready。
    if (result.kind === 'applied') {
      await bumpOutputPackageWatermark(repositories, input.channelId, clock.now());
    }
    return result;
  }

  return {
    formPackage(input) {
      return attemptOutputPackageFormation(handlerDeps, input);
    },
    submitReview(input) {
      return writeReview('submit-package-artifact-review', input);
    },
    async submitBatchReview(input) {
      const result = await submitPackageBatchReviewCommand({ repositories, clock, ids }, input);
      if (result.kind === 'applied') {
        await bumpOutputPackageWatermark(repositories, input.channelId, clock.now());
      }
      return result;
    },
    finalize(input) {
      return writeReview('submit-package-review-and-finalize', input);
    },
    rejectDelivery(input) {
      return writeReview('submit-package-review-and-reject-delivery', input);
    },
  };
}
