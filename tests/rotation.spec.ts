import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef, CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import * as keyRotation from '../src/index.ts'
import type { KeyRotationEvent } from '../src/index.ts'

/** In-memory credential provider for tests; records every set call. */
class MockCredentialProvider extends CredentialProvider {
  private readonly store = new Map<string, string>()
  readonly setCalls: Array<{ ref: string; value: string }> = []

  constructor(ctx: Context, config: { initial: Record<string, string> }) {
    super(ctx)
    for (const [ref, value] of Object.entries(config.initial)) this.store.set(ref, value)
  }

  override resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.store.get(ref)
    return Promise.resolve(value === undefined ? undefined : { value, source: 'mock' })
  }

  override describe(ref: CredentialRef): Promise<CredentialInfo> {
    return Promise.resolve(
      this.store.has(ref)
        ? { configured: true, source: 'mock', writable: true }
        : { configured: false, writable: true },
    )
  }

  override async set(ref: CredentialRef, value: string): Promise<void> {
    this.store.set(ref, value)
    this.setCalls.push({ ref, value })
  }

  override async unset(ref: CredentialRef): Promise<void> {
    this.store.delete(ref)
  }
}

/** A minimal agent stub for the waterfall payload; the rotation logic reads only provider/failure/signal. */
function mockAgent(ctx: Context, sessionId: string): Agent {
  const session = ctx.sessions.create(SessionId(sessionId))
  return {
    id: SessionId(sessionId),
    options: { provider: 'test', model: 'test-model' },
    session,
    inbox: {} as never,
    status: 'idle',
    ctx,
    cancel: () => {},
    whenIdle: () => Promise.resolve(),
    runMaintenance: () => Promise.resolve(),
    send: () => {},
    followup: () => {},
    steer: () => {},
  } as unknown as Agent
}

/** Build a standard QUOTA failure for tests. */
function quotaFailure(): LlmFailure {
  return Object.freeze({ message: 'Insufficient quota', code: 'QUOTA', status: 429 })
}

/** Build a test harness with real session/agent services and a mock credential store. */
async function harness(
  initial: Record<string, string>,
  config: keyRotation.Config,
): Promise<{ ctx: Context; credentials: MockCredentialProvider; logs: Array<unknown[]> }> {
  const ctx = new Context()
  const logs: Array<unknown[]> = []
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args)
  })
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logs.push(args)
  })
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(MockCredentialProvider, { initial })
  await ctx.plugin(keyRotation, config)
  return { ctx, credentials: ctx.credentials as MockCredentialProvider, logs }
}

/** Dispatch one agent/request-error waterfall and return the action. */
function dispatchError(
  ctx: Context,
  agent: Agent,
  failure: LlmFailure,
  provider = 'test',
  signal?: AbortSignal,
): Promise<RequestErrorAction | undefined> {
  return ctx.waterfall(
    'agent/request-error',
    { agent, turn: 1, step: 1, provider, failure, retryPolicy: undefined, signal: signal ?? new AbortController().signal },
    () => Promise.resolve<RequestErrorAction>(undefined),
  )
}

/** Simulate a successful model step for a provider (resets the incident). */
function successfulStep(ctx: Context, agent: Agent, provider = 'test'): void {
  ctx.emit('session/event', agent.session, {
    type: 'assistant/message',
    seq: 0,
    time: Date.now(),
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        source: { kind: 'model', provider, model: 'test-model' },
      },
    },
  })
}

