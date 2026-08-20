/**
 * Seamless API-key rotation for DeepSeek Harness LLM providers.
 *
 * Mounts a listener on the agent loop's `agent/request-error` recovery
 * waterfall. When a model request for a configured provider fails with one of
 * the profile's trigger codes (typically an exhausted subscription quota or an
 * auth failure), the plugin writes an *additional* pool key's value to the
 * credential reference the adapter reads and returns `{ kind: 'retry' }`, so
 * the loop opens a fresh turn that authenticates with the rotated key — no
 * restart, no model-visible surface. Adapters resolve the credential reference
 * once per request, which is what makes the rotation reach the very next
 * request.
 *
 * The plugin manages only **additional keys on top of one primary key**. The
 * primary key lives in the provider's `apiKeyEnv` reference (`targetRef` here)
 * and is configured through the harness main settings (Models page), never through
 * this plugin. `poolRefs` lists the additional references only; entries equal to
 * `targetRef` are ignored, so a legacy profile whose pool head duplicated the
 * primary degrades gracefully to extras-only. On a qualifying failure the plugin
 * writes each extra key's value into `targetRef` in order; once every extra has
 * been tried it delegates to downstream recovery. There is no `cycle` mode: an
 * incident never rotates indefinitely. After a successful model step the plugin
 * restores the primary key to `targetRef`, so the next incident begins from the
 * primary again.
 *
 * Configuration carries only credential *references* (environment-variable
 * names), never values: `targetRef` is the reference the adapter resolves, and
 * `poolRefs` is the additional chain. Values live in the credential store
 * (`ctx.credentials`), written through the web UI or the credentials API. The
 * plugin reads the `llm-key-rotation:` settings section (mounted on
 * `ctx.settings`) over its composition entry, so a changed profile takes effect
 * on the next failure without a restart.
 *
 * Pool values are cached at load and refreshed on settings change or
 * `credentials/updated` for a pool ref. The cache preserves the original key
 * values even after `targetRef` is overwritten by a rotation, so a return to a
 * previously-used pool entry (and the primary-key restore) writes the original
 * value rather than the one that replaced it.
 *
 * The listener registers after `dsh-llm-retry` in the waterfall (this bundle is
 * applied after `@deepseek-ai/dsh-base`), so for trigger codes that
 * `dsh-llm-retry` does not retry by default (`QUOTA`, `AUTH`), retry delegates
 * via `next()` and rotation acts immediately. For `RATE_LIMIT` (which
 * `dsh-llm-retry` retries by default), rotation acts after `dsh-llm-retry`
 * exhausts its retry budget; to rotate on `RATE_LIMIT` immediately, remove
 * `RATE_LIMIT` from the provider profile's `retryPolicy.retryableCodes`.
 *
 * Every rotation, seed decision, cap, and cooldown is logged to stdout through
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
 * Default trigger codes when a profile omits `triggerCodes`. Only codes that
 * dsh-llm-retry does NOT retry by default — QUOTA and AUTH reach this plugin
 * immediately because llm-retry delegates via next(). RATE_LIMIT IS in
 * llm-retry's default retryableCodes, so it is intercepted first; include it
 * only if the provider profile removes RATE_LIMIT from retryPolicy.retryableCodes.
 */
const DEFAULT_TRIGGER_CODES = Object.freeze(['QUOTA', 'AUTH'])

