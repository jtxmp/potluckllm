# Contributing to PotluckLLM

Contributions are welcome, from a one-line docs fix to relay support. Issues labelled [`good first issue`](https://github.com/jtxmp/potluckllm/labels/good%20first%20issue) are small and self-contained. The quickest way to help is [#2](https://github.com/jtxmp/potluckllm/issues/2): run the rehearsal script between two real networks and post the results.

For questions and ideas, use [Discussions](https://github.com/jtxmp/potluckllm/discussions). For security problems, follow [SECURITY.md](SECURITY.md) and don't open a public issue.

## Setup

You need Node 22 or later and pnpm. No GPU, Ollama or second machine is needed for development.

```sh
git clone https://github.com/jtxmp/potluckllm && cd potluckllm
pnpm install
pnpm test                          # integration tests on a local DHT testnet
node bin/potluck.js try            # a provider, a consumer and a fake model, over the real DHT
git config core.hooksPath .githooks   # optional: scan each commit for secrets (needs gitleaks)
```

## Code map

| File | What it does |
|---|---|
| `bin/potluck.js` | CLI: argument parsing, `try`, `id`, `team`, `serve`, `use`, team file reloading |
| `src/provider.js` | `serve`: joins the topic, checks members, queues requests and forwards allowed routes to the upstream |
| `src/consumer.js` | `use`: finds providers, runs the local OpenAI-compatible endpoint, relays requests and checks replies |
| `src/protocol.js` | The wire format: newline-delimited JSON messages over one Hyperswarm connection (message list at the top of the file) |
| `src/team.js` | Team file parsing, validation, writing and watching |
| `src/identity.js` | The Ed25519 identity in `~/.potluck/identity.json` |
| `src/log.js` | One-line event logs, quoting of peer-supplied values, rate-limited reject lines |
| `src/fake-upstream.js` | Fake OpenAI-compatible server used by `potluck try` and the tests |
| `test/potluck.test.js` | All tests. Most start real providers and consumers on `hyperdht/testnet` |
| `scripts/rehearse.js`, `scripts/simnet.sh` | Measurement across real or simulated networks |

A request goes: client → `consumer.js` HTTP handler → `req` message → `provider.js` queue → upstream → `head`, `chunk` and `end` messages → back to the client as they arrive.

## House rules

- **Plain JavaScript with types in comments.** ES modules, `// @ts-check` and JSDoc types, no build step. Match the style of the file you're editing.
- **No new runtime dependency without an issue first.** There is one today (`hyperswarm`). A dependency is code every user has to trust.
- **Every fix and feature comes with a test.** Prefer an integration test on the testnet, using the helpers at the top of `test/potluck.test.js`. Tests must not need a GPU, Ollama or the internet. Check that your test fails without your change.
- **Validate whatever crosses a trust boundary.** Messages from peers and requests to the local endpoint are untrusted until checked. [docs/threat-model.md](docs/threat-model.md) lists what the project defends against. A change that weakens a line there needs a discussion first.
- **Never log prompts or completions.** Logs hold event names, 8-character key prefixes, ids and timings.

## Pull requests

- Keep each pull request to one change, and link the issue it closes.
- Say how you verified it: tests added, commands run, networks tried.
- CI runs the tests on Linux and macOS, `pnpm audit` and a secrets scan. All must pass.
- Contributions are licensed under the [MIT License](LICENSE).
