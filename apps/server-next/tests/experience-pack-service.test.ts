import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { ServerNextRepositories } from '../src/index.js';
import { createExperiencePackService } from '../src/application/experience-pack-service.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';

interface Harness {
  readonly repositories: ServerNextRepositories;
  readonly service: ReturnType<typeof createExperiencePackService>;
  readonly clock: { now(): number };
  readonly ids: { nextId(): string };
  readonly close(): void;
}

function makeHarness(repositories: ServerNextRepositories): Harness {
  let tick = 1_000_000;
  let counter = 0;
  const clock = { now: () => (tick += 10_000) };
  const ids = { nextId: () => `ep-${++counter}` };
  const service = createExperiencePackService({ repositories, clock, ids });
  return { repositories, service, clock, ids, close() {} };
}

async function setupTeam(harness: Harness, teamId = 'team-1', userId = 'user-1') {
  const { repositories, clock } = harness;
  const now = clock.now();
  // 创建用户（SQLite 有 FK 约束）
  await repositories.users.create({
    id: userId,
    username: userId,
    displayName: userId,
    passwordHash: 'hash',
    role: 'admin',
    currentTeamId: null,
    createdAt: now,
    updatedAt: now,
  });
  await repositories.teams.create({
    id: teamId,
    name: 'test-team',
    path: 'test-team',
    displayName: 'Test Team',
    visibility: 'private' as any,
    ownerId: userId,
    createdAt: now,
    updatedAt: now,
  } as any);
  await repositories.teams.addMember({ teamId, userId, role: 'owner', at: now });
  return { teamId, userId };
}

async function setupChannel(harness: Harness, teamId: string, channelId = 'ch-1', archived = false) {
  const { repositories, clock } = harness;
  const now = clock.now();
  const channel = await repositories.channels.create({
    id: channelId,
    teamId,
    name: 'test-channel',
    title: 'Test Channel',
    visibility: 'team',
    humanMemberIds: [],
    agentMemberIds: [],
    createdAt: now,
    updatedAt: now,
    archivedAt: archived ? now : (null as unknown as undefined),
  });
  return channel;
}

