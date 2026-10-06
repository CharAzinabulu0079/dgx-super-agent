# DGX Super Agent

**A modular autonomous agent harness for long-running work, loop engineering, architecture
observability and digital human integration.**

Deploy it on your own machine — a DGX Spark is its intended home — and it becomes the **hands of
your digital human or assistant**: say what you want in one sentence, and it plans the work, runs it,
verifies it and reports back. It keeps going for hours without you babysitting it, and stops to ask
only when the decision is genuinely yours.

It is not a chat agent that grades its own homework. A **Chief** plans your request into verifiable
tasks, **Workers** loop until independent gates pass, and nothing counts as done until a
deterministic check says so — never because the model claims it is.

[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.19-brightgreen.svg)](package.json)
[![pnpm](https://img.shields.io/badge/pnpm-11.7-orange.svg)](https://pnpm.io)
[![CI](https://github.com/CharAzinabulu0079/dgx-super-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/CharAzinabulu0079/dgx-super-agent/actions/workflows/ci.yml)

---

## How verification works

Verification here is a **separate, non-model layer**:

- gates are **commands** (`node --test`, `npm test`, `arch`), not opinions;
- **held-out tests** live outside the worktree and are invisible to the Worker;
- a Worker's claim of success is recorded and **overruled** whenever a gate fails;
- genuinely risky or preference-dependent calls stop at a **Human Gate** and wait for you.

## Highlights

| | |
|---|---|
| **Verifiable-by-default loop** | Plan → Execute → Verify → Retry → Report, with failure-signature breaking so a Worker cannot retry the same broken thing forever |
| **Held-out gates** | Acceptance tests the model never sees, mounted into a throwaway tree at verification time |
| **Human Gates** | Dangerous tool calls stop at an explicit human decision inside the agent core |
| **One core, plugins only** | DeepSeek Harness (MIT) consumed unmodified from npm — **zero core patches** |
| **Client-agnostic core** | Headless: the Web/PWA and phone UI are only clients — a digital human page can already be embedded as its background (`docs/DIGITAL_HUMAN_BACKGROUND.md`) |
| **Architecture Observatory** | Any repo gets a machine-generated map (`.architecture/`) plus declared-vs-detected drift checks |
| **Real-browser checks** | Playwright-driven E2E as a first-class verification gate |
| **Model policy per role** | Chief / planner / reviewer / Worker each get their own model — cloud or local OpenAI-compatible |
| **Web + phone UI** | One-box request UI, live Worker transcripts, file sharing, terminal |
| **Red-team suite** | 22 adversarial scenarios that must all fail closed (`pnpm redteam`) |

## Requirements

- **Node ≥ 22.19** (22.x LTS or newer) — the harness runs TypeScript natively
- **pnpm 11.7.0** — `corepack enable && corepack prepare pnpm@11.7.0 --activate`
- **git** (architecture + change detection)
- **Chromium** — only for browser Workers and E2E gates: `npx playwright install chromium`
- Linux (**x86_64 or aarch64** — a DGX Spark is the intended home) or macOS. Build tools (`python3`, `make`, `g++`) are the fallback if a native addon
  (`node-pty`, `koffi`, `sharp`) has no prebuilt binary for your platform.

## Quick start

```bash
git clone https://github.com/CharAzinabulu0079/dgx-super-agent.git
cd dgx-super-agent

pnpm install     # frozen lockfile, pins @deepseek-ai/dsh 0.1.7-rc.2
pnpm build       # UI (superagent/ui) + DSH bundle (superagent/dsh-bundle)
pnpm check       # typecheck + tests + architecture drift + repo hygiene
pnpm smoke:dsh   # the core boots and runs a session with File + Shell tools (keyless mock)
```

Then start it:

```bash
pnpm sa dsh setup        # create the Worker / Chief DSH profiles under $SUPERAGENT_HOME
pnpm sa serve --browser  # API + UI on http://127.0.0.1:7788, prints a one-time human link
```

Open the printed link, **Add project** (an absolute path — test / E2E / architecture checks are
detected automatically), type what you want, press **Go**.

The same thing from the CLI:

```bash
pnpm sa do /abs/path/to/myapp "the signup form should reject emails without an @" --review
```

### Point it at a model

Create `$SUPERAGENT_HOME/model-routes.json` with an OpenAI-compatible or Anthropic route, then assign
per-role policies:

```bash
pnpm sa policy set worker    local-default
pnpm sa policy set chief     anthropic/claude-sonnet-4-5
pnpm sa policy set reviewer  local-default --project myapp
pnpm sa policy show
```

Local servers need nothing more than a `baseURL` (`http://127.0.0.1:8000/v1`) and whatever key the
server expects. The mechanism is covered by
`superagent/evals/test/model-route.integration.test.ts`.

### Expose it to a phone (optionally)

```bash
pnpm sa serve --host <your-vpn-ip>
```

Beyond localhost **every** request requires the human token, which is generated at start-up and
printed once. Keep it inside a VPN or behind TLS — the transport is plain HTTP by default.

## Testing

```bash
pnpm test        # unit + integration (node --test)
pnpm test:evals  # real-browser / real-DSH end-to-end scenarios (needs Chromium)
pnpm redteam     # adversarial suite; every scenario must fail closed
pnpm arch        # architecture drift for this repository
pnpm check       # all of the static gates in one command
```

## Repository layout

| Path | What it is |
|---|---|
| `superagent/contracts` | Goal / Task / Receipt / Gate / Policy schemas |
| `superagent/plugins` | deterministic plugins: loop, verifier, chief-worker, observatory, hygiene |
| `superagent/server` | HTTP + SSE API, state store, model policy, health |
| `superagent/ui` | React PWA (desktop and phone) |
| `superagent/dsh-bundle` | the DSH bundle that mounts the plugins as tools |
| `superagent/evals` | E2E and adversarial suites |
| `superagent/testkit` | mock LLM and test harness |
| `docs/` | assistant API, local models, background docs |
| `examples/` | a sample web app with its own E2E gate |
| `.architecture/` | machine-generated architecture map (regenerate with `pnpm arch`) |

## Documentation

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — how the loop, verifier, observatory and core integration fit together
- [`CHANGELOG.md`](CHANGELOG.md) — release notes
- [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) — dependencies and their licenses
- [`docs/`](docs/) — assistant API, local models, background page

## Status and known limits

- The core integration is pinned to **`@deepseek-ai/dsh@0.1.7-rc.2`** with **zero core patches**; all
  extension goes through documented seams (profiles, bundle, `--patch`, tool registration).
- **Security posture and the residual gaps are documented in [`SECURITY.md`](SECURITY.md)** — read it
  before exposing the API beyond localhost.

## Contributing

Issues and PRs are welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md). Please read
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

Report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/CharAzinabulu0079/dgx-super-agent/security/advisories/new)
instead of a public issue. See [`SECURITY.md`](SECURITY.md).

## License

[MIT](LICENSE). Third-party dependency licenses are listed in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
