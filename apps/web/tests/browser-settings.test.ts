import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BROWSER_SETTINGS_STORAGE_KEY,
  DEFAULT_BROWSER_SETTINGS,
  readBrowserSettings,
  resetBrowserSettings,
  writeBrowserSettings,
} from '../lib/browser-settings';

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const settingsPage = readFileSync(new URL('../app/[networkPath]/settings/page.tsx', import.meta.url), 'utf8');

describe('browser settings preferences', () => {
  it('reads defaults when no browser settings are stored', () => {
    expect(readBrowserSettings(new MemoryStorage())).toEqual(DEFAULT_BROWSER_SETTINGS);
  });

  it('normalizes stored settings and ignores unknown option values', () => {
    const storage = new MemoryStorage();
    storage.setItem(BROWSER_SETTINGS_STORAGE_KEY, JSON.stringify({
      desktopNotifications: false,
      sound: false,
      compactMode: true,
      messageSendMode: 'space',
      attachmentOpenMode: 'teleport',
    }));

    expect(readBrowserSettings(storage)).toEqual({
      ...DEFAULT_BROWSER_SETTINGS,
      desktopNotifications: false,
      sound: false,
      compactMode: true,
    });
  });

  it('writes and resets browser settings through the shared storage key', () => {
    const storage = new MemoryStorage();
    writeBrowserSettings(storage, {
      ...DEFAULT_BROWSER_SETTINGS,
      messageSendMode: 'enter',
      attachmentOpenMode: 'download',
    });

    expect(JSON.parse(storage.getItem(BROWSER_SETTINGS_STORAGE_KEY) ?? '{}')).toMatchObject({
      messageSendMode: 'enter',
      attachmentOpenMode: 'download',
    });
    expect(resetBrowserSettings(storage)).toEqual(DEFAULT_BROWSER_SETTINGS);
    expect(storage.getItem(BROWSER_SETTINGS_STORAGE_KEY)).toBeNull();
  });
});

describe('settings browser tab', () => {
  it('renders real browser preference controls instead of the old placeholder', () => {
    expect(settingsPage).toContain('桌面通知');
    expect(settingsPage).toContain('提示音');
    expect(settingsPage).toContain('紧凑布局');
    expect(settingsPage).toContain('发送消息');
    expect(settingsPage).toContain('打开附件');
    expect(settingsPage).not.toContain('浏览器相关配置开发中');
  });
});
