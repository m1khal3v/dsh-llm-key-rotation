/**
 * Seamless API-key rotation for DeepSeek Harness LLM providers.
 *
 * Mounts a listener on the agent loop's `agent/request-error` recovery
 * waterfall. When a model request for a configured provider fails with one of
 * the profile's trigger codes (typically an exhausted subscription quota), the
 * plugin writes the next key in the pool to the credential reference the
 * adapter reads and returns `{ kind: 'retry' }`, so the loop opens a fresh turn
 * that authenticates with the rotated key — no restart, no model-visible
 * surface. Adapters resolve the credential reference once per request, which is
 * what makes the rotation reach the very next request.
 *
 * Configuration carries only credential *references* (environment-variable
 * names), never values: `targetRef` is the reference the adapter resolves, and
 * `poolRefs` is the ordered chain. Values live in the credential store
 * (`ctx.credentials`), written through the web UI or the credentials API. The
 * plugin reads the `llm-key-rotation:` settings section (mounted on
 * `ctx.settings`) over its composition entry, so a changed profile takes effect
 * on the next failure without a restart.
 *
 * Pool values are cached at load and refreshed on settings change or
 * `credentials/updated` for a pool ref. The cache preserves the original key
 * values even after `targetRef` (often equal to `poolRefs[0]`) is overwritten by
 * a rotation, so cycling back to a previously-used pool entry writes the
 * original key rather than the one that replaced it.
 *
 * The listener registers after `dsh-llm-retry` in the waterfall (this bundle is
 * applied after `@deepseek-ai/dsh-base`), so for trigger codes that
 * `dsh-llm-retry` does not retry by default (`QUOTA`, `AUTH`), retry delegates
 * via `next()` and rotation acts immediately. For `RATE_LIMIT` (which
 * `dsh-llm-retry` retries by default), rotation acts after `dsh-llm-retry`
 * exhausts its retry budget; to rotate on `RATE_LIMIT` immediately, remove
 * `RATE_LIMIT` from the provider profile's `retryPolicy.retryableCodes`.
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

/** Default trigger codes when a profile omits `triggerCodes`: an exhausted subscription. */
const DEFAULT_TRIGGER_CODES = Object.freeze(['QUOTA'])

const profileSchema: z<RotationProfile> = z.object({
  targetRef: z.string().role('credential-ref').required(),
  poolRefs: z.array(z.string().min(1)).min(1).required(),
  triggerCodes: z.array(z.string().min(1)).min(1).default([...DEFAULT_TRIGGER_CODES]),
  onExhausted: z.union(['delegate', 'cycle']).default('delegate'),
})

/** Plugin config, also the `llm-key-rotation` settings-section shape. */
export interface Config {
  /** Rotation profiles keyed by provider route id (e.g. `deepseek-official`). */
  readonly providers: Readonly<Record<string, RotationProfile>>
}

export const Config: z<Config> = z.object({
  providers: z.dict(profileSchema).default({}),
})

/** Per-provider in-memory rotation state. */
interface RotationState {
  /** Credential-ref index currently active in the pool. */
  index: number
  /** Rotations committed since the last successful assistant message for this provider. */
  rotatedSinceSuccess: number
  /** Stable id for the current incident chain; reset on a successful step. */
  rotationId: RotationId
  /** Serializes advance + credential write + telemetry across concurrent errors for one provider. */
  chain: Promise<RequestErrorAction | undefined>
}

