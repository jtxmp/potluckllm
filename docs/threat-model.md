# Threat model

PotluckLLM protects a team from outsiders on the internet and from web pages running in a member's browser. It does not protect members from each other. To report a vulnerability, see [SECURITY.md](../SECURITY.md).

- **Outsiders cannot connect.** Both sides check the remote public key against `team.json` before any data flows. The provider checks it before sharing any address, so a rejected outsider never learns its IP. The consumer checks it before dialling, so it never contacts a non-member.
- **A leaked topic reveals little.** Someone holding the topic can look it up on the DHT and learn each provider's public key and the DHT nodes relaying for it, and can make providers spend a handshake on each attempt. They can't learn addresses or connect. Rejections are logged at most once per key per minute, so they can't flood the log.
- **A provider reads your prompts.** It runs the model, so it sees everything it processes. Only send material you would show that person.
- **Web pages cannot use your endpoint.** The consumer listens on 127.0.0.1 and also refuses requests for any other host name (DNS rebinding), requests carrying an `Origin` header (other sites) unless you allow that origin with `--allow-origin`, and chat requests that aren't `application/json`. Set `POTLUCK_API_KEY` to also require an API key, which keeps out other users of the same machine.
- **A faulty or hostile provider cannot crash your consumer.** Replies are checked before they reach the HTTP response: status codes, content types (JSON or server-sent events only) and data fields. A reply that breaks the protocol closes that provider's connection and fails its requests.
- **Members cannot manage the provider's models.** Only `GET /v1/models` and `POST /v1/chat/completions` are forwarded. Ollama admin routes such as `/api/pull` and `/api/delete` return 404.
- **No member can monopolise a provider.** The provider runs one request at a time, queues up to 16, and allows each member 4 at once. It caps `max_tokens` (`--max-tokens`, default 4096), aborts a request after 120 s with no output (`--timeout`) and after 600 s in total (`--max-duration`).
- **The provider stays local.** It refuses a non-loopback upstream unless you pass `--allow-remote-upstream`, and logs `insecure-upstream` if that upstream uses plain HTTP.
- **Nothing sensitive is logged.** Logs hold event names, key prefixes, request ids and timings. Prompts and completions are never written to disk. Values that came from a peer are quoted, so they can't forge a log line.
- **Removing a member takes effect at once.** `serve` and `use` reload `team.json` when it changes and disconnect anyone no longer listed. Send the updated file to every member.
- **Keys are stored like SSH keys without a passphrase.** The private seed is in `~/.potluck/identity.json`, unencrypted. Potluck refuses to start if that file is readable, or its folder writable, by other users. Anyone who can read your home directory as you can use your identity.
- **Team files are not secrets, but keep them private.** `team.json` holds the topic and member list. `team init` warns if it would be committed to git.
