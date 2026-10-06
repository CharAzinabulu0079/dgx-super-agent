# Contributing

Thanks for helping. This repository is a **harness**: it owns state, policy, verification and
observation around one agent core. The core itself is a dependency, not a fork.

## Before you start

```bash
pnpm install
pnpm build
pnpm check      # typecheck + tests + architecture drift + repo hygiene
```

`pnpm check` must be green on your machine before you open a PR. For changes that touch browser or
E2E behaviour, also run `pnpm test:evals` (needs `npx playwright install chromium`).

## Ground rules

1. **Do not patch the agent core.** `@deepseek-ai/dsh` stays unmodified; extensions go through the
   documented seams (profiles, the bundle, `--patch` overlays, tool registration). A change that
   requires a core patch needs an ADR first, in the PR description.
2. **Gates before features.** Every behaviour change ships with a test that fails without your fix.
   Bug fixes need a red → green pair, not just green.
3. **Deterministic verification stays deterministic.** Gates are commands; a model may not decide
   that a task passed. Do not add paths where a Worker's own claim is sufficient.
4. **No secrets, no large binaries.** `pnpm hygiene` blocks both before commit — don't work around it.
5. **Docs follow code.** If you change a user-facing command, env var or gate, update `README.md`,
   `CHANGELOG.md` or `docs/` accordingly.

## Commit messages

Imperative, lowercase first line, scoped:

```
verifier: refuse a gate whose script changed after the run
ui: keep the phone bottom bar reachable with long task types
```

## Pull requests

- One concern per PR; keep it reviewable.
- Describe *what* changed and *how it was verified* (the command you ran and its result).
- Tick the checklist in the PR template.
- Expect review questions about the verification story — that is the point of this project.

## Issues

- **Bug**: use the bug template, include the exact command, the output, and your OS/arch.
- **Feature**: use the feature template; say which gate or loop the feature would change, if any.
- **Security**: never open a public issue for a vulnerability — see [`SECURITY.md`](SECURITY.md).

## Code of conduct

By contributing you agree to the [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
