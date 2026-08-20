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
  /** Credential reference that was active when the failure arrived (the primary `targetRef` while index is -1). */
  readonly fromRef: string
  /** Credential reference now made active (the additional key written to `targetRef`). */
  readonly toRef: string
  /** One-based position of this rotation in the current incident chain. */
  readonly retry: number
  /** The credential reference the adapter reads (the rotation target / primary). */
  readonly targetRef: string
  /** The normalized provider-neutral failure that caused the rotation. */
  readonly failure: LlmFailure
}

/** One provider route's key-rotation profile. */
export interface RotationProfile {
  /**
   * Credential reference the adapter resolves per request (its `apiKeyEnv`).
   * This is the **primary** key, configured through the harness main settings
   * (Models), never through this plugin. Rotation writes each additional key's
   * value here, so the next request authenticates with the rotated key without
   * a restart.
   */
  targetRef: string
  /**
   * Ordered chain of **additional** credential references (extras on top of the
   * primary `targetRef`). Rotation advances through these one per qualifying
   * failure. An entry equal to `targetRef` is ignored, so a legacy profile
   * whose head duplicated the primary degrades cleanly.
   */
  poolRefs: string[]
  /** Failure codes that trigger a rotation (e.g. `QUOTA`, `RATE_LIMIT`, `AUTH`). */
  triggerCodes: string[]
  /**
   * Optional hard cap on rotations per incident. Defaults to the number of
   * additional keys (each extra is tried at most once). A lower value tries
   * fewer keys before delegating. There is no `cycle` mode.
   */
  maxIncidentRotations?: number
  /**
   * Optional cooldown in milliseconds once the cap is reached: the plugin stops
   * rotating this provider for the window and delegates.
   */
  cooldownMs?: number
}
