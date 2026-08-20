<p align="center">
  <a href="https://www.npmjs.com/package/@m1khal3v/dsh-llm-key-rotation"><img alt="npm" src="https://img.shields.io/npm/v/@m1khal3v/dsh-llm-key-rotation?style=flat-square&color=4b6fff"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square"></a>
  <img alt="Status" src="https://img.shields.io/badge/status-beta-7da1de?style=flat-square">
  <a href="https://github.com/m1khal3v/dsh-llm-key-rotation"><img alt="GitHub" src="https://img.shields.io/badge/repo-m1khal3v%2Fdsh--llm--key--rotation-4b6fff?style=flat-square"></a>
</p>

# dsh-llm-key-rotation

Seamless API-key rotation for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) LLM
providers. When a model request hits a subscription limit (quota exhausted, rate-limited, or
auth failure), the plugin writes the next spare key from a provider's chain into the active
API-key reference and retries — without a restart and without a model-visible surface.

The plugin manages only a **spare-key chain** per provider. The active key lives in the
provider's `apiKeyEnv` (configured in the main settings); the spare keys live, one per
credential reference, in references named `OPENCODE_GO_API_KEY_CHAIN_1`, `_CHAIN_2`, …
and are listed per provider in the plugin's `apiKeyEnvChain` setting. The web card writes the
spare keys there.

The project does not patch DeepSeek Harness core. Installing the plugin enables key
rotation, and removing it leaves no core modifications behind.

> Status: beta. Suitable for daily use with any DeepSeek Harness profile that mounts the
> `agent/request-error` recovery waterfall.

## How It Works

DeepSeek Harness adapters resolve the API key **once per model request** through the
`ctx.credentials` seam. This plugin hooks into the agent loop's `agent/request-error`
recovery waterfall: when a request fails with a configured `rotate_on` code (`QUOTA`,
`RATE_LIMIT`, `AUTH`), it writes the next spare key's value into the provider's env reference
(`OPENCODE_GO_API_KEY`), then returns `{ kind: 'retry' }`. The loop opens a fresh turn that
authenticates with the rotated key — the adapter re-resolves the reference on the next
request and picks up the new value automatically.

```text
spare keys stored under …_CHAIN_N (written by the web card)
model request fails (QUOTA / RATE_LIMIT / AUTH)
  → agent/request-error waterfall
  → llm-key-rotation listener (provider enabled + rotate_on match)
  → read next spare key from the chain cache
  → write it to the provider env ref (OPENCODE_GO_API_KEY)
  → [llm-key-rotation] rotated …  (stdout log)
  → return { kind: 'retry' }
  → loop opens a fresh turn → adapter re-resolves env ref → new key
```

## Walk discipline (no unbounded spinning)

Each spare-key write is timestamped. On a failing request:

- **within 300 s of the last write** → advance to the next chain entry (a live series of
  failures walks the chain forward, one spare key per failure);
- **300 s or more after the last write** → restart from the chain head (index 0) — the
  previously-last key may have become stale, so the spares are retried from the beginning;
- **every chain key already written within one 300 s window and a failure still arrives** →
  delegate to downstream recovery instead of spinning forever.

The env reference is **never restored after success**: it keeps the last written (working or
last-tried) key, so the adapter simply continues with the last key that worked.

## Quick Start

Prerequisites: a provider added in the harness main settings (Models) with its `apiKeyEnv`
configured, plus at least one spare key.

### Install the plugin

```sh
dsh plugin --profile web add @m1khal3v/dsh-llm-key-rotation
```

### Configure in the web card

Open the plugin's **Key Rotation** card (`Settings → Plugins → Configurable`):

1. Enable the provider with the toggle.
2. Pick which failure codes rotate (`rotate_on`).
3. Click **+ Add key**, paste each spare key, then **Save**. Saved keys show as `[hidden]`
   (they are written to the credential store and never read back); remove a key with its ✕
   button. Only providers shown (those added in the main settings / `active`) appear.

The profile is stored under `llm-key-rotation.providers.<provider>` as
`{ enabled, rotate_on, apiKeyEnvChain }`, where `apiKeyEnvChain` lists the `_CHAIN_N`
references, e.g.:

```yaml
llm-key-rotation:
  providers:
    opencode-go:
      enabled: true
      rotate_on:
        - QUOTA
        - AUTH
      apiKeyEnvChain:
        - OPENCODE_GO_API_KEY_CHAIN_1
        - OPENCODE_GO_API_KEY_CHAIN_2
```

The spare key values themselves live in the credential store under those references (the
web card writes them); the plugin never reads them back over the wire.

