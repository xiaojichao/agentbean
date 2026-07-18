# THROWAWAY — Phase 5 system credential-store prototype

Question: can a background-safe adapter use the current OS user's native credential store without secrets in argv/environment/logs, distinguish stable failure states, isolate opaque profile references and recover immutable generations without a plaintext fallback?

Current executable evidence covers macOS arm64 Keychain Services. It uses `SecItem*` generic-password items with opaque account keys and `kSecUseAuthenticationUIFail`; secrets are generated inside the process. It probes the current user's Data Protection Keychain with `AfterFirstUnlockThisDeviceOnly`; the unsigned CLI identity returns missing-entitlement `OSStatus -34018`, mapped to `denied`. It separately verifies write/read-back, update/read-back, profile isolation and delete/not-found against the legacy current-user Keychain. A throwaway legacy keychain is used only to observe the no-prompt locked-state mapping; current macOS may conceal a locked item as `not_found`, so production cannot infer `absent` from that result without the real signed LaunchAgent session matrix. Every prototype item and scratch keychain is deleted in `defer` cleanup.

Run:

    npm run prototype:phase5-system-credential-macos

This does not yet prove LaunchAgent behavior across lock/sleep/logout/reboot, macOS authorization denial, Linux Secret Service or Windows Credential Manager. Those require their real user-service sessions; unavailable backends must remain explicit partial evidence rather than simulated Green.

Prototype-only implementation note: current SDKs deprecate both `kSecUseAuthenticationUIFail` in favor of an `LAContext` with interaction disabled and the `SecKeychain*` APIs used to manufacture the isolated lock case. Production code must use the modern no-interaction context and must not depend on the legacy scratch-keychain mechanism.
