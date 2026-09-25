# Third-Party Notices

DGX Super Agent **depends on** the packages below; it does **not copy** third-party source code into this repository (Freeze §9.3: dependency/call first). Licenses verified from installed `package.json` files on 2026-09-25.

## Runtime core

| Package | Version | License | Use |
|---|---|---|---|
| `@deepseek-ai/dsh` (DeepSeek Harness) and its `@deepseek-ai/dsh-*` / `@deepseek-ai/cordis*` closure | 0.1.7-rc.2 (commit `477b4f4`) | MIT | The single Agent Core. Consumed unmodified from npm (`Core modifications = 0`). |
| `@deepseek-ai/dsh-browser-use`, `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp` | 0.1.7-rc.2 | MIT | DSH browser-use seam + Playwright MCP provider (installed into the `superagent-worker` DSH profile). |
| `@playwright/mcp` (transitive, via the DSH provider) | 0.0.80 | Apache-2.0 | Browser control MCP server. |

## SuperAgent libraries

| Package | License | Use |
|---|---|---|
| `dependency-cruiser` | MIT | JS/TS import graph for the Architecture Observatory |
| `typescript` | Apache-2.0 | AST export extraction (Observatory), typecheck |
| `picomatch` | MIT | Module path globs |
| `js-yaml` | MIT | Reading `pnpm-workspace.yaml` |
| `react`, `react-dom` | MIT | Web/PWA |
| `@xyflow/react` (React Flow) | MIT | Interactive architecture graph |
| `vite`, `@vitejs/plugin-react` | MIT | UI build |
| `esbuild` | MIT | Bundling the DSH plugin |
| `@playwright/test` | Apache-2.0 | Real-browser E2E gates and UI tests |

## Notable transitive license

- `@img/sharp-libvips-*` — **LGPL-3.0-or-later**, a prebuilt shared library loaded dynamically by `sharp`, which DSH's `dsh-attachment-local` uses for image attachments. It is part of the DSH runtime closure, is not modified or statically linked by this project, and is not redistributed in this repository. A full scan of the 3,065 installed packages found no other GPL/AGPL/SSPL/BUSL license.

## Ideas adopted without code

- **Hermes Agent** (NousResearch): Memory vs Skill separation and candidate/promote learning flow — design reference only, no code, not run as a second core.
- **Claude Code**: coding-harness workflow ideas (loop, verification, hooks) — public design ideas only; no Claude Code source is copied.
- **DeepSeek Harness `llm-mock-server`**: the SSE event sequence of our own `superagent/testkit/src/mock-llm.ts` follows the public Anthropic Messages streaming format that DSH's mock also emits; the implementation is original.

## Chromium

Browser tests use a locally installed Chromium (Playwright revision 1194 or `SUPERAGENT_CHROMIUM`). Chromium is not part of this repository.