## Configuration

Each provider route gets one rotation profile:

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Whether rotation is active for this provider. |
| `rotate_on` | `['QUOTA','AUTH']` | Failure codes that trigger a rotation. Common: `QUOTA`, `RATE_LIMIT`, `AUTH`. |
| `apiKeyEnvChain` | `[]` | Credential references holding the spare keys, one value per reference. |

If a provider is disabled or `apiKeyEnvChain` is empty, the plugin hands the failure to
downstream recovery immediately.

### Composition entry (cordis.patch.yml)

The bundle's patch file inserts one plugin row, applied after `@deepseek-ai/dsh-base`, so the
listener registers after `dsh-llm-retry` in the waterfall:

```yaml
- insert:
    - id: llm-key-rotation
      name: '@m1khal3v/dsh-llm-key-rotation'
      config:
        providers: {}
```

Users override `providers` through the settings section without touching the bundle.

## Composition with dsh-llm-retry

This listener registers **after** `dsh-llm-retry` in the `agent/request-error` waterfall.
The interaction depends on which trigger codes are configured:

- **`QUOTA` and `AUTH`** are NOT in `dsh-llm-retry`'s default `retryableCodes`, so rotation
  acts immediately.
- **`RATE_LIMIT`** IS in `dsh-llm-retry`'s default `retryableCodes`, so `dsh-llm-retry`
  intercepts it first and retries with backoff. Rotation acts only after `dsh-llm-retry`
  exhausts its budget and delegates. To rotate on `RATE_LIMIT` immediately, remove
  `RATE_LIMIT` from the provider profile's `retryableCodes`.

## Telemetry (stdout)

Every rotation and delegate is written to **stdout of the process that launches `dsh`** with
a `[llm-key-rotation]` tag — e.g.:

```text
[llm-key-rotation] rotated provider="opencode-go" chain[0]→"OPENCODE_GO_API_KEY" (QUOTA) window=fresh-start lastWriteAge=–
[llm-key-rotation] rotated provider="opencode-go" chain[1]→"OPENCODE_GO_API_KEY" (QUOTA) window=fresh lastWriteAge=2s
```

Run `dsh web` from a terminal you can watch to confirm rotation works. No key values are
ever logged — only references, indices, and failure codes.

A live `llm/key-rotation` Cordis event is also emitted after each rotation for in-process
consumers (`ctx.on('llm/key-rotation', …)`); the event is non-durable.

## Chain value caching

Spare-key values are cached at load and refreshed on settings change or `credentials/updated`
for a chain reference, so a newly-stored spare key is picked up without a restart.

## Web UI Settings Card

The plugin ships a browser half that registers a **Key Rotation** card in the Plugins
settings page (`Settings → Plugins → Configurable`). The card:

- Shows only providers added in the main settings (`active`). If none — a "no providers"
  notice.
- Offers a per-provider **enabled** toggle and **rotate_on** chips.
- Lets you **add / remove spare keys**. Save writes the non-empty keys to their `_CHAIN_N`
  references and persists `apiKeyEnvChain`; saved keys become disabled `[hidden]` fields
  (never read back) and can only be removed.

The card reads/writes through the same wire APIs the Models page uses (values are written
but never read back). The browser bundle is materialized through the dsh module system as
`lib/client.js`. State is re-read whenever the card (re)loads, so reopening the settings
window refreshes the current configuration.

## Known Limitations

- **Saved key values cannot be shown** — the credentials wire API never returns secret
  values, so a stored key's input is disabled with a `[hidden]` placeholder; it can only be
  removed.
- **`apiKeyEnvChain` must not be shadowed by the environment** — `ctx.credentials.set` is
  rejected when a read-only environment variable supplies the same reference.
- **Chain values are cached at load** — a spare key added after startup is picked up through
  the `credentials/updated` event or a settings change, not by re-reading on every rotation.
- **`RATE_LIMIT` rotation follows `dsh-llm-retry`'s budget** — remove `RATE_LIMIT` from the
  provider's `retryableCodes` to rotate immediately.
- **The `llm/key-rotation` event is non-durable** — it is a live Cordis event, not a
  session-log event. The durable rotation trail is the stdout log above.
- **One credential serves every model on a route** — rotation is per provider route, not per
  model.

## Development

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run verify    # typecheck + test
```

Node `^22.19 || >=24`. The package depends on `@deepseek-ai/dsh-*` peer packages provided by
the dsh installation; dev dependencies are installed from npm for local development.

## License

[MIT](LICENSE)