describe('experience-pack-service', () => {
  const makeTestHarness = () => makeHarness(createInMemoryRepositories());

  let h: ReturnType<typeof makeTestHarness>;

  beforeEach(() => {
    h = makeTestHarness();
  });

  afterEach(() => {
    h.close();
  });

  // ── createDraft ─────────────────────────────────────────────────────────

  describe('createDraft', () => {
    test('AC#1: creates draft from archived channel', async () => {
      const { teamId } = await setupTeam(h);
      await setupChannel(h, teamId, 'ch-1', true); // archived

      const pack = await h.service.createDraft({
        teamId,
        actorId: 'user-1',
        title: 'Project Retrospective',
        sourceChannelId: 'ch-1',
        conclusions: 'We should use TypeScript strict mode',
      });

      expect(pack.status).toBe('draft');
      expect(pack.title).toBe('Project Retrospective');
      expect(pack.sourceChannelId).toBe('ch-1');
      expect(pack.conclusions).toBe('We should use TypeScript strict mode');
      expect(pack.createdByUserId).toBe('user-1');
    });

    test('AC#1: creates draft with sources', async () => {
      const { teamId } = await setupTeam(h);
      await setupChannel(h, teamId, 'ch-1', true);

      const pack = await h.service.createDraft({
        teamId,
        actorId: 'user-1',
        title: 'With Sources',
        sourceChannelId: 'ch-1',
        sources: [{
          sourceKind: 'message',
          sourceId: 'msg-1',
          snapshotHash: 'sha256:abc',
          sourceScopeType: 'channel',
          sourceScopeRef: 'ch-1',
        }],
      });

      expect(pack.status).toBe('draft');
      expect(pack.id).toBeTruthy();
    });

    test('AC#1: rejects draft for unarchived channel', async () => {
      const { teamId } = await setupTeam(h);
      await setupChannel(h, teamId, 'ch-1', false); // not archived

      await expect(h.service.createDraft({
        teamId,
        actorId: 'user-1',
        title: 'Should Fail',
        sourceChannelId: 'ch-1',
      })).rejects.toThrow('EXPERIENCE_PACK_DRAFT_INVALID');
    });

    test('AC#1: rejects empty title', async () => {
      const { teamId } = await setupTeam(h);
      await setupChannel(h, teamId, 'ch-1', true);

      await expect(h.service.createDraft({
        teamId,
        actorId: 'user-1',
        title: '',
        sourceChannelId: 'ch-1',
      })).rejects.toThrow('EXPERIENCE_PACK_DRAFT_INVALID');
    });
  });

  // ── approve（AC#3：第一次确认）─────────────────────────────────────────

  describe('approve', () => {
    test('AC#3: draft → approved by team admin', async () => {
      const { teamId } = await setupTeam(h);
      await setupChannel(h, teamId, 'ch-1', true);

      const draft = await h.service.createDraft({
        teamId,
        actorId: 'user-1',
        title: 'Approvable',
        sourceChannelId: 'ch-1',
      });

      const approved = await h.service.approve({
        teamId,
        actorId: 'user-1',
        packId: draft.id,
      });

      expect(approved.status).toBe('approved');
      expect(approved.approvedByUserId).toBe('user-1');
    });

    test('AC#3: rejects approve of already approved pack', async () => {
      const { teamId } = await setupTeam(h);
      await setupChannel(h, teamId, 'ch-1', true);

      const draft = await h.service.createDraft({
        teamId,
        actorId: 'user-1',
        title: 'Already Done',
        sourceChannelId: 'ch-1',
      });
      await h.service.approve({ teamId, actorId: 'user-1', packId: draft.id });

      await expect(h.service.approve({
        teamId,
        actorId: 'user-1',
        packId: draft.id,
      })).rejects.toThrow('EXPERIENCE_PACK_APPROVE');
    });

    test('AC#3: rejects approve by non-admin member', async () => {
      const { teamId } = await setupTeam(h, 'team-1', 'admin-user');
      await setupChannel(h, teamId, 'ch-1', true);
      // add a regular member
      await h.repositories.teams.addMember({ teamId, userId: 'member-1', role: 'member', at: h.clock.now() });

      const draft = await h.service.createDraft({
        teamId,
        actorId: 'admin-user',
        title: 'Needs Admin',
        sourceChannelId: 'ch-1',
      });

      await expect(h.service.approve({
        teamId,
        actorId: 'member-1',
        packId: draft.id,
      })).rejects.toThrow('EXPERIENCE_PACK_APPROVE');
    });
  });

  // ── withdraw（AC#7）─────────────────────────────────────────────────────

  describe('withdraw', () => {
    test('AC#7: approved → withdrawn', async () => {
      const { teamId } = await setupTeam(h);
      await setupChannel(h, teamId, 'ch-1', true);

      const draft = await h.service.createDraft({
        teamId,
        actorId: 'user-1',
        title: 'Withdrawable',
        sourceChannelId: 'ch-1',
      });
      await h.service.approve({ teamId, actorId: 'user-1', packId: draft.id });

      const withdrawn = await h.service.withdraw({
        teamId,
        actorId: 'user-1',
        packId: draft.id,
      });
      expect(withdrawn.status).toBe('withdrawn');
    });

    test('AC#7: rejects withdraw of draft', async () => {
      const { teamId } = await setupTeam(h);
      await setupChannel(h, teamId, 'ch-1', true);

      const draft = await h.service.createDraft({
        teamId,
        actorId: 'user-1',
        title: 'Draft Not Withdrawable',
        sourceChannelId: 'ch-1',
      });

      await expect(h.service.withdraw({
        teamId,
        actorId: 'user-1',
        packId: draft.id,
      })).rejects.toThrow('EXPERIENCE_PACK_WITHDRAW');
    });
  });

  // ── markSourceInvalid（AC#6）────────────────────────────────────────────

  describe('markSourceInvalid', () => {
    test('AC#6: approved → source_invalid with reason', async () => {
      const { teamId } = await setupTeam(h);
      await setupChannel(h, teamId, 'ch-1', true);

      const draft = await h.service.createDraft({
        teamId,
        actorId: 'user-1',
        title: 'Source Check',
        sourceChannelId: 'ch-1',
      });
      await h.service.approve({ teamId, actorId: 'user-1', packId: draft.id });

      const invalid = await h.service.markSourceInvalid({
        teamId,
        actorId: 'user-1',
        packId: draft.id,
        reason: 'Source channel was deleted',
      });
      expect(invalid.status).toBe('source_invalid');
      expect(invalid.sourceInvalidReason).toBe('Source channel was deleted');
    });

    test('AC#6: rejects mark source_invalid without reason', async () => {
      const { teamId } = await setupTeam(h);
      await setupChannel(h, teamId, 'ch-1', true);

      const draft = await h.service.createDraft({
        teamId,
        actorId: 'user-1',
        title: 'Needs Reason',
        sourceChannelId: 'ch-1',
      });
      await h.service.approve({ teamId, actorId: 'user-1', packId: draft.id });

      await expect(h.service.markSourceInvalid({
        teamId,
        actorId: 'user-1',
        packId: draft.id,
        reason: '',
      })).rejects.toThrow('EXPERIENCE_PACK_SOURCE_INVALID');
    });
  });

  // ── attachToChannel / detachFromChannel（第二次确认）───────────────────

  describe('channel attachment', () => {
    test('attaches approved pack to active channel', async () => {
      const { teamId } = await setupTeam(h);
      await setupChannel(h, teamId, 'ch-1', true); // source (archived)
      await setupChannel(h, teamId, 'ch-2', false); // target (active)

      const draft = await h.service.createDraft({
        teamId,
        actorId: 'user-1',
        title: 'Attachable',
        sourceChannelId: 'ch-1',
      });
      await h.service.approve({ teamId, actorId: 'user-1', packId: draft.id });

      const attachment = await h.service.attachToChannel({
        teamId,
        actorId: 'user-1',
        packId: draft.id,
        channelId: 'ch-2',
      });
      expect(attachment.packId).toBe(draft.id);
      expect(attachment.channelId).toBe('ch-2');
    });

    test('AC#5: draft pack not returned in listApprovedForChannel', async () => {
      const { teamId } = await setupTeam(h);
      await setupChannel(h, teamId, 'ch-1', true);

      const draft = await h.service.createDraft({
        teamId,
        actorId: 'user-1',
        title: 'Draft Hidden',
        sourceChannelId: 'ch-1',
      });

      const packs = await h.service.listApprovedForChannel({
        teamId,
        channelId: 'ch-1',
      });
      expect(packs).toHaveLength(0);
      expect(packs.find((p) => p.id === draft.id)).toBeUndefined();
    });

    test('approved pack returned in listApprovedForChannel after attachment', async () => {
      const { teamId } = await setupTeam(h);
      await setupChannel(h, teamId, 'ch-1', true);
      await setupChannel(h, teamId, 'ch-2', false);

      const draft = await h.service.createDraft({
        teamId,
        actorId: 'user-1',
        title: 'Linked Pack',
        sourceChannelId: 'ch-1',
      });
      await h.service.approve({ teamId, actorId: 'user-1', packId: draft.id });
      await h.service.attachToChannel({
        teamId,
        actorId: 'user-1',
        packId: draft.id,
        channelId: 'ch-2',
      });

      const packs = await h.service.listApprovedForChannel({
        teamId,
        channelId: 'ch-2',
      });
      expect(packs).toHaveLength(1);
      expect(packs[0]!.id).toBe(draft.id);
    });

    test('detaches pack from channel', async () => {
      const { teamId } = await setupTeam(h);
      await setupChannel(h, teamId, 'ch-1', true);
      await setupChannel(h, teamId, 'ch-2', false);

      const draft = await h.service.createDraft({
        teamId,
        actorId: 'user-1',
        title: 'Detachable',
        sourceChannelId: 'ch-1',
      });
      await h.service.approve({ teamId, actorId: 'user-1', packId: draft.id });
      await h.service.attachToChannel({
        teamId,
        actorId: 'user-1',
        packId: draft.id,
        channelId: 'ch-2',
      });

      // Detach
      await h.service.detachFromChannel({
        teamId,
        actorId: 'user-1',
        packId: draft.id,
        channelId: 'ch-2',
      });

      const packs = await h.service.listApprovedForChannel({
        teamId,
        channelId: 'ch-2',
      });
      expect(packs).toHaveLength(0);
    });

    test('rejects attach of draft to channel', async () => {
      const { teamId } = await setupTeam(h);
      await setupChannel(h, teamId, 'ch-1', true);
      await setupChannel(h, teamId, 'ch-2', false);

      const draft = await h.service.createDraft({
        teamId,
        actorId: 'user-1',
        title: 'Not Ready',
        sourceChannelId: 'ch-1',
      });

      await expect(h.service.attachToChannel({
        teamId,
        actorId: 'user-1',
        packId: draft.id,
        channelId: 'ch-2',
      })).rejects.toThrow('EXPERIENCE_PACK_ATTACH');
    });
  });

  // ── listByTeam ──────────────────────────────────────────────────────────

  describe('listByTeam', () => {
    test('lists packs by status', async () => {
      const { teamId } = await setupTeam(h);
      await setupChannel(h, teamId, 'ch-1', true);
      await setupChannel(h, teamId, 'ch-2', true);

      await h.service.createDraft({
        teamId, actorId: 'user-1', title: 'Draft A',
        sourceChannelId: 'ch-1',
      });
      const draftB = await h.service.createDraft({
        teamId, actorId: 'user-1', title: 'Draft B',
        sourceChannelId: 'ch-2',
      });
      await h.service.approve({ teamId, actorId: 'user-1', packId: draftB.id });

      const allDrafts = await h.service.listByTeam({ teamId, status: 'draft' });
      expect(allDrafts).toHaveLength(1);
      expect(allDrafts[0]!.status).toBe('draft');

      const approved = await h.service.listByTeam({ teamId, status: 'approved' });
      expect(approved).toHaveLength(1);
      expect(approved[0]!.status).toBe('approved');

      const all = await h.service.listByTeam({ teamId });
      expect(all.length).toBeGreaterThanOrEqual(2);
    });
  });
});
