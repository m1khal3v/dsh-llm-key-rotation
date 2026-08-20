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
  /** Id for the rotation attempt; refreshed on each committed rotation. */
  readonly rotationId: RotationId
  /** The failure code that triggered the rotation. */
  readonly triggerCode: string
  /** The credential reference written with the rotated key (the provider's apiKeyEnv). */
  readonly toRef: string
  /** Position inside the chain that was written. */
  readonly chainIndex: number
  /** The credential reference the adapter reads (the rotation target / env). */
  readonly targetRef: string
  /** The normalized provider-neutral failure that caused the rotation. */
  readonly failure: LlmFailure
}

/** One provider route's key-rotation profile. */
export interface RotationProfile {
  /** Whether rotation is active for this provider. */
  enabled: boolean
  /** Failure codes that trigger a rotation (e.g. `QUOTA`, `RATE_LIMIT`, `AUTH`). */
  rotate_on: string[]
  /**
   * Credential references holding the spare keys, one value per reference
   * (e.g. `OPENCODE_GO_API_KEY_CHAIN_1`, `_CHAIN_2`, …). Values live in the
   * credential store; the web card writes them.
   */
  apiKeyEnvChain: string[]
}
