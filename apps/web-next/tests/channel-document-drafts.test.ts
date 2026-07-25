// @vitest-environment jsdom

import { beforeEach, describe, expect, test } from 'vitest';
import {
  CHANNEL_DOCUMENT_DRAFT_TTL_MS,
  clearChannelDocumentDrafts,
  readChannelDocumentDraft,
  removeChannelDocumentDraft,
  writeChannelDocumentDraft,
} from '../lib/channel-document-drafts';

const identity = {
  userId: 'user-1',
  teamId: 'team-1',
  documentId: 'document-1',
  baseRevisionId: 'revision-1',
};

describe('频道文档本地草稿', () => {
  beforeEach(() => localStorage.clear());

  test('按用户、Team、文档和基础 revision 隔离', () => {
    writeChannelDocumentDraft(localStorage, identity, {
      content: 'draft',
      filename: 'notes.md',
      updatedAt: 100,
    });

    expect(readChannelDocumentDraft(localStorage, identity, 101)).toMatchObject({ content: 'draft' });
    expect(readChannelDocumentDraft(localStorage, { ...identity, userId: 'user-2' }, 101)).toBeNull();
    expect(readChannelDocumentDraft(localStorage, { ...identity, teamId: 'team-2' }, 101)).toBeNull();
    expect(readChannelDocumentDraft(localStorage, { ...identity, documentId: 'document-2' }, 101)).toBeNull();
    expect(readChannelDocumentDraft(localStorage, { ...identity, baseRevisionId: 'revision-2' }, 101)).toBeNull();
  });

  test('七天后过期且不会恢复', () => {
    writeChannelDocumentDraft(localStorage, identity, {
      content: 'expired',
      filename: 'notes.md',
      updatedAt: 100,
    });

    expect(readChannelDocumentDraft(
      localStorage,
      identity,
      100 + CHANNEL_DOCUMENT_DRAFT_TTL_MS + 1,
    )).toBeNull();
  });

  test('可清除单个草稿或登出时清除全部频道文档草稿', () => {
    writeChannelDocumentDraft(localStorage, identity, {
      content: 'first',
      filename: 'notes.md',
      updatedAt: 100,
    });
    writeChannelDocumentDraft(localStorage, { ...identity, documentId: 'document-2' }, {
      content: 'second',
      filename: 'other.md',
      updatedAt: 100,
    });

    removeChannelDocumentDraft(localStorage, identity);
    expect(readChannelDocumentDraft(localStorage, identity, 101)).toBeNull();
    expect(readChannelDocumentDraft(localStorage, { ...identity, documentId: 'document-2' }, 101)).not.toBeNull();

    clearChannelDocumentDrafts(localStorage);
    expect(readChannelDocumentDraft(localStorage, { ...identity, documentId: 'document-2' }, 101)).toBeNull();
  });
});
