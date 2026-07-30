/**
 * #930 daemon 兼容层：capability negotiation 合同。
 *
 * daemon 在 cutover 后不得创建 coordination job / 取得 PI orchestration authority；
 * 仅可 message + 合法 drain（旧协议）或领取执行（新协议）。
 */
import { describe, expect, test } from 'vitest';
import { negotiateDaemonPiCapabilities } from '../../../packages/domain/src/pi-authority-cutover-policy.js';

describe('daemon PI capability negotiation after Team cutover', () => {
  test('legacy protocol daemon: message + drain only', () => {
    const n = negotiateDaemonPiCapabilities({
      daemonProtocolVersion: 1,
      advertisedCapabilities: ['message.send', 'legacy.drain', 'coordination.job.create'],
      teamMigrationState: 'new_authority',
      legacyWriterFenced: true,
      minPiExecutionProtocolVersion: 2,
    });
    expect(n.mayCreateCoordinationJob).toBe(false);
    expect(n.mayObtainPiOrchestrationAuthority).toBe(false);
    expect(n.mayDrainLegacyWork).toBe(true);
    expect(n.maySendMessages).toBe(true);
    expect(n.mayClaimPiExecution).toBe(false);
    expect(n.grantedTier).toBe('message_and_drain_only');
  });

  test('current protocol daemon may claim execution but never owns orchestration', () => {
    const n = negotiateDaemonPiCapabilities({
      daemonProtocolVersion: 2,
      advertisedCapabilities: [
        'message.send',
        'legacy.drain',
        'pi.orchestration.claim',
        'pi.create_root_task',
      ],
      teamMigrationState: 'new_authority',
      legacyWriterFenced: true,
    });
    expect(n.mayClaimPiExecution).toBe(true);
    expect(n.mayObtainPiOrchestrationAuthority).toBe(false);
    expect(n.mayCreateCoordinationJob).toBe(false);
    expect(n.grantedTier).toBe('pi_execution_eligible');
  });

  test('daemon upgrade failure does not unfence Team legacy writer', () => {
    const n = negotiateDaemonPiCapabilities({
      daemonProtocolVersion: 0,
      advertisedCapabilities: [],
      teamMigrationState: 'legacy_read_only',
      legacyWriterFenced: true,
    });
    expect(n.legacyWriterFenced).toBe(true);
    expect(n.mayCreateCoordinationJob).toBe(false);
    expect(n.teamMigrationState).toBe('legacy_read_only');
  });

  test('pre-cutover Team still allows legacy coordination jobs for old daemons', () => {
    const n = negotiateDaemonPiCapabilities({
      daemonProtocolVersion: 1,
      advertisedCapabilities: ['coordination.job.create', 'message.send'],
      teamMigrationState: 'legacy',
      legacyWriterFenced: false,
    });
    expect(n.mayCreateCoordinationJob).toBe(true);
    expect(n.mayObtainPiOrchestrationAuthority).toBe(false);
    expect(n.grantedTier).toBe('legacy_full_coordination');
  });
});
