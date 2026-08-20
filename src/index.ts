/**
 * Seamless API-key rotation for DeepSeek Harness LLM providers.
 *
 * Mounts a listener on the agent loop's `agent/request-error` recovery
 * waterfall. When a model request for a configured provider fails with one of
 * the profile's `rotate_on` trigger codes (typically an exhausted subscription
 * quota or an auth failure), the plugin writes the next key from the provider's
 * key chain into the credential reference the adapter reads and returns
 * `{ kind: 'retry' }`, so the loop opens a fresh turn that authenticates with
 * the rotated key — no restart, no model-visible surface. Adapters resolve the
 * credential reference once per request, which is what makes the rotation reach
 * the very next request.
 *
 * Configuration carries only provider flags and credential *references* — never
 * key values. Each profile is `{ enabled, rotate_on, apiKeyEnvChain }` keyed by
 * provider route id. The active key lives in the provider's environment
 * reference (`envRefOf(provider)`, e.g. `OPENCODE_GO_API_KEY`). The spare keys
 * live one per reference listed in `apiKeyEnvChain` (e.g. `OPENCODE_GO_API_KEY_CHAIN_1`,
 * `OPENCODE_GO_API_KEY_CHAIN_2`, …), with values stored through the credential
 * store (the web card writes them there) and read at rotation time.
 *
 * Walk discipline (no unbounded spinning), keyed to the last write timestamp:
 *   - The latest spare-key write carries a timestamp. A failing request that
 *     arrives within 300 s of it advances to the NEXT chain entry (a live series
 *     of failures walks the chain forward).
 *   - A failing request that arrives 300 s or more after the last write starts
 *     again from chain head (index 0) — the previously-last key may have become
 *     stale, so retry the spares from the beginning.
 *   - If no `apiKeyEnvChain` key is stored (or the provider is disabled), the
 *     plugin hands the failure to downstream recovery immediately. Once every
 *     chain key has been written within one 300 s window and a failure still
 *     arrives, the plugin delegates rather than spinning forever.
 * `envRef` is never restored after success: it keeps the last written (working or
 * last-tried) key.
 *
 * The listener registers after `dsh-llm-retry` in the waterfall (this bundle is
 * applied after `@deepseek-ai/dsh-base`), so for trigger codes that
 * `dsh-llm-retry` does not retry by default (`QUOTA`, `AUTH`), retry delegates
 * via `next()` and rotation acts immediately. For `RATE_LIMIT` (which
 * `dsh-llm-retry` retries by default), rotation acts after `dsh-llm-retry`
 * exhausts its retry budget; to rotate on `RATE_LIMIT` immediately, remove
 * `RATE_LIMIT` from the provider profile's `retryPolicy.retryableCodes`.
 *
 * Every rotation, delegate, and chain reset is logged to stdout through
 * `console.log`/`console.error` with a `[llm-key-rotation]` tag, so operation is
 * confirmable by watching the launching process's terminal. No key values are
 * ever logged. (`ctx.logger` is intentionally not used for these: in the dsh
 * web build it only buffers and never prints to the terminal.)
 *
 * @module @m1khal3v/dsh-llm-key-rotation
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import type { Agent, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { RotationId } from './brand.ts'
import type { KeyRotationEvent, RotationProfile } from './types.ts'

export type { KeyRotationEvent, RotationProfile } from './types.ts'
export { RotationId } from './brand.ts'

export const name = 'llm-key-rotation'
export const inject = ['agents', 'credentials']

const NS = settingsNamespace('llm-key-rotation')

/**
 * Default rotating codes when a profile omits `rotate_on`. Only codes that
 * dsh-llm-retry does NOT retry by default — QUOTA and AUTH reach this plugin
 * immediately because llm-retry delegates via next(). RATE_LIMIT IS in
 * llm-retry's default retryableCodes, so it is intercepted first; include it
 * only if the provider profile removes RATE_LIMIT from retryPolicy.retryableCodes.
 */
const DEFAULT_ROTATE_ON = Object.freeze(['QUOTA', 'AUTH'])

/** How long a spare-key write stays "fresh": failures within this window continue the chain. */
const CHAIN_WINDOW_MS = 300_000

