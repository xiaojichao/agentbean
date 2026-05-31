import { describe, expect, it } from 'vitest';
import { messageSpeakerName } from '../lib/display-names';

describe('messageSpeakerName', () => {
  it('does not use the current user name for other human senders', () => {
    const agents = {};
    const sources = {
      currentUser: { id: 'new-user', username: 'newbie' },
      humanProfiles: [
        { id: 'admin', username: 'admin' },
        { id: 'new-user', username: 'newbie' },
      ],
    };

    expect(messageSpeakerName({ senderKind: 'human', senderId: 'admin' }, agents, sources)).toBe('admin');
    expect(messageSpeakerName({ senderKind: 'human', senderId: 'new-user' }, agents, sources)).toBe('newbie');
  });

  it('uses channel agent members when the live agent snapshot is missing', () => {
    const agents = {};
    const sources = {
      channelMembers: [
        { id: 'agent-1', name: 'Hermes-Agent-xiao-mini', kind: 'agent' as const },
      ],
    };

    expect(messageSpeakerName({ senderKind: 'agent', senderId: 'agent-1' }, agents, sources))
      .toBe('Hermes-Agent-xiao-mini');
  });

  it('uses persisted sender metadata when no live agent source is available', () => {
    const agents = {};
    const msg = {
      senderKind: 'agent',
      senderId: 'agent-1',
      metaJson: JSON.stringify({ senderName: 'Hermes-Agent-xiao-mini' }),
    };

    expect(messageSpeakerName(msg, agents)).toBe('Hermes-Agent-xiao-mini');
  });
});
