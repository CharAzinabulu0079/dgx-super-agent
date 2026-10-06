## What changed

<!-- One concern per PR. Link the issue if there is one. -->

## Why

<!-- The problem, not the implementation. -->

## How it was verified

<!-- The exact command(s) you ran and the result. A bug fix needs a red → green pair:
     state what you did to see it fail on the pre-change code. -->

```
```

## Checklist

- [ ] `pnpm check` passes locally
- [ ] New behaviour has a test that fails without this change
- [ ] No secrets, tokens or large binaries added (`pnpm hygiene` stays green)
- [ ] User-facing commands / env vars / gates documented (`README.md`, `CHANGELOG.md`, `docs/`)
- [ ] This does not patch `@deepseek-ai/dsh`, or an ADR explains why it must
