import { describe, expect, test, vi } from 'vitest';
import { WEB_EVENTS } from '../../../packages/contracts/src/index';
import { createDispatchSocketProjection } from '../src/transport/dispatch-socket-projection';

describe('Dispatch socket projection', () => {
  test('projects status, visible Message, Agent snapshot, and Memory in order', async () => {
    const events: Array<{ event: string; payload: unknown }> = [];
    const subscribers = new Set([
      {
        socket: { emit: (event: string, payload: unknown) => events.push({ event, payload }) },
        channels: { userId: 'user-1', teamId: 'team-1' },
        agents: { userId: 'user-1', teamId: 'team-1' },
      },
    ]);
    const listChannels = vi.fn().mockResolvedValue({
      ok: true,
      channels: [{ id: 'channel-1' }],
    });
    const listDirectMessages = vi.fn();
    const listVisibleAgents = vi.fn().mockResolvedValue({
      ok: true,
      agents: [{ id: 'agent-1', status: 'busy' }],
    });
    const projection = createDispatchSocketProjection(subscribers, {
      listChannels,
      listDirectMessages,
      listVisibleAgents,
    });
    const dispatch = { id: 'dispatch-1', teamId: 'team-1', status: 'running' };
    const message = { id: 'message-1', teamId: 'team-1', channelId: 'channel-1' };

    await projection.handleMutation(
      'agent-report',
      { teamId: 'team-1' },
      { ok: true, dispatch, message },
    );

    expect(events).toEqual([
      { event: WEB_EVENTS.message.dispatchStatus, payload: dispatch },
      { event: WEB_EVENTS.channel.message, payload: message },
      { event: WEB_EVENTS.agent.snapshot, payload: [{ id: 'agent-1', status: 'busy' }] },
      { event: WEB_EVENTS.agent.status, payload: { id: 'agent-1', status: 'busy' } },
      { event: WEB_EVENTS.memory.changed, payload: { teamId: 'team-1' } },
    ]);
    expect(listChannels).toHaveBeenCalledTimes(2);
    expect(listDirectMessages).not.toHaveBeenCalled();
    expect(listVisibleAgents).toHaveBeenCalledWith({ teamId: 'team-1' });
  });

  test('deduplicates batch Dispatch and Team projections while Task owns Memory invalidation', async () => {
    const firstEvents: Array<{ event: string; payload: unknown }> = [];
    const secondEvents: Array<{ event: string; payload: unknown }> = [];
    const subscribers = new Set([
      {
        socket: { emit: (event: string, payload: unknown) => firstEvents.push({ event, payload }) },
        agents: { userId: 'user-1', teamId: 'team-1' },
      },
      {
        socket: { emit: (event: string, payload: unknown) => secondEvents.push({ event, payload }) },
        agents: { userId: 'user-2', teamId: 'team-1' },
      },
    ]);
    const listVisibleAgents = vi.fn().mockResolvedValue({ ok: true, agents: [] });
    const projection = createDispatchSocketProjection(subscribers, {
      listChannels: vi.fn().mockResolvedValue({ ok: true, channels: [] }),
      listDirectMessages: vi.fn().mockResolvedValue({ ok: true, dms: [] }),
      listVisibleAgents,
    });
    const dispatch = { id: 'dispatch-1', teamId: 'team-1', status: 'cancelled' };

    await projection.handleMutation(
      'web-command',
      { teamId: 'team-1', targetTeamId: 'team-1' },
      {
        ok: true,
        dispatch,
        dispatches: [dispatch, { id: 'dispatch-2', teamId: 'team-1', status: 'cancelled' }],
        tasks: [{ id: 'task-1', teamId: 'team-1' }],
      },
    );

    expect(firstEvents).toEqual([
      { event: WEB_EVENTS.message.dispatchStatus, payload: dispatch },
      {
        event: WEB_EVENTS.message.dispatchStatus,
        payload: { id: 'dispatch-2', teamId: 'team-1', status: 'cancelled' },
      },
      { event: WEB_EVENTS.agent.snapshot, payload: [] },
    ]);
    expect(secondEvents).toEqual(firstEvents);
    expect(listVisibleAgents).toHaveBeenCalledTimes(1);
    expect(firstEvents).not.toContainEqual({
      event: WEB_EVENTS.memory.changed,
      payload: { teamId: 'team-1' },
    });
  });

  test('does not reproject the Message already owned by message-send', async () => {
    const events: Array<{ event: string; payload: unknown }> = [];
    const listChannels = vi.fn();
    const projection = createDispatchSocketProjection(new Set([
      {
        socket: { emit: (event: string, payload: unknown) => events.push({ event, payload }) },
        channels: { userId: 'user-1', teamId: 'team-1' },
      },
    ]), {
      listChannels,
      listDirectMessages: vi.fn(),
      listVisibleAgents: vi.fn(),
    });
    const dispatch = { id: 'dispatch-1', teamId: 'team-1', status: 'queued' };

    await projection.handleMutation('message-send', { teamId: 'team-1' }, {
      ok: true,
      dispatches: [dispatch],
      message: { id: 'message-1', teamId: 'team-1', channelId: 'channel-1' },
    });

    expect(events).toEqual([
      { event: WEB_EVENTS.message.dispatchStatus, payload: dispatch },
      { event: WEB_EVENTS.memory.changed, payload: { teamId: 'team-1' } },
    ]);
    expect(listChannels).not.toHaveBeenCalled();
  });

  test('enforces Message visibility and ignores failed or Team-less results', async () => {
    const channelEvents: Array<{ event: string; payload: unknown }> = [];
    const unrelatedEvents: Array<{ event: string; payload: unknown }> = [];
    const subscribers = new Set([
      {
        socket: { emit: (event: string, payload: unknown) => channelEvents.push({ event, payload }) },
        channels: { userId: 'user-1', teamId: 'team-1' },
      },
      {
        socket: { emit: (event: string, payload: unknown) => unrelatedEvents.push({ event, payload }) },
        channels: { userId: 'user-2', teamId: 'team-2' },
      },
    ]);
    const listChannels = vi.fn(async (input: { userId: string }) => ({
      ok: true,
      channels: input.userId === 'user-1' ? [] : [{ id: 'dm-1' }],
    }));
    const listDirectMessages = vi.fn().mockResolvedValue({
      ok: true,
      dms: [{ channel: { id: 'dm-1' } }],
    });
    const listVisibleAgents = vi.fn();
    const projection = createDispatchSocketProjection(subscribers, {
      listChannels,
      listDirectMessages,
      listVisibleAgents,
    });
    const message = { id: 'message-1', teamId: 'team-1', channelId: 'dm-1' };

    await projection.handleMutation('agent-report', {}, { ok: false, error: 'CONFLICT' });
    await projection.handleMutation('agent-report', {}, { ok: true, dispatch: { id: 'dispatch-no-team' } });
    await projection.handleMutation('agent-report', {}, {
      ok: true,
      dispatch: { id: 'dispatch-1', teamId: 'team-1', status: 'running' },
      message,
    });

    expect(channelEvents).toEqual([
      {
        event: WEB_EVENTS.message.dispatchStatus,
        payload: { id: 'dispatch-1', teamId: 'team-1', status: 'running' },
      },
      { event: WEB_EVENTS.channel.message, payload: message },
      { event: WEB_EVENTS.memory.changed, payload: { teamId: 'team-1' } },
    ]);
    expect(unrelatedEvents).toEqual([]);
    expect(listDirectMessages).toHaveBeenCalledTimes(1);
    expect(listVisibleAgents).not.toHaveBeenCalled();
  });
});
