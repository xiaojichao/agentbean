export const PI_CONFIGURATION_READINESS_CHANGED_EVENT = 'agentbean:pi-configuration-readiness-changed';

export function announcePiConfigurationReadinessChanged(): void {
  window.dispatchEvent(new Event(PI_CONFIGURATION_READINESS_CHANGED_EVENT));
}
