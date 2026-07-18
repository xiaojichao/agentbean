# Phase 5 Service operations prototype

Throwaway evidence for #668. It does not modify the production CLI or Web page.

Run:

    npm run prototype:phase5-service-operations

The command asserts the CLI/state/action contract and writes:

- phase5-service-operations-evidence/evidence.json
- phase5-service-operations-evidence/index.html

Open the HTML file locally to review the existing Web Device page extension. Web
actions only copy local CLI recovery commands; install, migration, credential,
update, rollback, diagnostics upload, uninstall, and purge never become remote
browser commands.
