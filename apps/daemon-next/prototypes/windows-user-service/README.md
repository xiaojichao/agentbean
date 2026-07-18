# THROWAWAY — Phase 5 Windows user service prototype

Question: can a non-elevated per-user MSI register one Task Scheduler 2.0 `InteractiveToken` logon task for the current SID, enforce `IgnoreNew`, restart after failure, expose a current-user-only named pipe, and preserve durable state when the controller drains before calling the scheduler's immediate `Stop(0)`?

Run in a normal, non-elevated Windows x64 desktop session:

    npm run prototype:phase5-windows-service

The command builds a self-contained throwaway worker and a WiX 4.0.6 per-user MSI, installs the payload under `%LOCALAPPDATA%`, then registers and starts the AtLogOn task from the current user's interactive caller after `msiexec` returns. It exercises single-instance behavior, active-work drain, durable outbox flush, immediate scheduler stop and bounded crash restart, then unregisters and uninstalls everything. The task action is a minimal Windows platform adapter which starts the Device Service worker and performs five bounded one-minute restarts. It assigns the worker tree to a Windows Job Object with `KILL_ON_JOB_CLOSE`, because hosted evidence showed that stopping the Task Scheduler action alone leaves its child worker alive. Hosted Windows evidence also proved that Task Scheduler records a native action's non-zero exit (`LastTaskResult=17`) but does not apply `RestartOnFailure` to that completion, so the XML setting remains only a scheduler-level fallback and is not the process-crash recovery contract. Windows stop uses two disable layers: first persist AgentBean `desired=disabled` so the platform adapter will not restart the worker, then drain and fsync over the pipe and let the worker exit cleanly, and only then set the scheduler task `Enabled=false` and call `Stop(0)`. Setting the scheduler bit before drain terminates the running action (`0x800710E0`), while stopping an enabled task can enter the XML retry window and make `IgnoreNew` reject an immediate restart. Restart therefore uses desired-disable → drain/worker-exit → scheduler-disable/stop → desired-enable → scheduler-enable/run. The MSI deliberately contains no Task Scheduler custom action: hosted Windows evidence showed that both combined register/start and register-only execute-sequence actions fail with Windows Installer 1721, while the exact same signed-location executable succeeds from the interactive caller. WiX 4 is pinned so this throwaway validation does not require accepting the WiX 7 OSMF EULA.

The JSON verdict is Green only when the host is a non-administrator interactive session. A GitHub-hosted `windows-latest` run is useful for MSI/COM/schema smoke but remains partial because its `runneradmin` identity is not the ordinary-user acceptance environment. Sleep/wake, logout/login and reboot require follow-up checks on a disposable Windows 11 x64 machine.

For that real-session gate, keep the prototype installed across session transitions:

    npm run prototype:phase5-windows-service-session -- -Action install
    npm run prototype:phase5-windows-service-session -- -Action check -Checkpoint wake
    npm run prototype:phase5-windows-service-session -- -Action check -Checkpoint login
    npm run prototype:phase5-windows-service-session -- -Action check -Checkpoint reboot
    npm run prototype:phase5-windows-service-session -- -Action remove

Run `install` from a normal non-administrator Windows 11 x64 desktop account without elevation. Put the machine to sleep and wake it before the `wake` check; sign out/in before `login`; reboot and sign in before `reboot`. Each check appends durable JSONL evidence under `%LOCALAPPDATA%\AgentBean\DeviceServicePrototype\session-evidence.jsonl`. `remove` unregisters the task and uninstalls the per-user payload; it intentionally preserves the state/evidence files for inspection.

This prototype intentionally does not enter production or implement the Device Service Supervisor. It exists only to freeze the Task XML/COM and two-phase stop contract for #676.