const profileSchema: z<RotationProfile> = z.object({
  targetRef: z.string().role('credential-ref').required(),
  poolRefs: z.array(z.string().min(1)).min(1).required(),
  triggerCodes: z.array(z.string().min(1)).min(1).default([...DEFAULT_TRIGGER_CODES]),
  /**
   * Optional hard cap on rotations per incident. Defaults to the number of
   * additional keys (each extra is tried at most once). A lower value allows
   * trying fewer keys before delegating.
   */
  maxIncidentRotations: z.natural().min(1),
  /**
   * Optional cooldown in milliseconds applied once `maxIncidentRotations` is
   * reached: the plugin stops rotating this provider for the window and
   * delegates, preventing a rapid refire loop from hammering the keys.
   */
  cooldownMs: z.natural().min(0),
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
  /**
   * Index of the last-written additional key, or `-1` while the primary is
   * active (nothing has been rotated this incident).
   */
  index: number
  /** Rotations committed since the last successful assistant message for this provider. */
  rotatedSinceSuccess: number
  /** Stable id for the current incident chain; reset on a successful step. */
  rotationId: RotationId
  /** Epoch-ms until which this provider refuses to rotate (0 = no cooldown). */
  cooldownUntil: number
  /** Serializes advance + credential write + telemetry across concurrent errors for one provider. */
  chain: Promise<RequestErrorAction | undefined>
}

/** Cached key values for one provider: the primary plus each additional pool key, keyed by pool index. */
type PoolCache = Map<number, string>

/** Cached primary-key value preserved across rotations (so it can be restored after success). */
type PrimaryValue = string | undefined

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
 * each profile owns its target (primary) reference and its additional pool.
 * Failures of a rotation are warned and delegated, never fatal — a rotation
 * that cannot write a new key hands the failure to downstream recovery rather
 * than crashing the loop.
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

  /**
   * The effective rotation pool for a profile: its `poolRefs` with any entry
   * equal to `targetRef` removed. The plugin rotates only additional keys; the
   * primary (`targetRef`) is the baseline the extras replace during an incident.
   */
  const extrasOf = (profile: RotationProfile): string[] => profile.poolRefs.filter((ref) => ref !== profile.targetRef)

  /** Per-provider pool-value cache; preserves original extra values across rotations. */
  const poolCaches = new Map<string, PoolCache>()
  /** Per-provider cached primary value, preserved so it can be restored after a successful incident. */
  const primaryValues = new Map<string, PrimaryValue>()

  /** Refresh the cached values for one provider's pool (primary + extras) from the credential store. */
  const refreshCache = async (provider: string, profile: RotationProfile): Promise<void> => {
    const cache: PoolCache = new Map()
    const extras = extrasOf(profile)
    for (const [index, ref] of extras.entries()) {
      const value = await resolveRef(credentialRef(ref))
      if (value !== undefined) cache.set(index, value)
    }
    poolCaches.set(provider, cache)
    const primary = await resolveRef(credentialRef(profile.targetRef))
    primaryValues.set(provider, primary)
    if (primary === undefined) {
      console.error(
        '[llm-key-rotation] provider "%s" primary key "%s" is not configured; '
          + 'configure it in the main settings (Models) before adding additional keys',
        provider, profile.targetRef,
      )
    }
  }

  /** Refresh caches for all configured providers. */
  const refreshAllCaches = async (): Promise<void> => {
    for (const [provider, profile] of Object.entries(profiles())) {
      await refreshCache(provider, profile)
    }
  }

  void refreshAllCaches()

  /**
   * Reset this provider's incident state synchronously (so a concurrent failure
   * sees a fresh incident) and, in the background, restore the primary key to
   * `targetRef` if the incident had rotated away from it.
   */
  const restorePrimary = (provider: string, profile: RotationProfile): void => {
    const state = getState(provider)
    const wasRotated = state.rotatedSinceSuccess > 0
    const primary = primaryValues.get(provider)
    state.index = -1
    state.rotatedSinceSuccess = 0
    state.cooldownUntil = 0
    state.rotationId = RotationId(randomUUID())
    if (!wasRotated || primary === undefined) return
    void (async () => {
      try {
        await ctx.credentials.set(credentialRef(profile.targetRef), primary)
        console.log(
          '[llm-key-rotation] restored primary "%s" for provider "%s"; index→0',
          profile.targetRef, provider,
        )
      } catch (error: unknown) {
        console.error(
          '[llm-key-rotation] could not restore primary "%s" for provider "%s"',
          profile.targetRef, provider,
        )
        console.error(error)
      }
    })()
  }

  const states = new Map<string, RotationState>()

  const getState = (provider: string): RotationState => {
    let state = states.get(provider)
    if (state === undefined) {
      state = { index: -1, rotatedSinceSuccess: 0, rotationId: RotationId(randomUUID()), cooldownUntil: 0, chain: Promise.resolve(undefined) }
      states.set(provider, state)
    }
    return state
  }

  // Reset the incident chain (and restore the primary) on a completed assistant
  // message for this provider: the active key worked, so the next qualifying
  // failure starts a fresh incident from the primary. `session/event` is a
  // global observer feed.
  ctx.on('session/event', (_session, event) => {
    if (event.type !== 'assistant/message') return
    const source = event.data.message.source
    if (source.kind !== 'model') return
    const provider = source.provider
    const profile = profiles()[provider]
    if (profile === undefined) return
    const state = states.get(provider)
    if (state === undefined) return
    restorePrimary(provider, profile)
  })

  // Refresh the cache when a pool ref's stored value changes (web UI write,
  // external edit, or programmatic set), so a newly-stored pool key is picked
  // up without a restart.
  ctx.on('credentials/updated', (ref: CredentialRef) => {
    const refStr = String(ref)
    for (const [provider, profile] of Object.entries(profiles())) {
      if (profile.poolRefs.includes(refStr) || profile.targetRef === refStr) {
        void refreshCache(provider, profile)
      }
    }
  })

  const lifetime = new AbortController()

  /**
   * Advance to the next additional key, write its cached value to the target
   * reference, log and emit telemetry, and return a retry action. Returns
   * `undefined` (delegate) when the pool is exhausted or the cap is reached,
   * when in cooldown, when the next extra has no cached value, or when writing
   * the credential is rejected.
   */
  const rotate = async (
    provider: string,
    profile: RotationProfile,
    failure: LlmFailure,
    signal: AbortSignal,
  ): Promise<RequestErrorAction | undefined> => {
    const extras = extrasOf(profile)
    const state = getState(provider)
    const now = Date.now()

    // Cooldown: refuse to rotate this provider and delegate.
    if (now < state.cooldownUntil) {
      const remainingMs = state.cooldownUntil - now
      console.error(
        '[llm-key-rotation] provider "%s" in cooldown (~%d ms remaining); delegating',
        provider, remainingMs,
      )
      return undefined
    }

    const toIndex = state.index + 1
    const cap = profile.maxIncidentRotations ?? extras.length
    if (toIndex >= extras.length || state.rotatedSinceSuccess >= cap) {
      // Incident exhausted: enter cooldown if requested, then delegate to
      // downstream recovery (llm-retry or terminal). NOT `undefined` alone —
      // undefined IS the delegate action returned here, letting the waterfall
      // reach llm-retry's own recovery path.
      if (profile.cooldownMs !== undefined && profile.cooldownMs > 0) {
        state.cooldownUntil = now + profile.cooldownMs
        console.error(
          '[llm-key-rotation] provider "%s" exhausted after %d rotation(s); entering cooldown %d ms and delegating',
          provider, state.rotatedSinceSuccess, profile.cooldownMs,
        )
      } else {
        console.error(
          '[llm-key-rotation] provider "%s" exhausted after %d rotation(s); delegating',
          provider, state.rotatedSinceSuccess,
        )
      }
      return undefined
    }

    const fused = AbortSignal.any([signal, lifetime.signal])
    if (fused.aborted) return undefined
    const fromRef = state.index < 0 ? profile.targetRef : extras[state.index]
    const toRef = extras[toIndex]!
    const value = poolCaches.get(provider)?.get(toIndex)
    if (value === undefined) {
      console.error(
        '[llm-key-rotation] pool ref "%s" for provider "%s" has no stored value; delegating',
        toRef, provider,
      )
      return undefined
    }
    try {
      await ctx.credentials.set(credentialRef(profile.targetRef), value)
    } catch (error: unknown) {
      console.error(
        '[llm-key-rotation] could not write rotated key to "%s" for provider "%s"; delegating',
        profile.targetRef, provider,
      )
      console.error(error)
      return undefined
    }
    if (fused.aborted) return undefined
    state.index = toIndex
    state.rotatedSinceSuccess += 1
    const payload: KeyRotationEvent = {
      provider,
      rotationId: state.rotationId,
      triggerCode: failure.code,
      fromRef,
      toRef,
      retry: state.rotatedSinceSuccess,
      targetRef: profile.targetRef,
      failure,
    }
    console.log(
      '[llm-key-rotation] rotated provider="%s" "%s"→"%s" (%s) retry=%d rotationId=%s',
      provider, fromRef, toRef, failure.code, state.rotatedSinceSuccess, state.rotationId,
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
    if (profile === undefined || !profile.triggerCodes.includes(failure.code)) return next()
    const state = getState(provider)
    // Serialize rotations for one provider so concurrent errors (multiple
    // agents on the same route) advance the index and write the credential in
    // order rather than racing on the shared reference.
    const result = state.chain
      .then(() => (lifetime.signal.aborted ? undefined : rotate(provider, profile, failure, signal)))
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
      // A changed profile set refreshes caches; a new or cleared primary is
      // detected on the next refresh. No proactive seed: the primary is owned
      // by the main settings.
      void refreshAllCaches()
    },
  })
}
