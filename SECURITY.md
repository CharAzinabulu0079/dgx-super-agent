# Security Policy

## Reporting a vulnerability

Please do **not** open a public issue for a security problem.

Report it privately through
[GitHub Security Advisories](https://github.com/CharAzinabulu0079/DGX-Super-Agent/security/advisories/new)
(→ *Report a vulnerability*). Include the affected component, a reproduction, and what you think the
impact is. If the form is unavailable, use the contact options on the repository owner's GitHub
profile and mention "security" in the subject.

You should receive an acknowledgement within a few days. Please allow time for a fix before any
public disclosure.

## Supported versions

The `main` branch is the only supported line. Older tags are snapshots.

## Design-level security notes

Read this before exposing the API beyond `127.0.0.1`.

**Layers that exist today**

- Gates are commands; a Worker's claim of success never passes a task. Verification assets (gate
  scripts, test files, `package.json` scripts) are integrity-checked against a per-task baseline, so
  weakening a test to make it pass fails verification.
- Held-out acceptance tests are stored outside the project (`$SUPERAGENT_HOME/heldout/`), mounted
  into a throwaway tree at verification time, and rejected if their source lives inside the project.
- The pre-tool guard blocks dangerous, obfuscated and out-of-project tool calls before execution;
  Human Gate approval unlocks exactly the approved call.
- The human token is generated per `sa serve` start and held only in memory; it is never inherited by
  model sessions or commands. Workers receive neither token.
- Model output never decides policy: gate registry entries are human-defined and referenced by id.

**Known residual risks (be honest with yourself before deploying)**

1. **Workers run as the same OS user as the server.** The DSH sandbox confines writes to the project
   and the guard forbids `SUPERAGENT_HOME`, but the guard is pattern-based: a sufficiently creative
   shell command may still *read* files such as the agent-token file or the held-out tests. Run model
   sessions as a dedicated OS user or in a container with no read access to `SUPERAGENT_HOME` and no
   route to the API port, and keep `secrets/`, `heldout/` and `backups/` mode `0700`.
2. **Shell classification is pattern matching.** Novel obfuscation can slip past it — which is why the
   sandbox, integrity checks and credential separation are independent layers rather than one defence.
3. **Transport is plain HTTP.** Anything beyond localhost requires the human token, but put it behind
   a VPN or TLS; do not expose port 7788 to an untrusted network.
4. **Held-out gates are only as strong as the suite a human registers.**

## Hardening checklist for a deployment

- [ ] Workers run as a separate OS user / in a container
- [ ] API bound to `127.0.0.1` or a VPN address, never a public interface
- [ ] `secrets/`, `heldout/`, `backups/` are `0700` and owned by the service user
- [ ] Each project's gate registry reviewed by a human (`sa project add --gate …`)
- [ ] DSH telemetry disabled in any profile you use directly
