import { randomUUID } from 'node:crypto';
import type {
  CreateSystemKnowledgeInput,
  CreateUserMemoryInput,
  DeactivateSystemKnowledgeInput,
  DeactivateUserMemoryInput,
  DeleteSystemKnowledgeInput,
  DeleteUserMemoryInput,
  FormalMemoryKind,
  ID,
  ReviseSystemKnowledgeInput,
  ReviseUserMemoryInput,
  SystemKnowledgeDetailDto,
  SystemKnowledgeDto,
  SystemUserMemoryVersionDto,
  UserMemoryDetailDto,
  UserMemoryDto,
} from '../../../../packages/contracts/src/index.js';
import type { ServerNextRepositories } from './repositories.js';
import type {
  SystemKnowledgeRecord,
  UserMemoryRecord,
} from './system-user-memory-repositories.js';

/**
 * System Knowledge 与 User Memory 服务（issue #717）。
 *
 * 纯数据操作层：CRUD + 版本化 supersede + 停用。**鉴权不放这里**——由 `usecases.ts`
 * 在调用前用 `canManageSystemKnowledge`/`canManageUserMemory`（domain）校验。
 *
 * AC#2 天然满足：System/User Memory 的创建接口只有人工字段（kind/content/summary/
 * changeReason），**不接受** message/task/agent 等 sourceRefs，无 candidate 流程。
 *
 * AC#4 说明：User Memory「只允许稳定个人偏好、不得保存 Team 业务事实」是产品引导
 * 约束（UI 文案 + kind 默认 preference），技术上无法自动判断内容性质，故 service 层
 * 不做硬内容校验，靠前端引导与审计记录 `createdByUserId`。
 */
export interface SystemUserMemoryService {
  // ---- System Knowledge ----
  listSystemKnowledge(): Promise<readonly SystemKnowledgeDto[]>;
  getSystemKnowledgeDetail(input: { id: ID }): Promise<SystemKnowledgeDetailDto>;
  createSystemKnowledge(input: CreateSystemKnowledgeInput): Promise<SystemKnowledgeDto>;
  reviseSystemKnowledge(input: ReviseSystemKnowledgeInput): Promise<SystemKnowledgeDto>;
  deactivateSystemKnowledge(input: DeactivateSystemKnowledgeInput): Promise<SystemKnowledgeDto>;
  deleteSystemKnowledge(input: DeleteSystemKnowledgeInput): Promise<void>;
  // ---- User Memory ----
  listUserMemory(input: { ownerUserId: ID }): Promise<readonly UserMemoryDto[]>;
  getUserMemoryDetail(input: { id: ID }): Promise<UserMemoryDetailDto>;
  createUserMemory(input: CreateUserMemoryInput): Promise<UserMemoryDto>;
  reviseUserMemory(input: ReviseUserMemoryInput): Promise<UserMemoryDto>;
  deactivateUserMemory(input: DeactivateUserMemoryInput): Promise<UserMemoryDto>;
  deleteUserMemory(input: DeleteUserMemoryInput): Promise<void>;
}