describe('llm-key-rotation', () => {
  let ctx: Context | undefined

  afterEach(async () => {
    if (ctx !== undefined) {
      await ctx.fiber.dispose()
      ctx = undefined
    }
    vi.restoreAllMocks()
  })

  it('rotates from the primary to the first extra on a QUOTA failure and returns retry', async () => {
    const h = await harness(
      { TEST_KEY: 'key-1', TEST_KEY_2: 'key-2', TEST_KEY_3: 'key-3' },
      {
        providers: {
          test: {
            targetRef: 'TEST_KEY',
            poolRefs: ['TEST_KEY_2', 'TEST_KEY_3'],
            triggerCodes: ['QUOTA'],
          },
        },
      },
    )
    ctx = h.ctx
    const agent = mockAgent(h.ctx, 'rotate-basic')

    const action = await dispatchError(h.ctx, agent, quotaFailure())

    expect(action).toEqual({ kind: 'retry' })
    expect(h.credentials.setCalls).toEqual([{ ref: 'TEST_KEY', value: 'key-2' }])
  })

  it('ignores a pool head equal to the targetRef (legacy profile degrades to extras-only)', async () => {
    const h = await harness(
      { TEST_KEY: 'k1', TEST_KEY_2: 'k2', TEST_KEY_3: 'k3' },
      {
        providers: {
          test: {
            targetRef: 'TEST_KEY',
            poolRefs: ['TEST_KEY', 'TEST_KEY_2', 'TEST_KEY_3'],
            triggerCodes: ['QUOTA'],
          },
        },
      },
    )
    ctx = h.ctx
    const agent = mockAgent(h.ctx, 'rotate-legacy')

    // First failure: primary → extra 0 (TEST_KEY_2), not TEST_KEY (itself).
    await dispatchError(h.ctx, agent, quotaFailure())
    expect(h.credentials.setCalls).toEqual([{ ref: 'TEST_KEY', value: 'k2' }])

    // Second failure: extra 0 → extra 1 (TEST_KEY_3).
    await dispatchError(h.ctx, agent, quotaFailure())
    expect(h.credentials.setCalls[1]).toEqual({ ref: 'TEST_KEY', value: 'k3' })

    // Third failure: pool exhausted (both extras tried) → delegate.
    const action = await dispatchError(h.ctx, agent, quotaFailure())
    expect(action).toBeUndefined()
    expect(h.credentials.setCalls).toHaveLength(2)
  })

  it('delegates when the pool is exhausted (each extra tried once)', async () => {
    const h = await harness(
      { TEST_KEY: 'k1', TEST_KEY_2: 'k2' },
      {
        providers: {
          test: {
            targetRef: 'TEST_KEY',
            poolRefs: ['TEST_KEY_2'],
            triggerCodes: ['QUOTA'],
          },
        },
      },
    )
    ctx = h.ctx
    const agent = mockAgent(h.ctx, 'rotate-exhaust')

    // First failure: rotate to the single extra.
    await dispatchError(h.ctx, agent, quotaFailure())
    // Second failure: pool exhausted → delegate.
    const action = await dispatchError(h.ctx, agent, quotaFailure())

    expect(action).toBeUndefined()
    expect(h.credentials.setCalls).toHaveLength(1)
  })

  it('passes through non-trigger failure codes to downstream recovery', async () => {
    const h = await harness(
      { TEST_KEY: 'k1', TEST_KEY_2: 'k2' },
      {
        providers: {
          test: {
            targetRef: 'TEST_KEY',
            poolRefs: ['TEST_KEY_2'],
            triggerCodes: ['QUOTA'],
          },
        },
      },
    )
    ctx = h.ctx
    const agent = mockAgent(h.ctx, 'rotate-skip')

    const action = await dispatchError(h.ctx, agent, { message: 'Server error', code: 'SERVER' })

    expect(action).toBeUndefined()
    expect(h.credentials.setCalls).toHaveLength(0)
  })

  it('passes through when no profile is configured for the failing provider', async () => {
    const h = await harness(
      { TEST_KEY: 'k1' },
      { providers: {} },
    )
    ctx = h.ctx
    const agent = mockAgent(h.ctx, 'rotate-no-profile')

    const action = await dispatchError(h.ctx, agent, quotaFailure())

    expect(action).toBeUndefined()
    expect(h.credentials.setCalls).toHaveLength(0)
  })

  it('delegates when the next pool key has no stored value', async () => {
    const h = await harness(
      { TEST_KEY: 'k1' }, // TEST_KEY_2 is NOT stored
      {
        providers: {
          test: {
            targetRef: 'TEST_KEY',
            poolRefs: ['TEST_KEY_2'],
            triggerCodes: ['QUOTA'],
          },
        },
      },
    )
    ctx = h.ctx
    const agent = mockAgent(h.ctx, 'rotate-empty-pool')

    const action = await dispatchError(h.ctx, agent, quotaFailure())

    expect(action).toBeUndefined()
    expect(h.credentials.setCalls).toHaveLength(0)
  })

  it('does not rotate when the signal is already aborted', async () => {
    const h = await harness(
      { TEST_KEY: 'k1', TEST_KEY_2: 'k2' },
      {
        providers: {
          test: {
            targetRef: 'TEST_KEY',
            poolRefs: ['TEST_KEY_2'],
            triggerCodes: ['QUOTA'],
          },
        },
      },
    )
    ctx = h.ctx
    const agent = mockAgent(h.ctx, 'rotate-aborted')
    const ac = new AbortController()
    ac.abort()

    const action = await dispatchError(h.ctx, agent, quotaFailure(), 'test', ac.signal)

    expect(action).toBeUndefined()
    expect(h.credentials.setCalls).toHaveLength(0)
  })

  it('emits llm/key-rotation telemetry with the rotation record', async () => {
    const h = await harness(
      { TEST_KEY: 'k1', TEST_KEY_2: 'k2' },
      {
        providers: {
          test: {
            targetRef: 'TEST_KEY',
            poolRefs: ['TEST_KEY_2'],
            triggerCodes: ['QUOTA'],
          },
        },
      },
    )
    ctx = h.ctx
    const agent = mockAgent(h.ctx, 'rotate-telemetry')
    const events: KeyRotationEvent[] = []
    h.ctx.on('llm/key-rotation', (event) => { events.push(event) })

    await dispatchError(h.ctx, agent, quotaFailure())

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      provider: 'test',
      triggerCode: 'QUOTA',
      fromRef: 'TEST_KEY',
      toRef: 'TEST_KEY_2',
      retry: 1,
      targetRef: 'TEST_KEY',
    })
    expect(events[0]!.rotationId).toEqual(expect.any(String))
  })

  it('logs a [llm-key-rotation] rotated line on success with no key values', async () => {
    const h = await harness(
      { TEST_KEY: 'k1', TEST_KEY_2: 'key-2-secret' },
      {
        providers: {
          test: {
            targetRef: 'TEST_KEY',
            poolRefs: ['TEST_KEY_2'],
            triggerCodes: ['QUOTA'],
          },
        },
      },
    )
    ctx = h.ctx
    const agent = mockAgent(h.ctx, 'rotate-log')

    await dispatchError(h.ctx, agent, quotaFailure())

    const entry = h.logs.find((l) => String(l[0]).includes('[llm-key-rotation] rotated'))
    expect(entry).toBeDefined()
    const flat = entry!.map((x) => String(x)).join(' ')
    // The rotation record names the provider, refs, code, and retry count.
    expect(flat).toContain('test')
    expect(flat).toContain('TEST_KEY')
    expect(flat).toContain('TEST_KEY_2')
    expect(flat).toContain('QUOTA')
    // Never log the secret value.
    expect(flat).not.toContain('key-2-secret')
    expect(flat).not.toContain('key-1')
  })

  it('does not restore a primary that was never present; resets index after success', async () => {
    const h = await harness(
      { TEST_KEY: 'k1', TEST_KEY_2: 'k2' },
      {
        providers: {
          test: {
            targetRef: 'TEST_KEY',
            poolRefs: ['TEST_KEY_2'],
            triggerCodes: ['QUOTA'],
          },
        },
      },
    )
    ctx = h.ctx
    const agent = mockAgent(h.ctx, 'rotate-reset')

    // Wait for the pool cache to populate.
    await new Promise((resolve) => setTimeout(resolve, 50))

    // Rotate once (primary → extra 0), then succeed.
    await dispatchError(h.ctx, agent, quotaFailure())
    expect(h.credentials.setCalls).toHaveLength(1)
    successfulStep(h.ctx, agent)

    // Allow the async restore to settle.
    await new Promise((resolve) => setTimeout(resolve, 50))
    // The primary was restored to its original value.
    expect(h.credentials.setCalls[1]).toEqual({ ref: 'TEST_KEY', value: 'k1' })

    // Next incident starts from the primary again.
    const action = await dispatchError(h.ctx, agent, quotaFailure())
    expect(action).toEqual({ kind: 'retry' })
    expect(h.credentials.setCalls[2]).toEqual({ ref: 'TEST_KEY', value: 'k2' })
  })

  it('caps rotations at maxIncidentRotations and delegates', async () => {
    const h = await harness(
      { TEST_KEY: 'k1', TEST_KEY_2: 'k2', TEST_KEY_3: 'k3' },
      {
        providers: {
          test: {
            targetRef: 'TEST_KEY',
            poolRefs: ['TEST_KEY_2', 'TEST_KEY_3'],
            triggerCodes: ['QUOTA'],
            maxIncidentRotations: 1,
          },
        },
      },
    )
    ctx = h.ctx
    const agent = mockAgent(h.ctx, 'rotate-cap')

    const a1 = await dispatchError(h.ctx, agent, quotaFailure())
    expect(a1).toEqual({ kind: 'retry' })

    const a2 = await dispatchError(h.ctx, agent, quotaFailure())
    expect(a2).toBeUndefined() // cap reached after 1 rotation

    expect(h.credentials.setCalls).toEqual([{ ref: 'TEST_KEY', value: 'k2' }])
  })

  it('enters cooldown after exhaustion and suppresses rotation within the window', async () => {
    vi.useFakeTimers()
    try {
      const h = await harness(
        { TEST_KEY: 'k1', TEST_KEY_2: 'k2', TEST_KEY_3: 'k3' },
        {
          providers: {
            test: {
              targetRef: 'TEST_KEY',
              poolRefs: ['TEST_KEY_2', 'TEST_KEY_3'],
              triggerCodes: ['QUOTA'],
              cooldownMs: 1000,
            },
          },
        },
      )
      ctx = h.ctx
      const agent = mockAgent(h.ctx, 'rotate-cooldown')

      // First two failures rotate through both extras; the third exhausts and
      // starts the cooldown.
      await dispatchError(h.ctx, agent, quotaFailure())
      await dispatchError(h.ctx, agent, quotaFailure())
      const exhausted = await dispatchError(h.ctx, agent, quotaFailure())
      expect(exhausted).toBeUndefined()
      expect(h.credentials.setCalls).toHaveLength(2)

      // Within the cooldown window, failures delegate WITHOUT rotating again.
      const during = await dispatchError(h.ctx, agent, quotaFailure())
      expect(during).toBeUndefined()
      expect(h.credentials.setCalls).toHaveLength(2)
      expect(h.logs.some((l) => String(l[0]).includes('cooldown'))).toBe(true)

      // A later attempt inside the window is still suppressed.
      vi.advanceTimersByTime(500)
      const stillDuring = await dispatchError(h.ctx, agent, quotaFailure())
      expect(stillDuring).toBeUndefined()
      expect(h.credentials.setCalls).toHaveLength(2)

      // After the window, a fresh failure still cannot rotate because the
      // per-incident pool is exhausted without a success reset.
      vi.advanceTimersByTime(1001)
      const after = await dispatchError(h.ctx, agent, quotaFailure())
      expect(after).toBeUndefined()
      expect(h.credentials.setCalls).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('supports AUTH and RATE_LIMIT trigger codes', async () => {
    const h = await harness(
      { TEST_KEY: 'k1', TEST_KEY_2: 'k2', TEST_KEY_3: 'k3' },
      {
        providers: {
          test: {
            targetRef: 'TEST_KEY',
            poolRefs: ['TEST_KEY_2', 'TEST_KEY_3'],
            triggerCodes: ['AUTH', 'RATE_LIMIT', 'QUOTA'],
          },
        },
      },
    )
    ctx = h.ctx
    const agent = mockAgent(h.ctx, 'rotate-multi-trigger')

    const authAction = await dispatchError(h.ctx, agent, { message: 'Unauthorized', code: 'AUTH', status: 401 })
    expect(authAction).toEqual({ kind: 'retry' })

    const rlAction = await dispatchError(h.ctx, agent, { message: 'Rate limited', code: 'RATE_LIMIT', status: 429 })
    expect(rlAction).toEqual({ kind: 'retry' })

    // Pool exhausted after 2 rotations (2 extras).
    const exhausted = await dispatchError(h.ctx, agent, quotaFailure())
    expect(exhausted).toBeUndefined()

    expect(h.credentials.setCalls).toEqual([
      { ref: 'TEST_KEY', value: 'k2' },
      { ref: 'TEST_KEY', value: 'k3' },
    ])
  })

  it('removes its listeners on plugin disposal', async () => {
    const h = await harness(
      { TEST_KEY: 'k1', TEST_KEY_2: 'k2' },
      {
        providers: {
          test: {
            targetRef: 'TEST_KEY',
            poolRefs: ['TEST_KEY_2'],
            triggerCodes: ['QUOTA'],
          },
        },
      },
    )
    const agent = mockAgent(h.ctx, 'rotate-dispose')
    const events: KeyRotationEvent[] = []
    const disposeObserver = h.ctx.on('llm/key-rotation', (event) => { events.push(event) })

    // Rotate once to confirm it works.
    await dispatchError(h.ctx, agent, quotaFailure())
    expect(events).toHaveLength(1)

    // Dispose the key-rotation plugin fiber and wait for drain.
    const reg = h.ctx.registry.get(keyRotation)
    if (reg) for (const fiber of reg.fibers) await fiber.dispose()
    await new Promise((resolve) => setTimeout(resolve, 50))

    // After disposal, a failure should not rotate.
    const action = await dispatchError(h.ctx, agent, quotaFailure())
    expect(action).toBeUndefined()
    expect(events).toHaveLength(1) // no new telemetry

    disposeObserver()
    ctx = h.ctx
  })
})
