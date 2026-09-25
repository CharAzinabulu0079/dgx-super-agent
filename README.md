# DGX Super Agent (v0.1)

A private Super Agent built as **plugins around one Agent Core — DeepSeek Harness 0.1.7-rc.2 (unmodified)**: project workspaces, a Chief/Worker loop that retries until independent gates pass or a human decision is needed, a live architecture map of every project, real-browser testing, manual model policy, and gated learning.

Authoritative spec: [`DGX_SUPER_AGENT_FOUNDATION_FREEZE_v1.md`](DGX_SUPER_AGENT_FOUNDATION_FREEZE_v1.md).

| Read | For |
|---|---|
| [`CURRENT_STATE.md`](CURRENT_STATE.md) | what is done / partial / not started, known issues, last green checks |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | how it works (loop, verifier, observatory, DSH integration) |
| [`SETUP_DGX.md`](SETUP_DGX.md) | install, configure the local model, run on Linux ARM64 |
| [`NEXT_STEPS.md`](NEXT_STEPS.md) | prioritized follow-up work |
| [`DECISIONS.md`](DECISIONS.md) | ADRs |
| [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) | licenses |
| `.architecture/` | this repo's own machine-generated architecture map |

```bash
pnpm install && pnpm build
pnpm check            # typecheck + tests + architecture drift + repo hygiene
pnpm smoke:dsh        # DSH core boots and runs tools (keyless)
pnpm test:evals       # real-browser / real-DSH end-to-end scenarios
pnpm sa dsh setup && pnpm sa serve --browser   # API + UI on http://127.0.0.1:7788
```
