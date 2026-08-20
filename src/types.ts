/**
 * Type surface for @m1khal3v/dsh-llm-key-rotation: the settings-section config,
 * one provider's rotation profile, and the live telemetry event emitted after a
 * rotation commits. The event is declared on the framework `Events` interface
 * (not the session log) so a harness that does not know this plugin's event
 * type can still resume sessions that ran with it.
 * @module @m1khal3v/dsh-llm-key-rotation/types
 */

import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import type { RotationId } from './brand.ts'

export type { RotationId } from './brand.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One API-key rotation committed for a provider route. Fired after the new
     * key is written to the credential store and before the retry turn opens.
     * Non-durable: it never enters the session log, so a harness that does not
     * know this event type can still resume sessions that produced it.
     * Telemetry or observation plugins listen with `ctx.on('llm/key-rotation', ...)`.
     * @param payload - the rotation record.
     * @mode emit
     */
    'llm/key-rotation'(payload: KeyRotationEvent): void
  }
}

/** Telemetry record emitted after one key rotation commits. */
export interface KeyRotationEvent {
  /** Provider route whose failing key was rotated. */
  readonly provider: string
  /** Stable id shared across one provider's consecutive rotation chain (one incident). */
  readonly rotationId: RotationId
  /** The failure code that triggered the rotation. */
  readonly triggerCode: string
  /** Credential-ref index that was active when the failure arrived. */
  readonly fromIndex: number
  /** Credential-ref index now made active. */
  readonly toIndex: number
  /** One-based position of this rotation in the current incident chain. */
  readonly retry: number
  /** The credential reference the adapter reads (the rotation target). */
  readonly targetRef: string
  /** The normalized provider-neutral failure that caused the rotation. */
  readonly failure: LlmFailure
}

/** One provider route's key-rotation profile. */
export interface RotationProfile {
  /**
   * Credential reference the adapter resolves per request (its `apiKeyEnv`).
   * Rotation writes each pool key's value here, so the next request
   * authenticates with the rotated key without a restart.
   */
  targetRef: string
  /**
   * Ordered chain of credential references. Rotation advances through these
   * one per qualifying failure. The first entry is the initial active key when
   * it differs from {@link targetRef}; when they are equal, the adapter reads
   * the same ref the chain starts from.
   */
  poolRefs: string[]
  /** Failure codes that trigger a rotation (e.g. `QUOTA`, `RATE_LIMIT`, `AUTH`). */
  triggerCodes: string[]
  /**
   * Behavior once every pool key has been tried in the current incident:
   * `delegate` hands the failure to downstream recovery (dsh-llm-retry or
   * terminal), `cycle` restarts the chain indefinitely.
   */
  onExhausted: 'delegate' | 'cycle'
}
