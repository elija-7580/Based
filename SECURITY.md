# Security policy

Based keeps people's notes and databases. Security reports are taken seriously and handled before anything else.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

- Preferred: GitHub's private reporting — [Report a vulnerability](https://github.com/elija-7580/Based/security/advisories/new)
- Or by email: **hello@basednotes.app** with the subject `SECURITY`

Please include what is affected (app, `based-server`, website, CLI, MCP), the version or commit, steps to reproduce
and the impact you see. A proof of concept helps, but is not required.

## What happens next

| Step | Target time |
|---|---|
| Confirmation that the report arrived | within 3 days |
| First assessment (severity, affected versions) | within 7 days |
| Fix for critical issues (data loss, data leak, remote code execution) | as fast as possible, aim: 14 days |
| Fix for other issues | in a following release |

You will be kept informed while the issue is open. After a fix has shipped, the issue is published as a GitHub
Security Advisory, and you are credited by name if you want.

## Scope

In scope: everything in this repository — the apps (`apps/web`, `apps/desktop`, `apps/cli`), `based-server`
(`apps/server`, `deploy/`), the packages in `packages/`, the website and waitlist (`apps/website`), and the sync and
sharing protocols (`docs/sync-protocol.md`, `docs/sharing.md`).

Out of scope: denial of service by sheer volume, social engineering, reports from automated scanners without a
demonstrated impact, and problems in third-party services.

## Supported versions

Based is in beta. Only the latest beta release and `main` receive security fixes.

## Safe harbour

Research done in good faith — no access to other people's data, no data destruction, no service disruption, and a
reasonable time for a fix before going public — will not lead to legal steps from the project.
