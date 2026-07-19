export interface DeviceServiceComponent {
  start(): Promise<void>;
  beginDrain?(deadlineMs: number): Promise<void> | void;
  stop?(): Promise<void> | void;
  activeWorkCount?(): number;
  outboxPendingCount?(): number;
}

export interface DeviceServiceCore extends DeviceServiceComponent {
  readonly started: boolean;
  beginDrain(deadlineMs: number): Promise<void>;
  activeWorkCount(): number;
  outboxPendingCount(): number;
}

export interface CreateDeviceServiceCoreInput {
  readonly dispatchClient: DeviceServiceComponent;
  readonly taskClaimClient?: DeviceServiceComponent;
  readonly managementWorkerHost: DeviceServiceComponent;
}

export function createDeviceServiceCore(input: CreateDeviceServiceCoreInput): DeviceServiceCore {
  let started = false;

  return {
    get started() {
      return started;
    },
    async start() {
      if (started) return;
      await input.dispatchClient.start();
      try {
        await input.taskClaimClient?.start();
      } catch (error) {
        await input.dispatchClient.stop?.();
        throw error;
      }
      try {
        await input.managementWorkerHost.start();
        started = true;
      } catch (error) {
        await input.taskClaimClient?.stop?.();
        await input.dispatchClient.stop?.();
        throw error;
      }
    },
    async beginDrain(deadlineMs) {
      await Promise.all([
        input.dispatchClient.beginDrain?.(deadlineMs),
        input.taskClaimClient?.beginDrain?.(deadlineMs),
        input.managementWorkerHost.beginDrain?.(deadlineMs),
      ]);
    },
    async stop() {
      if (!started) return;
      started = false;
      try {
        await input.managementWorkerHost.stop?.();
      } finally {
        try {
          await input.taskClaimClient?.stop?.();
        } finally {
          await input.dispatchClient.stop?.();
        }
      }
    },
    activeWorkCount() {
      return [input.dispatchClient, input.taskClaimClient, input.managementWorkerHost]
        .reduce((sum, component) => sum + (component?.activeWorkCount?.() ?? 0), 0);
    },
    outboxPendingCount() {
      return [input.dispatchClient, input.taskClaimClient, input.managementWorkerHost]
        .reduce((sum, component) => sum + (component?.outboxPendingCount?.() ?? 0), 0);
    },
  };
}
