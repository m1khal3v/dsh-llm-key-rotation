<p align="center">
  <a href="https://www.npmjs.com/package/@m1khal3v/dsh-llm-key-rotation"><img alt="npm" src="https://img.shields.io/npm/v/@m1khal3v/dsh-llm-key-rotation?style=flat-square&color=4b6fff"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square"></a>
  <img alt="Status" src="https://img.shields.io/badge/status-beta-7da1de?style=flat-square">
  <a href="https://github.com/m1khal3v/dsh-llm-key-rotation"><img alt="GitHub" src="https://img.shields.io/badge/repo-m1khal3v%2Fdsh--llm--key--rotation-4b6fff?style=flat-square"></a>
</p>

# dsh-llm-key-rotation

Seamless API-key rotation for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) LLM
providers. When a model request hits a subscription limit (quota exhausted,
rate-limited, or auth failure), the plugin rotates to the next key in a
pre-configured chain and retries — without a restart, without a model-visible
surface, and without patching the harness core.

The project does not patch DeepSeek Harness core. Installing the plugin enables
key rotation, and removing it leaves no core modifications behind.

> Status: beta. Suitable for daily use with any DeepSeek Harness profile that
> mounts the `agent/request-error` recovery waterfall.

## How It Works

DeepSeek Harness adapters resolve the API key **once per model request** through
the `ctx.credentials` seam. This plugin hooks into the agent loop's
`agent/request-error` recovery waterfall: when a request fails with a configured
trigger code (`QUOTA`, `RATE_LIMIT`, `AUTH`), it writes the next pool key's value
to the credential reference the adapter reads, then returns `{ kind: 'retry' }`.
The loop opens a fresh turn that authenticates with the rotated key — the
adapter re-resolves the credential reference on the next request and picks up the
new value automatically.

```text
model request fails (QUOTA / RATE_LIMIT / AUTH)
  → agent/request-error waterfall
  → llm-key-rotation listener
  → ctx.credentials.set(targetRef, nextPoolKey)
  → ctx.emit('llm/key-rotation', telemetry)
  → return { kind: 'retry' }
  → loop opens a fresh turn
  → adapter re-resolves targetRef → new key
  → request authenticates with the rotated key
```

## Quick Start

Prerequisites: at least two API keys for the same provider, stored as separate
credential references.

### Install the plugin

The `dsh` CLI is required. It comes from the `@deepseek-ai/dsh` package, which
you may have installed globally or run from a source checkout. Both paths are
shown below — pick the one that matches your setup.

**Case A — `dsh` installed globally** (`npm install -g @deepseek-ai/dsh`):

```sh
# From npm (prebuilt lib/, no build permission needed)
dsh plugin --profile web add @m1khal3v/dsh-llm-key-rotation

# Or from GitHub (runs the prepare build script at install time; pnpm >=10
# asks you to allow it — see "Installing from GitHub" below)
dsh plugin --profile web add github:m1khal3v/dsh-llm-key-rotation

# Or from a local tarball (no network)
npm pack   # in the plugin directory, produces a .tgz
dsh plugin --profile web add ./m1khal3v-dsh-llm-key-rotation-0.1.0.tgz
```

**Case B — running `dsh` from a source checkout** (the `deepseek-harness`
repository cloned locally):

```sh
cd /path/to/deepseek-harness

# Prefix every dsh command with pnpm
pnpm dsh plugin --profile web add @m1khal3v/dsh-llm-key-rotation

pnpm dsh --profile web --dump-config   # verify the plugin row appears
pnpm dsh --profile web                  # boot
```

**Case C — no `dsh` CLI yet.** Install it first:

```sh
npm install -g @deepseek-ai/dsh
dsh --version   # confirm
```

Then follow Case A above.

### Boot and configure

```sh
dsh --profile web
```

Configure rotation profiles through the `llm-key-rotation:` settings section
(written via `dsh` settings, the web UI, or `$DSH_HOME/settings.yaml`):

```yaml
llm-key-rotation:
  providers:
    opencode:
      targetRef: OPENCODE_API_KEY
      poolRefs:
        - OPENCODE_API_KEY
        - OPENCODE_API_KEY_2
        - OPENCODE_API_KEY_3
      triggerCodes:
        - QUOTA
        - RATE_LIMIT
        - AUTH
      onExhausted: delegate
```

Store the key values as credentials (through the web Models page or the
credentials API). The plugin reads only references, never values — secrets stay
in the credential store.

### Installing from GitHub

A git install fetches sources, not built artifacts, so pnpm runs the package's
`prepare` script to build `lib/` at install time. pnpm ≥10 refuses to run a git
dependency's build script until you allow it. The first `add` fails; `dsh`
points at the fix — copy the exact package key pnpm printed into the profile's
`pnpm-workspace.yaml`:

```yaml
# $DSH_HOME/profiles/web/pnpm-workspace.yaml
allowBuilds:
  '@m1khal3v/dsh-llm-key-rotation': true
```

Then re-run `dsh plugin --profile web add github:m1khal3v/dsh-llm-key-rotation`.

Treat that allowance as what it is: permission to execute the package's code on
your machine at install time. Only allow packages whose source you trust, and
pin a commit (`github:m1khal3v/dsh-llm-key-rotation#<sha>`) so a later push
cannot silently change what runs.

Installing from npm or a tarball needs no build permission — the published
tarball already carries prebuilt `lib/`.

## Configuration

Each provider route gets one rotation profile:

