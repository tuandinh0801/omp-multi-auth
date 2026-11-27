# omp-multi-auth

Multi-account OAuth login for [omp (Oh My Pi)](https://github.com/can1357/oh-my-pi). Add, authenticate, and switch between multiple accounts per provider. OMP's built-in fallback handles rate-limit retry and model fallback.

## Install

```bash
omp install npm:omp-multi-auth
```

Or install from GitHub:

```bash
omp install git:github.com/tuandinh0801/omp-multi-auth
```

## Features

- Multiple OAuth accounts per provider
- Switch active account with `/multi-auth switch`
- Cross-provider model presets with `/multi-auth-preset`
- Built-in quota checks with `/multi-auth limits`
- Project affinity through `.omp/multi-auth.json` and `allowedSubs`
- Labels for organizing accounts
- Interactive TUI management

## Commands

### `/multi-auth`

| Command | Description |
|---|---|
| `/multi-auth` | Open account management menu |
| `/multi-auth list` | List configured accounts |
| `/multi-auth add` | Add an account |
| `/multi-auth remove` | Remove an account |
| `/multi-auth login` | Authenticate an account |
| `/multi-auth logout` | Sign out an account |
| `/multi-auth switch` | Switch active account/provider |
| `/multi-auth status` | Show account and authentication status |
| `/multi-auth limits` | Check provider quota and usage |

On OMP 19's legacy extension bridge, account menus use OMP's built-in selection dialog and quota checks show a progress notification.

### `/multi-auth-preset`

| Command | Description |
|---|---|
| `/multi-auth-preset` | Open preset menu |
| `/multi-auth-preset activate` | Activate a preset's best available entry |
| `/multi-auth-preset <name>` | Activate preset by name |
| `/multi-auth-preset create` | Create a preset |
| `/multi-auth-preset list` | List presets |
| `/multi-auth-preset toggle` | Enable or disable a preset |
| `/multi-auth-preset remove` | Delete a preset |

Presets select models across providers. On rate limits, requests fall through to OMP's built-in fallback.

## Project-level configuration

Create `.omp/multi-auth.json` in a project to restrict which subscription provider names are available. `allowedSubs` is an exact allow-list; omit it to allow all configured accounts.

```json
{
  "allowedSubs": ["openai-codex-2", "anthropic-2"]
}
```

## Supported providers

### OAuth

| Provider | Service |
|---|---|
| `anthropic` | Anthropic (Claude Pro/Max) |
| `openai-codex` | ChatGPT Plus/Pro (Codex) |
| `github-copilot` | GitHub Copilot |
| `google-gemini-cli` | Google Cloud Code Assist |
| `google-antigravity` | Antigravity |
| `kimi-code` | Kimi Code |
| `xai-oauth` | xAI Grok OAuth |
| `cursor` | Cursor (browser PKCE OAuth or API key) |

Each added Codex account (e.g. `openai-codex-2`) discovers its own model catalog using its own OAuth credentials. Run `omp models refresh` to check for newly available models. Account-specific selectors stay unchanged.

### API key

| Provider | Service |
|---|---|
| `openai` | OpenAI (API key) |
| `deepseek` | DeepSeek |
| `mistral` | Mistral |
| `groq` | Groq |
| `xai` | xAI (API key) |
| `google` | Google Gemini (API key) |
| `openrouter` | OpenRouter |
| `together` | Together AI |
| `fireworks` | Fireworks AI |
| `cerebras` | Cerebras |
| `moonshot` | Moonshot (Kimi) |
| `zai` | Z.AI (GLM) |
| `minimax` | MiniMax (Global) |
| `minimax-cn` | MiniMax (China) |
| `opencode-go` | OpenCode Go |
| `cursor` | Cursor (dashboard API key `crsr_...` / `cursor_...` or browser sign-in) |

API-key providers support full multi-account operation. Add an account with `/multi-auth add`, select the provider, then authenticate via `/multi-auth login` (or `/login <name>`) and paste your API key when prompted. Each account stores its own key independently in OMP auth storage.

For `cursor`, `/multi-auth login` prompts for a dashboard API key (`crsr_...`/`cursor_...`). Submit a key to use token exchange, or leave it blank to sign in via browser PKCE OAuth. Both methods refresh automatically.

## Built-in quotas

Run `/multi-auth limits` to inspect quota and usage information for supported providers. This currently includes built-in quota checks for Codex, Google, and OpenCode Go providers. Results depend on provider availability and authenticated account state.

OpenCode Go reports 5-hour, weekly, and monthly windows. The status line and ready/low/blocked state use the tighter of the 5-hour and weekly windows; the monthly window is shown for reference only, because an exhausted month can still serve requests when the account's "Use balance" fallback is on.

Added accounts also report usage to OMP itself, so `/usage`, `omp usage`, and status lines built on OMP's usage reports show each account (for example `anthropic-2`) next to the base provider. This works for every provider OMP has a usage fetcher for, on OMP versions with the usage registry. OMP caches, refreshes and invalidates these reports like any other provider's. Until OMP keeps a registered provider's reports across processes ([can1357/oh-my-pi#20030](https://github.com/can1357/oh-my-pi/pull/20030)), each new OMP process probes each added account once.

## Configuration files

| Scope | Path | Contents |
|---|---|---|
| Global | `~/.omp/agent/multi-auth.json` | Subscriptions and presets |
| Project | `.omp/multi-auth.json` | `allowedSubs` allow-list |

### Proxy or gateway endpoints

An added account takes the `baseUrl` and `headers` that `~/.omp/agent/models.yml` sets for its base provider, so its requests go through the same gateway as the base account. omp-multi-auth reads `models.yaml` instead only when `models.yml` does not exist, as omp does; it never merges the two files, and `models.json` is not read. Each account still signs in with its own credential. Without a `baseUrl`, an account keeps the provider's built-in endpoints, so a provider with several API dialects (OpenCode Go) still uses the right URL for each model. A `baseUrl` replaces the endpoint for every model of that provider, and for GitHub Copilot accounts it replaces the endpoint derived from the sign-in token.

```yaml
providers:
  anthropic:
    baseUrl: http://127.0.0.1:8080/anthropic
    headers:
      x-proxy-key: example
```

With this file, `anthropic-2` and `anthropic-3` send their requests to `http://127.0.0.1:8080/anthropic` with `x-proxy-key` too. Codex accounts (`openai-codex-N`) are not covered yet. omp reads the file when it starts, so restart omp after you change it.

## Credits

Originally based on [`pi-multi-pass`](https://github.com/hjanuschka/pi-multi-pass).

## License

MIT
