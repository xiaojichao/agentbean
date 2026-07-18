# Phase 5 diagnostics redaction prototype

Throwaway evidence for #678. It does not implement the production Device Service.

Run one command:

\`\`\`bash
npm run prototype:phase5-diagnostics
\`\`\`

The probe:

- writes only schema-v1 allowlisted events and quarantines unknown fields, versions,
  free text, and control characters;
- injects token, Bearer/JWT, cookie, PEM, URL, path, Workspace, Memory, header, and
  control-character canaries;
- generates a real Node diagnostic report containing argv/environment canaries,
  derives a bounded allowlist crash summary, excludes and deletes the raw report;
- enforces 7-day/32-MiB log rotation, 256-KiB crash summary, 5-MiB entry,
  25-MiB bundle, 24-hour local, and 14-day server limits;
- checks current-user filesystem protection, a source-scoped native log query,
  byte-for-byte canary absence, no-TTY denial, hash mutation denial, nonce replay,
  cancellation, and early server deletion.

The generated verdict is intentionally partial. GitHub-hosted jobs are not a signed
macOS LaunchAgent, a real Linux systemd user login service, or a Windows
\`InteractiveToken\` desktop login. Sleep/wake, logout/login, reboot, actual native
crash artifacts, and production upload/storage still require those installed
environments.
