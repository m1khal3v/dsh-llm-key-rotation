<p align="center">
  <a href="https://www.npmjs.com/package/@m1khal3v/dsh-llm-key-rotation"><img alt="npm" src="https://img.shields.io/npm/v/@m1khal3v/dsh-llm-key-rotation?style=flat-square&color=4b6fff"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square"></a>
  <img alt="Status" src="https://img.shields.io/badge/status-beta-7da1de?style=flat-square">
  <a href="https://github.com/m1khal3v/dsh-llm-key-rotation"><img alt="GitHub" src="https://img.shields.io/badge/repo-m1khal3v%2Fdsh--llm--key--rotation-4b6fff?style=flat-square"></a>
</p>

# dsh-llm-key-rotation

Seamless API-key rotation for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) LLM
providers. When a model request hits a subscription limit (quota exhausted,
rate-limited, or auth failure), the plugin rotates to the next **additional** key and retries —
without a restart and without a model-visible surface.

The plugin manages only **additional keys on top of one primary key**. The primary key is
configured through the harness's main settings (the Models page / `apiKeyEnv`), never through
this plugin. On a failure the plugin writes each additional key as the active key in turn;
once every additional key has been tried it delegates to downstream recovery. There is no
indefinite `cycle` mode.

The project does not patch DeepSeek Harness core. Installing the plugin enables key
rotation, and removing it leaves no core modifications behind.

> Status: beta. Suitable for daily use with any DeepSeek Harness profile that mounts the
> `agent/request-error` recovery waterfall.

## How It Works

DeepSeek Harness adapters resolve the API key **once per model request** through the
`ctx.credentials` seam. This plugin hooks into the agent loop's `agent/request-error`
recovery waterfall: when a request fails with a configured trigger code (`QUOTA`,
`RATE_LIMIT`, `AUTH`), it writes the next **additional** pool key's value to the primary
credential reference the adapter reads, then returns `{ kind: 'retry' }`. The loop opens a
fresh turn that authenticates with the rotated key — the adapter re-resolves the reference
on the next request and picks up the new value automatically.

```text
primary key configured in main settings (Models)
model request fails (QUOTA / RATE_LIMIT / AUTH)
  → agent/request-error waterfall
  → llm-key-rotation listener
  → writes additional key[0] value to targetRef (primary ref)
  → [llm-key-rotation] rotated …  (stdout log)
  → return { kind: 'retry' }
  → loop opens a fresh turn → adapter re-resolves targetRef → new key
  → on success the primary key is restored to targetRef
```

## Quick Start

Prerequisites: one primary API key (configured through the harness main settings) and at
least one **additional** key for the same provider, stored as separate credential
references.

### Install the plugin

The `dsh` CLI is required. It comes from the `@deepseek-ai/dsh` package.

```sh
dsh plugin --profile web add @m1khal3v/dsh-llm-key-rotation
```

### Boot and configure

```sh
dsh web
```

Configure rotation profiles through the `llm-key-rotation:` settings section (written via
the web UI settings card or `$DSH_HOME/settings.yaml`):

```yaml
llm-key-rotation:
  providers:
    opencode:
      targetRef: OPENCODE_API_KEY
      poolRefs:
        - OPENCODE_API_KEY_2
        - OPENCODE_API_KEY_3
      triggerCodes:
        - QUOTA
        - RATE_LIMIT
        - AUTH
      maxIncidentRotations: 2
      cooldownMs: 60000
```

- `targetRef`: the **primary** reference the adapter reads (its `apiKeyEnv`). Set through
  the main settings, not the plugin.
- `poolRefs`: **additional** references only. An entry equal to `targetRef` is ignored, so a
  legacy profile whose head duplicated the primary still works.
- Store the additional key values as credentials (through the web card or the credentials
  API). The plugin reads only references, never values.

> **Important:** if you configure key rotation *before* the plugin 0.5 upgrade and your
> profile stored `targetRef` as the first element of `poolRefs`, that head is now ignored —
> the primary is no longer part of the rotation pool.

## Configuration

Each provider route gets one rotation profile:

| Field | Default | Meaning |
|---|---|---|
| `targetRef` | — (required) | **Primary** credential reference the adapter resolves per request (its `apiKeyEnv`). Configured in the main settings. |
| `poolRefs` | — (required, min 1) | Ordered chain of **additional** credential references. Rotation advances through these one per qualifying failure. |
| `triggerCodes` | `['QUOTA','AUTH']` | Failure codes that trigger a rotation. Common: `QUOTA`, `RATE_LIMIT`, `AUTH`. |
| `maxIncidentRotations` | number of extras | Optional hard cap on rotations per incident; a lower value tries fewer keys before delegating. |
| `cooldownMs` | none | Optional cooldown (ms) once the cap is reached, during which the plugin stops rotating this provider and delegates. |

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

Every rotation, exhaustion, cooldown, and primary-restore is written to **stdout of the
process that launches `dsh`** with a `[llm-key-rotation]` tag — e.g.:

```text
[llm-key-rotation] rotated provider="opencode" "OPENCODE_API_KEY"→"OPENCODE_API_KEY_2" (QUOTA) retry=1 rotationId=…
[llm-key-rotation] restored primary "OPENCODE_API_KEY" for provider "opencode"; index→0
```

Run `dsh web` from a terminal you can watch to confirm rotation works. No key values are
ever logged — only references, indices, and failure codes.

A live `llm/key-rotation` Cordis event is also emitted after each rotation for in-process
consumers (`ctx.on('llm/key-rotation', …)`); the event is non-durable.

## Pool Value Caching

Additional key values are cached at load and refreshed on settings change or
`credentials/updated` for a pool ref. The cache preserves original extra values even after
`targetRef` is overwritten by a rotation. After a successful model step the plugin restores
the **primary** value to `targetRef`, so the next incident begins from the primary again.

## Web UI Settings Card

The plugin ships a browser half that registers a **Key Rotation** card in the Plugins
settings page (`Settings → Plugins → Configurable`). The card:

- Shows each provider's **primary** reference and whether it is configured. If the primary
  is not configured, it shows "configure the primary key in the main settings first" and
  disables the additional-key editor.
- Lets you **add / remove / reorder additional keys** and store their values directly
  (values, not env-var names). Storing a key writes it to the credential store and saves the
  profile **automatically** — there is no Save button.
- Shows each additional key's **filled** state (a stored value exists) and sticker after the
  current store.
- Lets you pick which trigger codes rotate.

The card reads/writes through the same wire APIs the Models page uses, so no new host-side
code is required. The browser bundle is materialized through the dsh module system as
`lib/client.js`.

## Known Limitations

- **`targetRef` must not be shadowed by the environment** — `ctx.credentials.set` is
  rejected when a read-only environment variable supplies the same reference. Store
  additional keys under distinct references and let the plugin write them to `targetRef`
  through the managed credential store.
- **Pool values are cached at load** — a key added to a pool reference after startup is
  picked up through the `credentials/updated` event or a settings change, not by re-reading
  on every rotation.
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
