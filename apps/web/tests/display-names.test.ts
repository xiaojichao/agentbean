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
});