/** Derive the provider's env (apiKeyEnv) reference from its route id by convention. */
export function envRefOf(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

const profileSchema: z<RotationProfile> = z.object({
  enabled: z.boolean().default(false),
  rotate_on: z.array(z.string().min(1)).min(1).default([...DEFAULT_ROTATE_ON]),
  apiKeyEnvChain: z.array(z.string().role('credential-ref')).default([]),
})

/** Plugin config, also the `llm-key-rotation` settings-section shape. */
export interface Config {
  /** Rotation profiles keyed by provider route id (e.g. `opencode-go`). */
  readonly providers: Readonly<Record<string, RotationProfile>>
}

export const Config: z<Config> = z.object({
  providers: z.dict(profileSchema).default({}),
})

/** Per-provider in-memory rotation state. */
interface RotationState {
  /**
   * Index of the next chain entry to try on a fresh window, or the index already
   * walked past within the current window (0 = start from head).
   */
  nextIndex: number
  /** Epoch-ms of the last spare-key write, or `undefined` before any rotation. */
  lastWriteAt: number | undefined
  /** Stable id for the current incident chain; refreshed on a fresh window. */
  rotationId: RotationId
  /** Serializes advance + credential write + telemetry across concurrent errors for one provider. */
  chain: Promise<RequestErrorAction | undefined>
}

/** Cached spare-key values for one provider, indexed by position in `apiKeyEnvChain`. */
const chainCaches = new Map<string, Array<string | undefined>>()

/** The `agent/request-error` payload fields this plugin reads. */
interface RequestErrorPayload {
  readonly agent: Agent
  readonly turn: number
  readonly step: number
  readonly provider: string
  readonly failure: LlmFailure
  readonly signal: AbortSignal
}

/**
 * Install key rotation. Each provider profile owns its `enabled` flag, `rotate_on`
 * codes, and `apiKeyEnvChain` reference list; the key values live in the credential
 * store. Failures of a rotation are logged and delegated, never fatal — a rotation
 * that cannot write a value hands the failure to downstream recovery rather than
 * crashing the loop.
 * @param ctx - plugin context carrying the agent registry and credential seam.
 * @param config - composition entry config; the `llm-key-rotation:` settings section overrides it live.
 */
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  const profiles = (): Readonly<Record<string, RotationProfile>> => current().providers

  /** Resolve one credential reference to its stored value, or `undefined` when unset. */
  const resolveRef = async (ref: CredentialRef): Promise<string | undefined> => {
    const hit = await ctx.credentials.resolve(ref)
    return hit?.value
  }

  /** Refresh the cached spare-key values for one provider from its `apiKeyEnvChain` refs. */
  const refreshChain = async (provider: string, profile: RotationProfile): Promise<void> => {
    const values: Array<string | undefined> = []
    for (const ref of profile.apiKeyEnvChain) {
      values.push(await resolveRef(credentialRef(ref)))
    }
    chainCaches.set(provider, values)
  }

  /** Refresh chain caches for all providers. */
  const refreshAllChains = async (): Promise<void> => {
    for (const [provider, profile] of Object.entries(profiles())) {
      await refreshChain(provider, profile)
    }
  }

  void refreshAllChains()

  const states = new Map<string, RotationState>()

  const getState = (provider: string): RotationState => {
    let state = states.get(provider)
    if (state === undefined) {
      state = { nextIndex: 0, lastWriteAt: undefined, rotationId: RotationId(randomUUID()), chain: Promise.resolve(undefined) }
      states.set(provider, state)
    }
    return state
  }

  // Refresh a changed chain cache when any of a provider's chain refs changes,
  // so a newly-stored spare key is picked up without a restart.
  ctx.on('credentials/updated', (ref: CredentialRef) => {
    const refStr = String(ref)
    for (const [provider, profile] of Object.entries(profiles())) {
      if (profile.apiKeyEnvChain.includes(refStr)) void refreshChain(provider, profile)
    }
  })

  /** The ordered, non-empty spare-key list for a provider. */
  const usableChain = (provider: string): string[] =>
    (chainCaches.get(provider) ?? []).filter((value): value is string => value !== undefined && value.length > 0)

  const lifetime = new AbortController()

  /**
   * Attempt one rotation: write `chain[toIndex]` into the env reference, log and
   * emit telemetry, and return a retry action. Returns `undefined` (delegate)
   * when the chain is empty, the window is exhausted (every chain key tried this
   * window), or the credential write is rejected.
   */
  const rotate = async (
    provider: string,
    failure: LlmFailure,
    signal: AbortSignal,
  ): Promise<RequestErrorAction | undefined> => {
    const state = getState(provider)
    const chainKeys = usableChain(provider)
    if (chainKeys.length === 0) {
      console.error('[llm-key-rotation] provider "%s" has no stored chain keys; delegating', provider)
      return undefined
    }
    const now = Date.now()
    const fresh = state.lastWriteAt !== undefined && (now - state.lastWriteAt) < CHAIN_WINDOW_MS
    let startIndex: number
    if (fresh) {
      startIndex = state.nextIndex
      if (startIndex >= chainKeys.length) {
        // Every chain key was already written within this window and failures
        // keep arriving: none worked — delegate instead of spinning forever.
        console.error(
          '[llm-key-rotation] provider "%s" exhausted all %d chain keys within the window; delegating',
          provider, chainKeys.length,
        )
        return undefined
      }
    } else {
      // Stale write (or first rotation): start over from the chain head.
      startIndex = 0
    }

    const fused = AbortSignal.any([signal, lifetime.signal])
    if (fused.aborted) return undefined
    const toRef = envRefOf(provider)
    const value = chainKeys[startIndex]!
    const lastWritten = state.lastWriteAt
    try {
      await ctx.credentials.set(credentialRef(toRef), value)
    } catch (error: unknown) {
      console.error(
        '[llm-key-rotation] could not write rotated key to "%s" for provider "%s"; delegating',
        toRef, provider,
      )
      console.error(error)
      return undefined
    }
    if (fused.aborted) return undefined
    state.lastWriteAt = now
    state.nextIndex = startIndex + 1
    state.rotationId = RotationId(randomUUID())
    const payload: KeyRotationEvent = {
      provider,
      rotationId: state.rotationId,
      triggerCode: failure.code,
      toRef,
      chainIndex: startIndex,
      targetRef: toRef,
      failure,
    }
    console.log(
      '[llm-key-rotation] rotated provider="%s" chain[%d]→"%s" (%s) window=%s lastWriteAge=%s',
      provider, startIndex, toRef, failure.code,
      fresh ? 'fresh' : 'fresh-start',
      lastWritten === undefined ? '–' : `${Math.round((now - lastWritten) / 1000)}s`,
    )
    ctx.emit('llm/key-rotation', payload)
    return { kind: 'retry' }
  }

  const disposeListener = ctx.on('agent/request-error', (
    payload: RequestErrorPayload,
    next: () => Promise<RequestErrorAction>,
  ): Promise<RequestErrorAction | undefined> => {
    if (lifetime.signal.aborted) return Promise.resolve<RequestErrorAction | undefined>(undefined)
    const { provider, failure, signal } = payload
    const profile = profiles()[provider]
    if (profile === undefined || !profile.enabled || !profile.rotate_on.includes(failure.code)) return next()
    const state = getState(provider)
    // Serialize rotations for one provider so concurrent errors (multiple
    // agents on the same route) advance the chain and write the credential in
    // order rather than racing on the shared reference.
    const result = state.chain
      .then(() => (lifetime.signal.aborted ? undefined : rotate(provider, failure, signal)))
      .then((action) => action ?? next())
      .catch((error: unknown) => {
        // A rotation failure must never break the recovery waterfall; delegate.
        console.error('llm-key-rotation: rotation for provider "%s" failed; delegating', provider)
        console.error(error)
        return next()
      })
    state.chain = result.then(() => undefined, () => undefined)
    return result
  })

  ctx.effect(() => async () => {
    disposeListener()
    lifetime.abort(new Error('llm-key-rotation plugin disposed'))
    await Promise.allSettled([...states.values()].map(state => state.chain))
  }, 'llm-key-rotation: abort and drain active rotations')

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: () => {
      void refreshAllChains()
    },
  })
}
