# PotluckLLM

[![test](https://github.com/jtxmp/potluckllm/actions/workflows/test.yml/badge.svg)](https://github.com/jtxmp/potluckllm/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/potluckllm)](https://www.npmjs.com/package/potluckllm)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](package.json)

**Use your teammate's GPU from your laptop, on any network, without accounts or open ports.**

A teammate's machine runs Ollama and `potluck serve`. You run `potluck use` and get an OpenAI-compatible endpoint at `http://127.0.0.1:11500/v1`, so the tools you already use work unchanged. The two machines find each other and connect directly through NAT with [Hyperswarm](https://github.com/holepunchto/hyperswarm), encrypted end to end. Only public keys listed in your team file can connect, and no cloud service sees your prompts.

In a simulated hotspot network with 80 ms of delay and 1% packet loss, a consumer reached the provider in about 3 s and potluck added 89 ms to the time to first token ([measurements](#measurements)).

**Who it's for**

- A small team with one GPU machine that everyone wants to use for private AI work, without sending code or customer data to a cloud API.
- You, reaching the GPU at home from a laptop at the office or a café.

![Demo: laptop A shares llama3.2:3b, laptop B on a separate simulated network uses it, and a key outside the team is rejected](demo/demo.gif)

*Laptop A shares `llama3.2:3b`. Laptop B, on a separate network, lists it, streams an answer, and then an unknown key is rejected. Recorded on one machine, with laptop B in a simulated network (own NAT, no route to A's LAN, 80 ms delay, 1% loss) made by [`scripts/simnet.sh`](scripts/simnet.sh). Reproduce with `vhs demo/demo.tape`.*

## Try it in a minute, no GPU needed

```sh
npx potluckllm try
```

This starts a provider, a consumer and a fake model on your machine with throwaway keys. They still find each other and connect through the public DHT, so you see the real path. The command prints a `curl` line to send a request through it.

## Quickstart

Requires Node 22 or later. The provider also needs [Ollama](https://ollama.com), or another OpenAI-compatible server, listening on localhost.

```sh
npm install -g potluckllm      # or: pnpm add -g potluckllm
```

**Every member** prints their public key and sends it to whoever manages the team:

```sh
potluck id
```

**The team owner** creates the team file, adds members, and sends `team.json` to each of them over a private channel:

```sh
potluck team init my-team --member alice
potluck team add bob <bob's public key>
```

**A provider** shares their local models:

```sh
potluck serve        # reads ./team.json, forwards to http://127.0.0.1:11434
```

**A consumer** uses them:

```sh
potluck use          # http://127.0.0.1:11500/v1
curl http://127.0.0.1:11500/potluck/status
```

A new teammate needs three commands: install, `potluck id`, and `potluck use` once they have the team file.

## Use it from your tools

Point any OpenAI-compatible client at `http://127.0.0.1:11500/v1`. The API key can be any string, unless you start `use` with `POTLUCK_API_KEY` set, in which case it must match.

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:11500/v1", api_key="potluck")
reply = client.chat.completions.create(
    model="llama3.2:3b",
    messages=[{"role": "user", "content": "Summarise this design doc"}],
)
print(reply.choices[0].message.content)
```

```js
import OpenAI from 'openai'

const client = new OpenAI({ baseURL: 'http://127.0.0.1:11500/v1', apiKey: 'potluck' })
const reply = await client.chat.completions.create({
  model: 'llama3.2:3b',
  messages: [{ role: 'user', content: 'Summarise this design doc' }]
})
console.log(reply.choices[0].message.content)
```

Both snippets were tested against `potluck try`, including streaming in Python. Editors and chat apps that take an OpenAI base URL work the same way. Guides for [Continue](https://github.com/jtxmp/potluckllm/issues/8) and [Open WebUI](https://github.com/jtxmp/potluckllm/issues/9) are open issues, if you'd like to write one. Tools that call the endpoint from a browser page need `potluck use --allow-origin <their origin>`.

## Why peer-to-peer

The usual ways to reach a GPU machine on another network, and what each costs:

| Option | Data path | Who can connect | What the team gives up |
|---|---|---|---|
| Port forwarding | Direct | Anyone who finds the port | Router access, and Ollama exposed to the internet with no authentication |
| [ngrok](https://ngrok.com) | Through ngrok's cloud service | Anyone with the URL, unless you add auth | Prompts pass through a third party. Free plan: 1 GB transfer out per month |
| [Tailscale](https://tailscale.com) | Direct or via Tailscale relays | Members of the tailnet | Every user signs in through an identity provider. Access is network-level unless ACLs narrow it. Free plan: 6 users |
| [Holesail](https://holesail.io) | Direct, P2P | Anyone holding the shared connection key | Forwards one port. Access comes from holding the key, and the docs describe no per-user identity |
| [AntSeed](https://github.com/AntSeed/antseed) | Direct, P2P | Any buyer on an open market | Built for paid inference between strangers (USDC payments, reputation scores), not for a private team |
| **PotluckLLM** | Direct, P2P | Public keys in `team.json` | Members must trust each other (see [threat model](docs/threat-model.md)) |

Holepunch's stack fits this problem for three reasons. HyperDHT hole-punches through home routers and mobile NAT, so nobody opens a port. Every Hyperswarm connection is Noise-encrypted and authenticated by Ed25519 public key, so the allow-list check is a lookup on the remote key before any data flows. A shared random topic lets members find each other without a server that knows who is on the team.

Sources for the table, checked 2026-10-14: [ngrok pricing](https://ngrok.com/pricing), [ngrok docs](https://ngrok.com/docs/what-is-ngrok/), [Tailscale pricing](https://tailscale.com/pricing), [Holesail docs](https://docs.holesail.io), [AntSeed README](https://github.com/AntSeed/antseed).

## How it works

```
 consumer laptop                                   provider GPU box
 ┌──────────────────────┐                          ┌──────────────────────┐
 │ any OpenAI client    │                          │ Ollama :11434        │
 │   │ http             │                          │   ▲ http (localhost) │
 │   ▼                  │   Hyperswarm topic,      │   │                  │
 │ potluck use          │◀═ Noise-encrypted P2P ══▶│ potluck serve        │
 │ 127.0.0.1:11500/v1   │   hole-punched via DHT   │ allow-list firewall  │
 └──────────────────────┘                          └──────────────────────┘
          both sides load the same team.json (topic + member public keys)
```

- `potluck id` creates an Ed25519 keypair in `~/.potluck/identity.json` (mode 0600).
- `team.json` holds a random 32-byte topic and each member's name and public key. It holds no secrets.
- Providers announce on the topic. Consumers look it up, retrying with backoff until a provider appears.
- Both sides reject any connection whose public key is not in `team.json`, and pick up edits to the file without a restart.
- Requests and streamed responses travel as newline-delimited JSON over the encrypted stream. The consumer routes each request to a provider that lists the requested model.
- Both commands log one line per event to stderr, such as `connect peer=56d29cb3 member=laptop-b` or `reject peer=ba11aa2b`, with timings and no prompt content.

## Security

PotluckLLM protects a team from outsiders on the internet and from web pages running in a member's browser. It does not protect members from each other: a provider runs the model, so it sees the prompts it processes.

- Outsiders can't connect, and a rejected outsider never learns a member's IP address.
- Web pages can't use your local endpoint. DNS rebinding, cross-site requests and non-JSON requests are refused, and `POTLUCK_API_KEY` can require a key.
- Members can only run inference. Ollama's admin routes are never forwarded, and per-member limits stop one person from holding the GPU.
- Prompts and completions are never logged.

The full threat model is in [docs/threat-model.md](docs/threat-model.md). To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Measurements

Measured on 2026-10-14. Provider: RTX 3050 Ti Laptop GPU (4 GB), Ollama 0.35.1, `llama3.2:3b` fully on GPU. Six streamed requests per path, after one warm-up request, with the same prompt.

| Path | Median time to first token | Median total time |
|---|---|---|
| Ollama directly | 17.5 ms | 990.5 ms |
| Through potluck, provider and consumer on the same machine, public DHT | 20.5 ms | 996.0 ms |

These numbers cover potluck's own overhead only. Both processes ran on one machine, so the connection did not cross a real network.

### Simulated separate network

Measured on 2026-10-15 with [`scripts/simnet.sh`](scripts/simnet.sh) and [`scripts/rehearse.js`](scripts/rehearse.js). The provider ran on this machine's home network. The consumer ran in its own network namespace behind a user-mode NAT, with no route to the home LAN, so it had to find and reach the provider through the public HyperDHT. Five starts per row, six streamed requests per start. Raw results are in [`rehearsal/`](rehearsal/).

| Consumer network | Starts connected | Median time to provider | Median time to first token | Added vs Ollama directly | Failed requests |
|---|---|---|---|---|---|
| Own NAT | 5 of 5 | 2301 ms | 29.2 ms | 12.4 ms | 0 of 30 |
| Own NAT, 80 ms ± 20 ms delay, 1% loss | 5 of 5 | 3063 ms | 106.1 ms | 89.3 ms | 0 of 30 |

Ollama directly: 16.8 ms median time to first token. Time to provider varies between runs: an earlier run of the same setup measured 4368 ms and 3396 ms.

What this does not cover: both sides still share one public IP, so carrier-grade NAT on a phone hotspot is untested, and the delay applies to the consumer's outgoing traffic only. Results from real network pairs are wanted in [#2](https://github.com/jtxmp/potluckllm/issues/2).

## Limits

- Tested on Linux and macOS (CI runs both). Windows is untested ([#5](https://github.com/jtxmp/potluckllm/issues/5)).
- Your own `potluck use` does not list models from your own `potluck serve`. Call Ollama directly for those ([#10](https://github.com/jtxmp/potluckllm/issues/10)).
- Only chat completions and the model list are forwarded. Embeddings are not yet ([#3](https://github.com/jtxmp/potluckllm/issues/3)).
- Routing picks the first provider that lists a model. There is no load balancing ([#4](https://github.com/jtxmp/potluckllm/issues/4)).
- Some networks block UDP or use NAT that hole punching cannot cross. There is no relay fallback yet ([#1](https://github.com/jtxmp/potluckllm/issues/1)).

## Roadmap and contributing

The roadmap is the [open issues](https://github.com/jtxmp/potluckllm/issues). Ones that are a good place to start:

- [#2](https://github.com/jtxmp/potluckllm/issues/2) Share your `rehearse.js` results from a real network pair. No code needed.
- [#3](https://github.com/jtxmp/potluckllm/issues/3) Forward `/v1/embeddings`.
- [#8](https://github.com/jtxmp/potluckllm/issues/8) and [#9](https://github.com/jtxmp/potluckllm/issues/9) Integration guides for Continue and Open WebUI.

Bigger pieces where help is wanted: relay fallback ([#1](https://github.com/jtxmp/potluckllm/issues/1)), load-aware routing ([#4](https://github.com/jtxmp/potluckllm/issues/4)), Windows ([#5](https://github.com/jtxmp/potluckllm/issues/5)), a Pear app ([#6](https://github.com/jtxmp/potluckllm/issues/6)) and QVAC as an upstream ([#7](https://github.com/jtxmp/potluckllm/issues/7)).

[CONTRIBUTING.md](CONTRIBUTING.md) covers setup, a map of the code and the house rules. Development needs no GPU: `pnpm test` runs everything on a local DHT testnet. Questions and ideas go in [Discussions](https://github.com/jtxmp/potluckllm/discussions).

## Development

```sh
pnpm install
pnpm test                    # integration tests on a local DHT testnet, no GPU or internet needed
node bin/potluck.js try      # the whole path on one machine, with a fake model
node scripts/rehearse.js     # measure connect time and latency across real networks (see the file header)
scripts/simnet.sh --profile hotspot -- <command>   # run a command in a simulated separate network (Linux, no root)
vhs demo/demo.tape           # re-record the demo GIF (needs vhs, ttyd, tmux, pasta, Ollama)
git config core.hooksPath .githooks   # scan each commit for secrets (needs gitleaks)
```

CI runs the tests on Linux and macOS, `pnpm audit`, and a gitleaks scan of every commit. Dependabot proposes dependency and action updates once a release is 14 days old. Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## License

MIT. See [LICENSE](LICENSE).

## How this was built

PotluckLLM was scoped and built with Claude Code. [AI-WORKFLOW.md](AI-WORKFLOW.md) covers how AI was used for research, scoping and code, including the ideas that were rejected. The product requirements are in [docs/PRD.md](docs/PRD.md).
