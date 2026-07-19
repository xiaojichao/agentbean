export interface PlatformCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface PlatformServiceStatus {
  readonly installed: boolean;
  readonly loaded: boolean;
  readonly running: boolean;
  readonly queryFailed: boolean;
}

export interface PlatformServiceAdapter {
  bootstrap(): Promise<PlatformCommandResult>;
  start(): Promise<PlatformCommandResult>;
  kill(): Promise<PlatformCommandResult>;
  bootout(): Promise<PlatformCommandResult>;
  status(): Promise<PlatformServiceStatus>;
}
