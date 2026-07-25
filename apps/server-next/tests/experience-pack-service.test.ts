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

async function setupChannel(
  harness: Harness,
  teamId: string,
  channelId = 'ch-1',
  archived = false,
  humanMemberIds: string[] = [],
) {
  const { repositories, clock } = harness;
  const now = clock.now();
  const channel = await repositories.channels.create({
    id: channelId,
    teamId,
    name: 'test-channel',
    title: 'Test Channel',
    visibility: 'team',
    humanMemberIds,
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
      await setupChannel(h, teamId, 'ch-1', true);

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
      await setupChannel(h, teamId, 'ch-1', false);

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

  // ── approve ─────────────────────────────────────────────────────────

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

  // ── withdraw ─────────────────────────────────────────────────────────

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

  // ── markSourceInvalid ─────────────────────────────────────────────────

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

  // ── recommendToChannel（#723：创建 pending attachment）──────────────────

  describe('recommendToChannel', () => {
    test('PI recommends approved pack to active channel → pending', async () => {
      const { teamId } = await setupTeam(h);
      await setupChannel(h, teamId, 'ch-1', true); // source (archived)
      await setupChannel(h, teamId, 'ch-2', false); // target (active)

      const draft = await h.service.createDraft({
        teamId,
        actorId: 'user-1',
        title: 'Recommending Pack',
        sourceChannelId: 'ch-1',
      });
      await h.service.approve({ teamId, actorId: 'user-1', packId: draft.id });

      const attachment = await h.service.recommendToChannel({
        teamId,
        actorId: 'user-1',
        packId: draft.id,
        channelId: 'ch-2',
      });
      expect(attachment.status).toBe('pending');
      expect(attachment.packId).toBe(draft.id);
      expect(attachment.channelId).toBe('ch-2');
      expect(attachment.recommendedByUserId).toBe('user-1');
      expect(attachment.confirmedByUserId).toBeUndefined();
    });

    test('rejects recommendation to archived channel', async () => {
      const { teamId } = await setupTeam(h);
      await setupChannel(h, teamId, 'ch-1', true);
      await setupChannel(h, teamId, 'ch-2', true); // target is archived

      const draft = await h.service.createDraft({
        teamId,
        actorId: 'user-1',
        title: 'Archived Target',
        sourceChannelId: 'ch-1',
      });
      await h.service.approve({ teamId, actorId: 'user-1', packId: draft.id });

      await expect(h.service.recommendToChannel({
        teamId,
        actorId: 'user-1',
        packId: draft.id,
        channelId: 'ch-2',
      })).rejects.toThrow('EXPERIENCE_PACK_RECOMMEND');
    });

    test('rejects recommendation of non-approved pack', async () => {
      const { teamId } = await setupTeam(h);
      await setupChannel(h, teamId, 'ch-source', true); // archived source for draft
      await setupChannel(h, teamId, 'ch-target', false); // active target

      const draft = await h.service.createDraft({
        teamId,
        actorId: 'user-1',
        title: 'Not Approved',
        sourceChannelId: 'ch-source',
      });
      // never approved — still draft

      await expect(h.service.recommendToChannel({
        teamId,
        actorId: 'user-1',
        packId: draft.id,
        channelId: 'ch-target',
      })).rejects.toThrow('EXPERIENCE_PACK_RECOMMEND');
    });
  });

  // ── confirmAttachment（#723：pending → attached）────────────────────────

  describe('confirmAttachment', () => {
    test('channel member confirms pending → attached', async () => {
      const { teamId } = await setupTeam(h, 'team-1', 'admin-user');
      await setupChannel(h, teamId, 'ch-1', true); // source
      await setupChannel(h, teamId, 'ch-2', false, ['member-1']); // target with member

      // add member-1 to team so channel membership resolves
      await h.repositories.teams.addMember({ teamId, userId: 'member-1', role: 'member', at: h.clock.now() });

      const draft = await h.service.createDraft({
        teamId,
        actorId: 'admin-user',
        title: 'Ready to Confirm',
        sourceChannelId: 'ch-1',
      });
      await h.service.approve({ teamId, actorId: 'admin-user', packId: draft.id });
      await h.service.recommendToChannel({
        teamId,
        actorId: 'admin-user',
        packId: draft.id,
        channelId: 'ch-2',
      });

      const confirmed = await h.service.confirmAttachment({
        teamId,
        actorId: 'member-1',
        packId: draft.id,
        channelId: 'ch-2',
      });
      expect(confirmed.status).toBe('attached');
      expect(confirmed.confirmedByUserId).toBe('member-1');
      expect(confirmed.confirmedAt).toBeTruthy();
    });

    test('rejects confirm by non-channel-member', async () => {
      const { teamId } = await setupTeam(h, 'team-1', 'admin-user');
      await setupChannel(h, teamId, 'ch-1', true);
      await setupChannel(h, teamId, 'ch-2', false, []); // no members

      const draft = await h.service.createDraft({
        teamId,
        actorId: 'admin-user',
        title: 'Member Only',
        sourceChannelId: 'ch-1',
      });
      await h.service.approve({ teamId, actorId: 'admin-user', packId: draft.id });
      await h.service.recommendToChannel({
        teamId,
        actorId: 'admin-user',
        packId: draft.id,
        channelId: 'ch-2',
      });

      await expect(h.service.confirmAttachment({
        teamId,
        actorId: 'outsider',
        packId: draft.id,
        channelId: 'ch-2',
      })).rejects.toThrow('EXPERIENCE_PACK_CONFIRM');
    });

    test('rejects confirm of already attached', async () => {
      const { teamId } = await setupTeam(h, 'team-1', 'admin-user');
      await setupChannel(h, teamId, 'ch-1', true);
      await setupChannel(h, teamId, 'ch-2', false, ['member-1']);
      await h.repositories.teams.addMember({ teamId, userId: 'member-1', role: 'member', at: h.clock.now() });

      const draft = await h.service.createDraft({
        teamId,
        actorId: 'admin-user',
        title: 'Already Attached',
        sourceChannelId: 'ch-1',
      });
      await h.service.approve({ teamId, actorId: 'admin-user', packId: draft.id });
      await h.service.recommendToChannel({
        teamId,
        actorId: 'admin-user',
        packId: draft.id,
        channelId: 'ch-2',
      });
      await h.service.confirmAttachment({
        teamId,
        actorId: 'member-1',
        packId: draft.id,
        channelId: 'ch-2',
      });

      // second confirm should fail
      await expect(h.service.confirmAttachment({
        teamId,
        actorId: 'member-1',
        packId: draft.id,
        channelId: 'ch-2',
      })).rejects.toThrow('EXPERIENCE_PACK_CONFIRM');
    });
  });

  // ── revokeAttachment（#723：attached → revoked）─────────────────────────

  describe('revokeAttachment', () => {
    test('channel member revokes attached → revoked', async () => {
      const { teamId } = await setupTeam(h, 'team-1', 'admin-user');
      await setupChannel(h, teamId, 'ch-1', true);
      await setupChannel(h, teamId, 'ch-2', false, ['member-1']);
      await h.repositories.teams.addMember({ teamId, userId: 'member-1', role: 'member', at: h.clock.now() });

      const draft = await h.service.createDraft({
        teamId,
        actorId: 'admin-user',
        title: 'Revocable',
        sourceChannelId: 'ch-1',
      });
      await h.service.approve({ teamId, actorId: 'admin-user', packId: draft.id });
      await h.service.recommendToChannel({
        teamId,
        actorId: 'admin-user',
        packId: draft.id,
        channelId: 'ch-2',
      });
      await h.service.confirmAttachment({
        teamId,
        actorId: 'member-1',
        packId: draft.id,
        channelId: 'ch-2',
      });

      const revoked = await h.service.revokeAttachment({
        teamId,
        actorId: 'member-1',
        packId: draft.id,
        channelId: 'ch-2',
      });
      expect(revoked.status).toBe('revoked');
      expect(revoked.revokedByUserId).toBe('member-1');
      expect(revoked.revokedAt).toBeTruthy();
    });

    test('revoked attachment not listed in listApprovedForChannel', async () => {
      const { teamId } = await setupTeam(h, 'team-1', 'admin-user');
      await setupChannel(h, teamId, 'ch-1', true);
      await setupChannel(h, teamId, 'ch-2', false, ['member-1']);
      await h.repositories.teams.addMember({ teamId, userId: 'member-1', role: 'member', at: h.clock.now() });

      const draft = await h.service.createDraft({
        teamId,
        actorId: 'admin-user',
        title: 'Excluded After Revoke',
        sourceChannelId: 'ch-1',
      });
      await h.service.approve({ teamId, actorId: 'admin-user', packId: draft.id });
      await h.service.recommendToChannel({
        teamId,
        actorId: 'admin-user',
        packId: draft.id,
        channelId: 'ch-2',
      });
      await h.service.confirmAttachment({
        teamId,
        actorId: 'member-1',
        packId: draft.id,
        channelId: 'ch-2',
      });

      // Before revoke → visible
      let packs = await h.service.listApprovedForChannel({ teamId, channelId: 'ch-2' });
      expect(packs).toHaveLength(1);

      await h.service.revokeAttachment({
        teamId,
        actorId: 'member-1',
        packId: draft.id,
        channelId: 'ch-2',
      });

      // After revoke → not visible
      packs = await h.service.listApprovedForChannel({ teamId, channelId: 'ch-2' });
      expect(packs).toHaveLength(0);
    });

    test('rejects revoke by non-member + non-admin', async () => {
      const { teamId } = await setupTeam(h, 'team-1', 'admin-user');
      await setupChannel(h, teamId, 'ch-1', true);
      await setupChannel(h, teamId, 'ch-2', false, ['member-1']);
      await h.repositories.teams.addMember({ teamId, userId: 'member-1', role: 'member', at: h.clock.now() });

      const draft = await h.service.createDraft({
        teamId,
        actorId: 'admin-user',
        title: 'Protected',
        sourceChannelId: 'ch-1',
      });
      await h.service.approve({ teamId, actorId: 'admin-user', packId: draft.id });
      await h.service.recommendToChannel({
        teamId,
        actorId: 'admin-user',
        packId: draft.id,
        channelId: 'ch-2',
      });
      await h.service.confirmAttachment({
        teamId,
        actorId: 'member-1',
        packId: draft.id,
        channelId: 'ch-2',
      });

      await expect(h.service.revokeAttachment({
        teamId,
        actorId: 'outsider',
        packId: draft.id,
        channelId: 'ch-2',
      })).rejects.toThrow('EXPERIENCE_PACK_REVOKE');
    });
  });

  // ── listApprovedForChannel ─────────────────────────────────────────────

  describe('listApprovedForChannel', () => {
    test('AC#5: draft pack not returned', async () => {
      const { teamId } = await setupTeam(h);
      await setupChannel(h, teamId, 'ch-1', true);

      const draft = await h.service.createDraft({
        teamId,
        actorId: 'user-1',
        title: 'Draft Hidden',
        sourceChannelId: 'ch-1',
      });

      const packs = await h.service.listApprovedForChannel({ teamId, channelId: 'ch-1' });
      expect(packs).toHaveLength(0);
      expect(packs.find((p) => p.id === draft.id)).toBeUndefined();
    });

    test('pending attachment not returned until confirmed', async () => {
      const { teamId } = await setupTeam(h, 'team-1', 'admin-user');
      await setupChannel(h, teamId, 'ch-1', true);
      await setupChannel(h, teamId, 'ch-2', false, ['member-1']);
      await h.repositories.teams.addMember({ teamId, userId: 'member-1', role: 'member', at: h.clock.now() });

      const draft = await h.service.createDraft({
        teamId,
        actorId: 'admin-user',
        title: 'Pending Test',
        sourceChannelId: 'ch-1',
      });
      await h.service.approve({ teamId, actorId: 'admin-user', packId: draft.id });
      await h.service.recommendToChannel({
        teamId,
        actorId: 'admin-user',
        packId: draft.id,
        channelId: 'ch-2',
      });

      // pending → not returned
      let packs = await h.service.listApprovedForChannel({ teamId, channelId: 'ch-2' });
      expect(packs).toHaveLength(0);

      // confirm → now returned
      await h.service.confirmAttachment({
        teamId,
        actorId: 'member-1',
        packId: draft.id,
        channelId: 'ch-2',
      });
      packs = await h.service.listApprovedForChannel({ teamId, channelId: 'ch-2' });
      expect(packs).toHaveLength(1);
      expect(packs[0]!.id).toBe(draft.id);
    });
  });

  // ── listByTeam ─────────────────────────────────────────────────────────

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