export function createSystemUserMemoryService(input: {
  readonly repositories: ServerNextRepositories;
  readonly clock: { now(): number };
}): SystemUserMemoryService {
  const { repositories, clock } = input;

  return {
    async listSystemKnowledge() {
      const records = await repositories.systemKnowledge.list();
      return records.map(toSystemKnowledgeDto);
    },

    async getSystemKnowledgeDetail({ id }) {
      const current = await repositories.systemKnowledge.getById({ id });
      if (!current) throw new Error('SYSTEM_KNOWLEDGE_NOT_FOUND');
      const versions = await repositories.systemKnowledge.listByVersionFamily({
        versionFamilyId: current.versionFamilyId,
      });
      return { ...toSystemKnowledgeDto(current), versions: versions.map(toVersionDto) };
    },

    async createSystemKnowledge(input) {
      const now = clock.now();
      const id = randomUUID();
      const record: SystemKnowledgeRecord = {
        id,
        kind: input.kind,
        status: 'active',
        content: input.content,
        summary: input.summary,
        changeReason: input.changeReason,
        versionFamilyId: id, // 初版：家族根 = 自身 id。
        createdByUserId: input.actorId,
        validUntil: input.validUntil,
        createdAt: now,
        updatedAt: now,
      };
      await repositories.systemKnowledge.create(record);
      return toSystemKnowledgeDto(record);
    },

    async reviseSystemKnowledge(input) {
      const old = await repositories.systemKnowledge.getById({ id: input.memoryId });
      if (!old) throw new Error('SYSTEM_KNOWLEDGE_NOT_FOUND');
      if (old.status === 'superseded') throw new Error('SYSTEM_KNOWLEDGE_ALREADY_SUPERSEDED');
      const now = clock.now();
      const id = randomUUID();
      const next: SystemKnowledgeRecord = {
        id,
        kind: old.kind,
        status: 'active',
        content: input.content,
        summary: input.summary,
        changeReason: input.changeReason,
        versionFamilyId: old.versionFamilyId, // 继承家族根。
        createdByUserId: input.actorId,
        validFrom: old.validFrom,
        validUntil: input.validUntil ?? old.validUntil,
        createdAt: now,
        updatedAt: now,
      };
      await repositories.systemKnowledge.create(next);
      await repositories.systemKnowledge.markSuperseded({ id: old.id, supersededById: id, updatedAt: now });
      return toSystemKnowledgeDto(next);
    },

    async deactivateSystemKnowledge(input) {
      const current = await repositories.systemKnowledge.getById({ id: input.memoryId });
      if (!current) throw new Error('SYSTEM_KNOWLEDGE_NOT_FOUND');
      const now = clock.now();
      await repositories.systemKnowledge.markExpired({ id: input.memoryId, changeReason: input.changeReason, updatedAt: now });
      return toSystemKnowledgeDto({ ...current, status: 'expired', changeReason: input.changeReason, updatedAt: now });
    },

    async deleteSystemKnowledge(input) {
      const current = await repositories.systemKnowledge.getById({ id: input.memoryId });
      if (!current) throw new Error('SYSTEM_KNOWLEDGE_NOT_FOUND');
      await repositories.systemKnowledge.delete({ id: input.memoryId });
    },

    async listUserMemory({ ownerUserId }) {
      const records = await repositories.userMemory.listByOwner({ ownerUserId });
      return records.map(toUserMemoryDto);
    },

    async getUserMemoryDetail({ id }) {
      const current = await repositories.userMemory.getById({ id });
      if (!current) throw new Error('USER_MEMORY_NOT_FOUND');
      const versions = await repositories.userMemory.listByVersionFamily({
        versionFamilyId: current.versionFamilyId,
      });
      return { ...toUserMemoryDto(current), versions: versions.map(toVersionDto) };
    },

    async createUserMemory(input) {
      const now = clock.now();
      const id = randomUUID();
      const record: UserMemoryRecord = {
        id,
        ownerUserId: input.actorId, // AC#3/AC#6：本人创建，owner = actor（DB CHECK 双保险）。
        kind: input.kind,
        status: 'active',
        content: input.content,
        summary: input.summary,
        changeReason: input.changeReason,
        versionFamilyId: id,
        createdByUserId: input.actorId,
        validUntil: input.validUntil,
        createdAt: now,
        updatedAt: now,
      };
      await repositories.userMemory.create(record);
      return toUserMemoryDto(record);
    },

    async reviseUserMemory(input) {
      const old = await repositories.userMemory.getById({ id: input.memoryId });
      if (!old) throw new Error('USER_MEMORY_NOT_FOUND');
      if (old.status === 'superseded') throw new Error('USER_MEMORY_ALREADY_SUPERSEDED');
      const now = clock.now();
      const id = randomUUID();
      const next: UserMemoryRecord = {
        id,
        ownerUserId: old.ownerUserId, // owner 保持不变（AC#6：仅本人）。
        kind: old.kind,
        status: 'active',
        content: input.content,
        summary: input.summary,
        changeReason: input.changeReason,
        versionFamilyId: old.versionFamilyId,
        createdByUserId: input.actorId,
        validFrom: old.validFrom,
        validUntil: input.validUntil ?? old.validUntil,
        createdAt: now,
        updatedAt: now,
      };
      await repositories.userMemory.create(next);
      await repositories.userMemory.markSuperseded({ id: old.id, supersededById: id, updatedAt: now });
      return toUserMemoryDto(next);
    },

    async deactivateUserMemory(input) {
      const current = await repositories.userMemory.getById({ id: input.memoryId });
      if (!current) throw new Error('USER_MEMORY_NOT_FOUND');
      const now = clock.now();
      await repositories.userMemory.markExpired({ id: input.memoryId, changeReason: input.changeReason, updatedAt: now });
      return toUserMemoryDto({ ...current, status: 'expired', changeReason: input.changeReason, updatedAt: now });
    },

    async deleteUserMemory(input) {
      const current = await repositories.userMemory.getById({ id: input.memoryId });
      if (!current) throw new Error('USER_MEMORY_NOT_FOUND');
      await repositories.userMemory.delete({ id: input.memoryId });
    },
  };
}

function toSystemKnowledgeDto(record: SystemKnowledgeRecord): SystemKnowledgeDto {
  return {
    schemaVersion: 1,
    id: record.id,
    scope: 'system',
    kind: record.kind,
    status: record.status,
    content: record.content,
    summary: record.summary,
    changeReason: record.changeReason,
    validFrom: record.validFrom,
    validUntil: record.validUntil,
    supersededById: record.supersededById,
    versionFamilyId: record.versionFamilyId,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toUserMemoryDto(record: UserMemoryRecord): UserMemoryDto {
  return {
    schemaVersion: 1,
    id: record.id,
    scope: 'user',
    kind: record.kind,
    status: record.status,
    content: record.content,
    summary: record.summary,
    changeReason: record.changeReason,
    validFrom: record.validFrom,
    validUntil: record.validUntil,
    supersededById: record.supersededById,
    versionFamilyId: record.versionFamilyId,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ownerUserId: record.ownerUserId,
  };
}

function toVersionDto(record: SystemKnowledgeRecord): SystemUserMemoryVersionDto {
  return {
    versionId: record.id,
    kind: record.kind as FormalMemoryKind,
    content: record.content,
    summary: record.summary,
    changeReason: record.changeReason,
    status: record.status,
    actorUserId: record.createdByUserId,
    createdAt: record.createdAt,
  };
}
