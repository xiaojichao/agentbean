export type MessageSendMode = 'enter' | 'mod-enter';
export type AttachmentOpenMode = 'inline' | 'new-tab' | 'download';

export interface BrowserSettings {
  desktopNotifications: boolean;
  sound: boolean;
  compactMode: boolean;
  messageSendMode: MessageSendMode;
  attachmentOpenMode: AttachmentOpenMode;
}

export const BROWSER_SETTINGS_STORAGE_KEY = 'agentbean.browserSettings.v1';

export const DEFAULT_BROWSER_SETTINGS: BrowserSettings = {
  desktopNotifications: true,
  sound: true,
  compactMode: false,
  messageSendMode: 'mod-enter',
  attachmentOpenMode: 'inline',
};

interface BrowserSettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function readBrowserSettings(storage: BrowserSettingsStorage | null | undefined): BrowserSettings {
  if (!storage) return { ...DEFAULT_BROWSER_SETTINGS };
  const raw = storage.getItem(BROWSER_SETTINGS_STORAGE_KEY);
  if (!raw) return { ...DEFAULT_BROWSER_SETTINGS };

  try {
    const parsed = JSON.parse(raw) as Partial<BrowserSettings>;
    return normalizeBrowserSettings(parsed);
  } catch {
    return { ...DEFAULT_BROWSER_SETTINGS };
  }
}

export function writeBrowserSettings(
  storage: BrowserSettingsStorage | null | undefined,
  settings: BrowserSettings,
): void {
  if (!storage) return;
  storage.setItem(BROWSER_SETTINGS_STORAGE_KEY, JSON.stringify(normalizeBrowserSettings(settings)));
}

export function resetBrowserSettings(storage: BrowserSettingsStorage | null | undefined): BrowserSettings {
  if (storage) storage.removeItem(BROWSER_SETTINGS_STORAGE_KEY);
  return { ...DEFAULT_BROWSER_SETTINGS };
}

export function normalizeBrowserSettings(input: Partial<BrowserSettings>): BrowserSettings {
  return {
    desktopNotifications: typeof input.desktopNotifications === 'boolean'
      ? input.desktopNotifications
      : DEFAULT_BROWSER_SETTINGS.desktopNotifications,
    sound: typeof input.sound === 'boolean' ? input.sound : DEFAULT_BROWSER_SETTINGS.sound,
    compactMode: typeof input.compactMode === 'boolean' ? input.compactMode : DEFAULT_BROWSER_SETTINGS.compactMode,
    messageSendMode: input.messageSendMode === 'enter' || input.messageSendMode === 'mod-enter'
      ? input.messageSendMode
      : DEFAULT_BROWSER_SETTINGS.messageSendMode,
    attachmentOpenMode: input.attachmentOpenMode === 'inline'
      || input.attachmentOpenMode === 'new-tab'
      || input.attachmentOpenMode === 'download'
      ? input.attachmentOpenMode
      : DEFAULT_BROWSER_SETTINGS.attachmentOpenMode,
  };
}
