# THROWAWAY — Phase 5 system credential-store prototype

Question: can a background-safe adapter use the current OS user's native credential store without secrets in argv/environment/logs, distinguish stable failure states, isolate opaque profile references and recover immutable generations without a plaintext fallback?

Current executable evidence covers macOS arm64 Keychain Services. It uses `SecItem*` generic-password items with opaque account keys and `kSecUseAuthenticationUIFail`; secrets are generated inside the process. It probes the current user's Data Protection Keychain with `AfterFirstUnlockThisDeviceOnly`; the unsigned CLI identity returns missing-entitlement `OSStatus -34018`, mapped to `denied`. It separately verifies write/read-back, update/read-back, profile isolation and delete/not-found against the legacy current-user Keychain. A throwaway legacy keychain is used only to observe the no-prompt locked-state mapping; current macOS may conceal a locked item as `not_found`, so production cannot infer `absent` from that result without the real signed LaunchAgent session matrix. Every prototype item and scratch keychain is deleted in `defer` cleanup.

Run:

    npm run prototype:phase5-system-credential-macos
    npm run prototype:phase5-system-credential-linux
    npm run prototype:phase5-system-credential-windows

The Windows x64 probe calls Credential Manager `CredWriteW` / `CredReadW` / `CredDeleteW` with generic credentials and `CRED_PERSIST_LOCAL_MACHINE`. It verifies a binary envelope and scope, byte-exact immutable-generation read-back, crash-before-marker recovery through a non-secret current-user Registry marker, current-generation switching, old-generation cleanup, opaque profile isolation, rename-stable references, copy-without-reference and delete/not-found. GitHub-hosted Windows evidence is intentionally partial because `runneradmin` is an administrator and sleep/wake, logout/login and reboot cannot be driven as a normal desktop user in one job.

The Linux x64 probe compiles directly against native `libsecret`, starts an isolated Secret Service inside an ephemeral session D-Bus, and uses the default collection. It verifies the same envelope, immutable-generation, non-secret marker, cleanup and Profile-reference invariants without putting secrets in argv, environment variables or files. Hosted evidence remains partial because the temporary D-Bus/keyring is not the user's real GNOME/KDE systemd user session and cannot prove lock, sleep, logout or reboot recovery.

This does not yet prove LaunchAgent behavior across lock/sleep/logout/reboot, macOS authorization denial, Linux Secret Service or Windows Credential Manager. Those require their real user-service sessions; unavailable backends must remain explicit partial evidence rather than simulated Green.

Prototype-only implementation note: current SDKs deprecate both `kSecUseAuthenticationUIFail` in favor of an `LAContext` with interaction disabled and the `SecKeychain*` APIs used to manufacture the isolated lock case. Production code must use the modern no-interaction context and must not depend on the legacy scratch-keychain mechanism.
