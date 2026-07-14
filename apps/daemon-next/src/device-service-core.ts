export interface DeviceServiceComponent {
  start(): Promise<void>;
  stop?(): Promise<void> | void;
}

export interface DeviceServiceCore extends DeviceServiceComponent {
  readonly started: boolean;
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
  };
}