| Field | Default | Meaning |
|---|---|---|
| `targetRef` | — (required) | Credential reference the adapter resolves per request (its `apiKeyEnv`). Rotation writes each pool key's value here. |
| `poolRefs` | — (required, min 1) | Ordered chain of credential references. Rotation advances through these one per qualifying failure. |
| `triggerCodes` | `['QUOTA']` | Failure codes that trigger a rotation. Common: `QUOTA`, `RATE_LIMIT`, `AUTH`. |
| `onExhausted` | `delegate` | Behavior once every pool key has been tried: `delegate` hands the failure to downstream recovery (dsh-llm-retry or terminal), `cycle` restarts the chain indefinitely. |

### Composition entry (cordis.patch.yml)

The bundle's patch file inserts one plugin row. It is applied after
`@deepseek-ai/dsh-base`, so the listener registers after `dsh-llm-retry` in the
waterfall:

```yaml
- insert:
    - id: llm-key-rotation
      name: '@m1khal3v/dsh-llm-key-rotation'
      config:
        providers: {}
```

Users override `providers` through the settings section without touching the
bundle.

## Composition with dsh-llm-retry

This listener registers **after** `dsh-llm-retry` in the `agent/request-error`
waterfall (the bundle is applied after `@deepseek-ai/dsh-base`). The interaction
depends on which trigger codes are configured:

- **`QUOTA` and `AUTH`** are NOT in `dsh-llm-retry`'s default `retryableCodes`,
  so `dsh-llm-retry` delegates via `next()` and rotation acts immediately.
- **`RATE_LIMIT`** IS in `dsh-llm-retry`'s default `retryableCodes`, so
  `dsh-llm-retry` intercepts it first and retries with backoff. Rotation acts
  only after `dsh-llm-retry` exhausts its retry budget and delegates. To rotate
  on `RATE_LIMIT` immediately, remove `RATE_LIMIT` from the provider profile's
  `retryPolicy.retryableCodes`.

## Telemetry

The plugin emits a live `llm/key-rotation` Cordis event after each rotation
commits. The event is non-durable — it never enters the session log, so a harness
that does not know this plugin's event type can still resume sessions that
produced it. Telemetry or observation plugins listen with:

```ts
ctx.on('llm/key-rotation', (event) => {
  console.log(`rotated ${event.provider}: key #${event.fromIndex} → #${event.toIndex} (${event.triggerCode})`)
})
```

The event payload carries: `provider`, `rotationId`, `triggerCode`, `fromIndex`,
`toIndex`, `retry`, `targetRef`, and the normalized `failure`.

## Pool Value Caching

Pool key values are cached at load and refreshed on settings change or
`credentials/updated` for a pool ref. The cache preserves the original key
values even after `targetRef` (often equal to `poolRefs[0]`) is overwritten by a
rotation, so cycling back to a previously-used pool entry writes the original key
rather than the one that replaced it.

## Proactive Seeding

When a profile's `targetRef` is empty and its first pool entry (`poolRefs[0]`)
holds a value and is a distinct reference, the plugin writes that value to
`targetRef` at load time. This lets the first request authenticate without
waiting for a `MISSING_CREDENTIAL` failure. A same-reference pool head
(`targetRef === poolRefs[0]`) has nothing to seed from; an empty pool head leaves
onboarding to the adapter's own missing-credential diagnostic.

## Model Experience

### Key rotation recovery

#### What the model sees

No rotation event, credential write, provider error, or failed partial output
is model-visible. The retry turn reconstructs the same explicit provider/model
request from durable surface history; failed chunks never enter derived
messages. The rotated key reaches the next request through the credential seam
with no prompt or system-prompt change.

#### Token effect

Each rotation opens a new provider request and may repeat input-token billing.
`onExhausted: delegate` limits rotations to `poolRefs.length - 1` per incident;
`onExhausted: cycle` can consume unbounded requests until success or
cancellation. The `llm/key-rotation` event itself contributes no tokens.

#### KV Cache effect

The reconstructed request preserves the prior prefix and is eligible for
provider cache reuse under that provider's rules. The non-surface rotation event
and credential write do not change cache identity.

## Known Limitations

- **`targetRef` must not be shadowed by the environment** — `ctx.credentials.set`
  is rejected when a read-only environment variable supplies the same reference.
  Store pool keys under distinct references (e.g. `OPENCODE_API_KEY_2`,
  `_3`) and let the plugin write the active key to `targetRef` through the
  managed credential store.
- **Pool values are cached at load** — a key added to a pool reference after
  startup is picked up through the `credentials/updated` event or a settings
  change, not by re-reading on every rotation.
- **`RATE_LIMIT` rotation follows `dsh-llm-retry`'s budget** — because
  `RATE_LIMIT` is in `dsh-llm-retry`'s default retryable codes, rotation on
  `RATE_LIMIT` acts only after `dsh-llm-retry` exhausts its retry budget. Remove
  `RATE_LIMIT` from the provider's `retryPolicy.retryableCodes` to rotate
  immediately.
- **The `llm/key-rotation` event is non-durable** — it is a live Cordis event,
  not a session-log event. Telemetry consumers must listen in-process; the event
  does not survive a session reload.
- **One credential serves every model on a route** — rotation is per provider
  route, not per model. All models on a rotated route share the same active key.

## Development

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test
pnpm run build
```

Node `^22.19 || >=24`. The package depends on `@deepseek-ai/dsh-*` peer packages
provided by the dsh installation; dev dependencies are installed from npm for
local development and testing.

## License

[MIT](LICENSE)
