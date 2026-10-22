# PotluckLLM

[![test](https://github.com/jtxmp/potluckllm/actions/workflows/test.yml/badge.svg)](https://github.com/jtxmp/potluckllm/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/potluckllm)](https://www.npmjs.com/package/potluckllm)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](package.json)

PotluckLLM is a command-line tool that shares local LLMs between members of a team over peer-to-peer connections. One machine runs Ollama and `potluck serve`. Other members run `potluck use`, which serves an OpenAI-compatible endpoint at `http://127.0.0.1:11500/v1` and forwards requests to that machine. Connections use [Hyperswarm](https://github.com/holepunchto/hyperswarm): peers find each other through the HyperDHT, connect directly through NAT, and encrypt traffic end to end. Only public keys listed in the team file can connect.

## Who this is for

- A small team where one machine has a GPU and runs Ollama, and other members want to use its models from their own machines on other networks.
- One person who runs Ollama on a machine at home and wants to use it from a laptop elsewhere.

Members must trust each other, because the provider sees the prompts it processes. See [Security](#security).

## Quickstart

Requires Node 22 or later. The provider also needs [Ollama](https://ollama.com), or another OpenAI-compatible server, listening on localhost.

```sh
npm install -g potluckllm      # or: pnpm add -g potluckllm
```

Every member prints their public key and sends it to the team owner:

```sh
potluck id
```

The team owner creates the team file, adds members, and sends `team.json` to each of them over a private channel:

```sh
potluck team init my-team --member alice
potluck team add bob <bob's public key>
```

A provider shares their local models:

```sh
potluck serve        # reads ./team.json, forwards to http://127.0.0.1:11434
```

A consumer uses them:

```sh
potluck use          # http://127.0.0.1:11500/v1
curl http://127.0.0.1:11500/potluck/status
```

### Try it without Ollama

```sh
npx potluckllm try
```

This starts a provider, a consumer and a fake model on one machine with throwaway keys. They connect through the public DHT, and the command prints a `curl` line that sends a request through them.

### Demo

![Demo: laptop A shares llama3.2:3b, laptop B on a separate simulated network uses it, and a key outside the team is rejected](demo/demo.gif)

*Laptop A shares `llama3.2:3b`. Laptop B lists it, streams an answer, and then an unknown key is rejected. Recorded on one machine, with laptop B in a simulated network (own NAT, no route to A's LAN, 80 ms delay, 1% loss) made by [`scripts/simnet.sh`](scripts/simnet.sh). Reproduce with `vhs demo/demo.tape`.*

## Commands and options

| Command | What it does |
|---|---|
| `potluck try` | Runs a provider, a consumer and a fake model on one machine |
| `potluck id` | Prints your public key, creating it on first run |
| `potluck team init <team-name> [--member <name>]` | Creates a team file with you as the first member |
| `potluck team add <name> <public-key>` | Adds a member to the team file |
| `potluck serve` | Shares your local models with the team |
| `potluck use` | Serves the team's models at `http://127.0.0.1:<port>/v1` |

| Option | Used by | Default |
|---|---|---|
| `--team <file>` | `team`, `serve`, `use` | `./team.json` |
| `--member <name>` | `team init` | this machine's hostname |
| `--upstream <url>` | `serve` | `http://127.0.0.1:11434` |
| `--allow-remote-upstream` | `serve`: allow an upstream on another machine | off |
| `--timeout <s>` | `serve`: abort an upstream request after this many idle seconds | 120 |
| `--max-duration <s>` | `serve`: abort any request after this many seconds in total | 600 |
| `--max-tokens <n>` | `serve`: cap `max_tokens` on every chat request | 4096 |
| `--port <n>` | `use`, `try` | 11500 |
| `--allow-origin <list>` | `use`: web origins allowed to call the endpoint, comma-separated | none |

`potluck --help` prints the full usage text. `serve` and `use` reload the team file when it changes, and disconnect removed members at once.

## Use it from your tools

Point an OpenAI-compatible client at `http://127.0.0.1:11500/v1`. The API key can be any string, unless `use` was started with `POTLUCK_API_KEY` set, in which case it must match.

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

Both snippets were tested against `potluck try`, including streaming in Python. Other clients that accept an OpenAI base URL have not been tested. A client that calls the endpoint from a browser page needs `potluck use --allow-origin <its origin>`.

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
- Providers announce on the topic. Consumers look it up, retrying with backoff until a provider appears. No server stores the member list.
- HyperDHT hole-punches through NAT, so no member opens a port.
- Every connection is encrypted with the Noise protocol and authenticated by Ed25519 public key. Both sides close a connection whose public key is not in `team.json` before any data flows.
- Requests and streamed responses travel as newline-delimited JSON over the encrypted stream. The consumer sends each request to the first provider that lists the requested model.
- Both commands log one line per event to stderr, such as `connect peer=56d29cb3 member=laptop-b` or `reject peer=ba11aa2b`, with timings and no prompt content.

## Security

PotluckLLM protects a team from outsiders on the internet and from web pages running in a member's browser. It does not protect members from each other: a provider runs the model, so it sees the prompts it processes.

- A key not in `team.json` cannot connect, and its owner does not learn a member's IP address.
- The local endpoint refuses requests with a foreign `Host` header (DNS rebinding), cross-origin requests not allowed by `--allow-origin`, and requests whose body is not JSON. `POTLUCK_API_KEY` adds a required bearer key.
- The provider forwards only `/v1/models` and `/v1/chat/completions`. Ollama's other routes are not reachable.
- The provider runs one request at a time and queues up to 16 more, with at most 4 queued or running per member. Beyond that it replies 503 or 429.
- Prompts and completions are not logged.

The threat model is in [docs/threat-model.md](docs/threat-model.md). To report a vulnerability, see [SECURITY.md](SECURITY.md).

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

Not covered: both sides share one public IP, so carrier-grade NAT on a phone hotspot is untested, and the delay applies to the consumer's outgoing traffic only. Results from real network pairs are collected in [#2](https://github.com/jtxmp/potluckllm/issues/2).

## Limits

- Tested on Linux and macOS (CI runs both). Windows is untested ([#5](https://github.com/jtxmp/potluckllm/issues/5)).
- Your own `potluck use` does not list models from your own `potluck serve`. Call Ollama directly for those ([#10](https://github.com/jtxmp/potluckllm/issues/10)).
- Only chat completions and the model list are forwarded. Embeddings are not ([#3](https://github.com/jtxmp/potluckllm/issues/3)).
- Routing picks the first provider that lists a model. There is no load balancing ([#4](https://github.com/jtxmp/potluckllm/issues/4)).
- Some networks block UDP or use NAT that hole punching cannot cross. There is no relay fallback ([#1](https://github.com/jtxmp/potluckllm/issues/1)).

## Alternatives

Other ways to reach a model server on another network, as of 2026-10-14:

| Option | Data path | Who can connect | Notes |
|---|---|---|---|
| Port forwarding | Direct | Anyone who finds the port | Needs router access. Ollama has no authentication |
| [ngrok](https://ngrok.com) | Through ngrok's servers | Anyone with the URL, unless auth is added | Free plan: 1 GB transfer out per month |
| [Tailscale](https://tailscale.com) | Direct or via Tailscale relays | Members of the tailnet | Users sign in through an identity provider. Access is network-level unless ACLs narrow it. Free plan: 6 users |
| [Holesail](https://holesail.io) | Direct, P2P | Anyone holding the connection key | Forwards one port. The docs describe no per-user identity |
| [AntSeed](https://github.com/AntSeed/antseed) | Direct, P2P | Buyers on an open market | Paid inference between strangers (USDC payments, reputation scores) |
| PotluckLLM | Direct, P2P | Public keys in `team.json` | No relay, so some networks cannot connect ([#1](https://github.com/jtxmp/potluckllm/issues/1)) |

Sources: [ngrok pricing](https://ngrok.com/pricing), [ngrok docs](https://ngrok.com/docs/what-is-ngrok/), [Tailscale pricing](https://tailscale.com/pricing), [Holesail docs](https://docs.holesail.io), [AntSeed README](https://github.com/AntSeed/antseed).

## Contributing

The roadmap is the [open issues](https://github.com/jtxmp/potluckllm/issues). [CONTRIBUTING.md](CONTRIBUTING.md) covers setup, a map of the code and the house rules. Questions go in [Discussions](https://github.com/jtxmp/potluckllm/discussions).

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

PotluckLLM was scoped and built with Claude Code. [AI-WORKFLOW.md](AI-WORKFLOW.md) describes how AI was used for research, scoping and code. The product requirements are in [docs/PRD.md](docs/PRD.md).
