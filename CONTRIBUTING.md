# Contributing to Based

Thanks for wanting to help. Code is one way. Others count just as much:

- **Test the beta** and tell us what breaks or what you miss (⇧⌘B in the app, or hello@basednotes.app).
- **Add ideas and vote** on the [public roadmap](https://basednotes.app/roadmap).
- **Sponsor Based** on [GitHub Sponsors](https://github.com/sponsors/elija-7580). Donations pay for the servers; every feature stays free for everyone.

A few things before your first pull request:

1. **License:** Based is AGPL-3.0-or-later ([`LICENSE`](LICENSE)). Your contribution is released under it.
2. **CLA:** external contributions need the Contributor License Agreement ([`CLA.md`](CLA.md)). A bot asks you to sign it on
   your first pull request (one comment). You keep your copyright.
3. **Clean room:** only public Notion help docs as a source. No Notion code, assets or reverse engineering.
4. **Security problems** go privately to [`SECURITY.md`](SECURITY.md), not into an issue.
5. **Name:** forks need their own name, see [`TRADEMARK.md`](TRADEMARK.md).

Setup, layout and checks are in the [`README`](README.md); rules for code and design in [`AGENTS.md`](AGENTS.md).
Before a pull request: `ci/typecheck/run-ts.sh --fast` must be green.
