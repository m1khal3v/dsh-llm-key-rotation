/**
 * Branded identifiers for key-rotation records. Branded types keep opaque
 * cross-boundary ids from mixing with plain strings passed between plugins.
 * @module @m1khal3v/dsh-llm-key-rotation/brand
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Nominal id of one key-rotation attempt, stable across one provider's chain. */
export type RotationId = Branded<'RotationId'>

/** Brand a raw string as a {@link RotationId}. */
export function RotationId(value: string): RotationId {
  return value as RotationId
}
