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
): Promise<{ ctx: Context; credentials: MockCredentialProvider }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(MockCredentialProvider, { initial })
  await ctx.plugin(keyRotation, config)
  return { ctx, credentials: ctx.credentials as MockCredentialProvider }
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

describe('llm-key-rotation', () => {
  let ctx: Context | undefined

  afterEach(async () => {
    if (ctx !== undefined) {
      await ctx.fiber.dispose()
      ctx = undefined
    }
  })

  it('rotates to the next pool key on a QUOTA failure and returns retry', async () => {
    const h = await harness(
      { TEST_KEY: 'key-1', TEST_KEY_2: 'key-2', TEST_KEY_3: 'key-3' },
      {
        providers: {
          test: {
            targetRef: 'TEST_KEY',
            poolRefs: ['TEST_KEY', 'TEST_KEY_2', 'TEST_KEY_3'],
            triggerCodes: ['QUOTA'],
            onExhausted: 'delegate',
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

  it('delegates when the pool is exhausted in delegate mode', async () => {
    const h = await harness(
      { TEST_KEY: 'k1', TEST_KEY_2: 'k2' },
      {
        providers: {
          test: {
            targetRef: 'TEST_KEY',
            poolRefs: ['TEST_KEY', 'TEST_KEY_2'],
            triggerCodes: ['QUOTA'],
            onExhausted: 'delegate',
          },
        },
      },
    )
    ctx = h.ctx
    const agent = mockAgent(h.ctx, 'rotate-exhaust')

    // First failure: rotate from index 0 → 1
    await dispatchError(h.ctx, agent, quotaFailure())
    // Second failure: pool exhausted (rotatedSinceSuccess = 1 >= pool.length - 1 = 1)
    const action = await dispatchError(h.ctx, agent, quotaFailure())

    expect(action).toBeUndefined()
    expect(h.credentials.setCalls).toHaveLength(1)
  })

  it('cycles indefinitely in cycle mode', async () => {
    const h = await harness(
      { TEST_KEY: 'a', TEST_KEY_2: 'b' },
      {
        providers: {
          test: {
            targetRef: 'TEST_KEY',
            poolRefs: ['TEST_KEY', 'TEST_KEY_2'],
            triggerCodes: ['QUOTA'],
            onExhausted: 'cycle',
          },
        },
      },
    )
    ctx = h.ctx
    const agent = mockAgent(h.ctx, 'rotate-cycle')

    const a1 = await dispatchError(h.ctx, agent, quotaFailure())
    const a2 = await dispatchError(h.ctx, agent, quotaFailure())
    const a3 = await dispatchError(h.ctx, agent, quotaFailure())

    expect(a1).toEqual({ kind: 'retry' })
    expect(a2).toEqual({ kind: 'retry' })
    expect(a3).toEqual({ kind: 'retry' })
    expect(h.credentials.setCalls).toEqual([
      { ref: 'TEST_KEY', value: 'b' },
      { ref: 'TEST_KEY', value: 'a' },
      { ref: 'TEST_KEY', value: 'b' },
    ])
  })

  it('passes through non-trigger failure codes to downstream recovery', async () => {
    const h = await harness(
      { TEST_KEY: 'k1', TEST_KEY_2: 'k2' },
      {
        providers: {
          test: {
            targetRef: 'TEST_KEY',
            poolRefs: ['TEST_KEY', 'TEST_KEY_2'],
            triggerCodes: ['QUOTA'],
            onExhausted: 'delegate',
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
            poolRefs: ['TEST_KEY', 'TEST_KEY_2'],
            triggerCodes: ['QUOTA'],
            onExhausted: 'delegate',
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
            poolRefs: ['TEST_KEY', 'TEST_KEY_2'],
            triggerCodes: ['QUOTA'],
            onExhausted: 'delegate',
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
            poolRefs: ['TEST_KEY', 'TEST_KEY_2'],
            triggerCodes: ['QUOTA'],
            onExhausted: 'delegate',
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
      fromIndex: 0,
      toIndex: 1,
      retry: 1,
      targetRef: 'TEST_KEY',
    })
    expect(events[0]!.rotationId).toEqual(expect.any(String))
  })

  it('seeds the target ref from the first pool entry when target is empty', async () => {
    const h = await harness(
      { POOL_KEY_1: 'seeded-key' }, // ACTIVE_KEY is NOT set initially
      {
        providers: {
          test: {
            targetRef: 'ACTIVE_KEY',
            poolRefs: ['POOL_KEY_1', 'POOL_KEY_2'],
            triggerCodes: ['QUOTA'],
            onExhausted: 'delegate',
          },
        },
      },
    )
    ctx = h.ctx

    // The cache refresh and seed are background async operations.
    await new Promise((resolve) => setTimeout(resolve, 100))

    const resolved = await h.credentials.resolve(credentialRef('ACTIVE_KEY'))
    expect(resolved?.value).toBe('seeded-key')
  })

  it('resets the rotation chain after a successful assistant message', async () => {
    const h = await harness(
      { TEST_KEY: 'k1', TEST_KEY_2: 'k2' },
      {
        providers: {
          test: {
            targetRef: 'TEST_KEY',
            poolRefs: ['TEST_KEY', 'TEST_KEY_2'],
            triggerCodes: ['QUOTA'],
            onExhausted: 'delegate',
          },
        },
      },
    )
    ctx = h.ctx
    const agent = mockAgent(h.ctx, 'rotate-reset')

    // Wait for the pool cache to populate
    await new Promise((resolve) => setTimeout(resolve, 50))

    // Rotate once (index 0 → 1)
    await dispatchError(h.ctx, agent, quotaFailure())
    expect(h.credentials.setCalls).toHaveLength(1)

    // Simulate a successful assistant message for the 'test' provider by
    // directly emitting session/event (bypasses surfaceOp validation).
    h.ctx.emit('session/event', agent.session, {
      type: 'assistant/message',
      seq: 0,
      time: Date.now(),
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          source: { kind: 'model', provider: 'test', model: 'test-model' },
        },
      },
    })

    // After reset, rotatedSinceSuccess=0 so the next failure can rotate again.
    // Index is still 1; rotation goes 1 → 0, writing the cached k1 value.
    const action = await dispatchError(h.ctx, agent, quotaFailure())
    expect(action).toEqual({ kind: 'retry' })
    expect(h.credentials.setCalls).toHaveLength(2)
    expect(h.credentials.setCalls[1]).toEqual({ ref: 'TEST_KEY', value: 'k1' })
  })

  it('supports AUTH and RATE_LIMIT trigger codes', async () => {
    const h = await harness(
      { TEST_KEY: 'k1', TEST_KEY_2: 'k2', TEST_KEY_3: 'k3' },
      {
        providers: {
          test: {
            targetRef: 'TEST_KEY',
            poolRefs: ['TEST_KEY', 'TEST_KEY_2', 'TEST_KEY_3'],
            triggerCodes: ['AUTH', 'RATE_LIMIT', 'QUOTA'],
            onExhausted: 'delegate',
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

    // Pool exhausted after 2 rotations (3 keys, 2 rotations max in delegate mode)
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
            poolRefs: ['TEST_KEY', 'TEST_KEY_2'],
            triggerCodes: ['QUOTA'],
            onExhausted: 'delegate',
          },
        },
      },
    )
    const agent = mockAgent(h.ctx, 'rotate-dispose')
    const events: KeyRotationEvent[] = []
    const disposeObserver = h.ctx.on('llm/key-rotation', (event) => { events.push(event) })

    // Rotate once to confirm it works
    await dispatchError(h.ctx, agent, quotaFailure())
    expect(events).toHaveLength(1)

    // Dispose the key-rotation plugin fiber and wait for drain
    const reg = h.ctx.registry.get(keyRotation)
    if (reg) for (const fiber of reg.fibers) await fiber.dispose()
    await new Promise((resolve) => setTimeout(resolve, 50))

    // After disposal, a failure should not rotate
    const action = await dispatchError(h.ctx, agent, quotaFailure())
    expect(action).toBeUndefined()
    expect(events).toHaveLength(1) // no new telemetry

    disposeObserver()
    ctx = h.ctx
  })
})