/** Cached key values for one provider's pool, keyed by pool index. */
type PoolCache = Map<number, string>

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
 * Install key rotation. The plugin owns no config beyond the provider profiles;
 * each profile owns its target reference, pool, trigger codes, and exhaustion
 * policy. Failures of the proactive seed and of an individual rotation are
 * warned and delegated, never fatal — a rotation that cannot write a new key
 * hands the failure to downstream recovery rather than crashing the loop.
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

  /** Per-provider pool-value cache; preserves original values across rotations. */
  const poolCaches = new Map<string, PoolCache>()

  /** Refresh the cached values for one provider's pool from the credential store. */
  const refreshCache = async (provider: string, profile: RotationProfile): Promise<void> => {
    const cache: PoolCache = new Map()
    for (const [index, ref] of profile.poolRefs.entries()) {
      const value = await resolveRef(credentialRef(ref))
      if (value !== undefined) cache.set(index, value)
    }
    poolCaches.set(provider, cache)
  }

  /** Refresh caches for all configured providers. */
  const refreshAllCaches = async (): Promise<void> => {
    for (const [provider, profile] of Object.entries(profiles())) {
      await refreshCache(provider, profile)
    }
  }

  /**
   * Best-effort proactive seed: when a profile's target reference is empty and
   * its first pool entry holds a value (and is a distinct reference), write that
   * value to the target so the first request authenticates without waiting for
   * a `MISSING_CREDENTIAL` failure. A same-reference pool head has nothing to
   * seed from; an empty pool head leaves onboarding to the adapter's own
   * missing-credential diagnostic.
   */
  const seedIfNeeded = async (provider: string, profile: RotationProfile): Promise<void> => {
    if (profile.targetRef === profile.poolRefs[0]) return
    const target = credentialRef(profile.targetRef)
    if ((await resolveRef(target)) !== undefined) return
    const first = poolCaches.get(provider)?.get(0)
      ?? await resolveRef(credentialRef(profile.poolRefs[0]!))
    if (first === undefined) return
    try {
      await ctx.credentials.set(target, first)
    } catch (error: unknown) {
      ctx.logger.warn('llm-key-rotation: could not seed "%s" from "%s"', profile.targetRef, profile.poolRefs[0])
      ctx.logger.warn(error)
    }
  }

  void refreshAllCaches().then(() => {
    for (const [provider, profile] of Object.entries(profiles())) void seedIfNeeded(provider, profile)
  })

  const states = new Map<string, RotationState>()

  const getState = (provider: string): RotationState => {
    let state = states.get(provider)
    if (state === undefined) {
      state = { index: 0, rotatedSinceSuccess: 0, rotationId: RotationId(randomUUID()), chain: Promise.resolve(undefined) }
      states.set(provider, state)
    }
    return state
  }

  // Reset the incident chain on a completed assistant message for this
  // provider: the active key worked, so the next qualifying failure starts a
  // fresh incident. `session/event` is a global observer feed.
  ctx.on('session/event', (_session, event) => {
    if (event.type !== 'assistant/message') return
    const source = event.data.message.source
    if (source.kind !== 'model') return
    const state = states.get(source.provider)
    if (state === undefined) return
    state.rotatedSinceSuccess = 0
    state.rotationId = RotationId(randomUUID())
  })

  // Refresh the cache when a pool ref's stored value changes (web UI write,
  // external edit, or programmatic set), so a newly-stored pool key is picked
  // up without a restart.
  ctx.on('credentials/updated', (ref: CredentialRef) => {
    const refStr = String(ref)
    for (const [provider, profile] of Object.entries(profiles())) {
      if (profile.poolRefs.includes(refStr)) void refreshCache(provider, profile)
    }
  })

  const lifetime = new AbortController()

  /**
   * Advance to the next pool key, write its cached value to the target
   * reference, emit telemetry, and return a retry action. Returns `undefined`
   * (delegate) when the pool is exhausted in delegate mode, when the next pool
   * entry has no cached value, or when writing the credential is rejected.
   */
  const rotate = async (
    provider: string,
    profile: RotationProfile,
    failure: LlmFailure,
    signal: AbortSignal,
  ): Promise<RequestErrorAction | undefined> => {
    const pool = profile.poolRefs
    const state = getState(provider)
    if (profile.onExhausted === 'delegate' && state.rotatedSinceSuccess >= pool.length - 1) {
      return undefined
    }
    const fused = AbortSignal.any([signal, lifetime.signal])
    if (fused.aborted) return undefined
    const fromIndex = state.index
    const toIndex = (fromIndex + 1) % pool.length
    const value = poolCaches.get(provider)?.get(toIndex)
    if (value === undefined) {
      ctx.logger.warn(
        'llm-key-rotation: pool ref "%s" for provider "%s" has no stored value; delegating',
        pool[toIndex], provider,
      )
      return undefined
    }
    try {
      await ctx.credentials.set(credentialRef(profile.targetRef), value)
    } catch (error: unknown) {
      ctx.logger.warn(
        'llm-key-rotation: could not write rotated key to "%s" for provider "%s"; delegating',
        profile.targetRef, provider,
      )
      ctx.logger.warn(error)
      return undefined
    }
    if (fused.aborted) return undefined
    state.index = toIndex
    state.rotatedSinceSuccess += 1
    const payload: KeyRotationEvent = {
      provider,
      rotationId: state.rotationId,
      triggerCode: failure.code,
      fromIndex,
      toIndex,
      retry: state.rotatedSinceSuccess,
      targetRef: profile.targetRef,
      failure,
    }
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
    if (profile === undefined || !profile.triggerCodes.includes(failure.code)) return next()
    const state = getState(provider)
    // Serialize rotations for one provider so concurrent errors (multiple
    // agents on the same route) advance the index and write the credential in
    // order rather than racing on the shared reference.
    const result = state.chain
      .then(() => (lifetime.signal.aborted ? undefined : rotate(provider, profile, failure, signal)))
      .catch((error: unknown) => {
        // A rotation failure must never break the recovery waterfall; delegate.
        ctx.logger.warn('llm-key-rotation: rotation for provider "%s" failed; delegating', provider)
        ctx.logger.warn(error)
        return undefined
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
      // A changed profile set refreshes caches and re-seeds newly-configured targets.
      void refreshAllCaches().then(() => {
        for (const [provider, profile] of Object.entries(profiles())) void seedIfNeeded(provider, profile)
      })
    },
  })
}
