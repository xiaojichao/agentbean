# THROWAWAY — Phase 5 Windows user service prototype

Question: can a non-elevated per-user MSI register one Task Scheduler 2.0 `InteractiveToken` logon task for the current SID, enforce `IgnoreNew`, restart after failure, expose a current-user-only named pipe, and preserve durable state when the controller drains before calling the scheduler's immediate `Stop(0)`?

Run in a normal, non-elevated Windows x64 desktop session:

    npm run prototype:phase5-windows-service

The command builds a self-contained throwaway worker and a WiX 4.0.6 per-user MSI, installs under `%LOCALAPPDATA%`, registers the AtLogOn task during MSI execution, starts it from the interactive caller after `msiexec` returns, exercises single-instance behavior, active-work drain, durable outbox flush, immediate scheduler stop and bounded crash restart, then uninstalls and removes scratch files. Registration and immediate start are deliberately separate because an MSI execute-sequence custom action does not provide a reliable interactive session for `InteractiveToken` startup. WiX 4 is pinned so this throwaway validation does not require accepting the WiX 7 OSMF EULA.

The JSON verdict is Green only when the host is a non-administrator interactive session. A GitHub-hosted `windows-latest` run is useful for MSI/COM/schema smoke but remains partial because its `runneradmin` identity is not the ordinary-user acceptance environment. Sleep/wake, logout/login and reboot require follow-up checks on a disposable Windows 11 x64 machine.

This prototype intentionally does not enter production or implement the Device Service Supervisor. It exists only to freeze the Task XML/COM and two-phase stop contract for #676.
