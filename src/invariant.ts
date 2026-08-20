/**
 * Package-owned invariant companion for `@m1khal3v/dsh-llm-key-rotation`.
 * @module @m1khal3v/dsh-llm-key-rotation/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@m1khal3v/dsh-llm-key-rotation'

/** Cordis companion plugin name. */
export const name = 'llm-key-rotation-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

// No runtime invariant: this plugin emits a non-durable live `llm/key-rotation`
// event (declared on the framework `Events` interface, never the session log)
// and mutates credential storage through the existing `ctx.credentials` seam.
// It owns no durable session-log relation to validate, and its in-memory
// rotation state is derivable from credential-store contents plus the live
// event stream. A host that mounts `ctx.invariants` still sees the package
// reserved; the live event itself carries the full rotation record for any
// telemetry consumer that wants to assert on it.
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
