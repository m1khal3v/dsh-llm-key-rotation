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
  // Let the fire-and-forget chain-cache refresh settle (microtasks only, so it
  // also works under fake timers).
  for (let i = 0; i < 6; i++) await Promise.resolve()
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

const CHAIN_CONFIG = (): keyRotation.Config => ({
  providers: {
    test: {
      enabled: true,
      rotate_on: ['QUOTA'],
      apiKeyEnvChain: ['TEST_API_KEY_CHAIN_1', 'TEST_API_KEY_CHAIN_2'],
    },
  },
})

describe('llm-key-rotation', () => {
  let ctx: Context | undefined

  afterEach(async () => {
    if (ctx !== undefined) {
      await ctx.fiber.dispose()
      ctx = undefined
    }
    vi.restoreAllMocks()
  })

  it('delegates when the provider is disabled', async () => {
    const h = await harness(
      { TEST_API_KEY_CHAIN_1: 'k1' },
      { providers: { test: { enabled: false, rotate_on: ['QUOTA'], apiKeyEnvChain: ['TEST_API_KEY_CHAIN_1'] } } },
    )
    ctx = h.ctx
    const agent = mockAgent(h.ctx, 'rot-disabled')

    const action = await dispatchError(h.ctx, agent, quotaFailure())

    expect(action).toBeUndefined()
    expect(h.credentials.setCalls).toHaveLength(0)
  })

  it('delegates when the chain has no stored keys', async () => {
    const h = await harness(
      {},
      CHAIN_CONFIG(),
    )
    ctx = h.ctx
    const agent = mockAgent(h.ctx, 'rot-empty')

    const action = await dispatchError(h.ctx, agent, quotaFailure())

    expect(action).toBeUndefined()
    expect(h.credentials.setCalls).toHaveLength(0)
  })

  it('delegates non-trigger failure codes', async () => {
    const h = await harness(
      { TEST_API_KEY_CHAIN_1: 'k1' },
      CHAIN_CONFIG(),
    )
    ctx = h.ctx
    const agent = mockAgent(h.ctx, 'rot-skip')

    const action = await dispatchError(h.ctx, agent, { message: 'Server error', code: 'SERVER' })

    expect(action).toBeUndefined()
    expect(h.credentials.setCalls).toHaveLength(0)
  })

  it('delegates when no profile exists for the provider', async () => {
    const h = await harness(
      { TEST_API_KEY_CHAIN_1: 'k1' },
      { providers: {} },
    )
    ctx = h.ctx
    const agent = mockAgent(h.ctx, 'rot-noprofile')

    const action = await dispatchError(h.ctx, agent, quotaFailure())

    expect(action).toBeUndefined()
    expect(h.credentials.setCalls).toHaveLength(0)
  })

  it('writes the first chain key to the env ref on a QUOTA failure and returns retry', async () => {
    const h = await harness(
      { TEST_API_KEY_CHAIN_1: 'k1', TEST_API_KEY_CHAIN_2: 'k2' },
      CHAIN_CONFIG(),
    )
    ctx = h.ctx
    const agent = mockAgent(h.ctx, 'rot-basic')

    const action = await dispatchError(h.ctx, agent, quotaFailure())

    expect(action).toEqual({ kind: 'retry' })
    expect(h.credentials.setCalls).toEqual([{ ref: 'TEST_API_KEY', value: 'k1' }])
  })

  it('advances through the chain on consecutive failures within the window', async () => {
    const h = await harness(
      { TEST_API_KEY_CHAIN_1: 'k1', TEST_API_KEY_CHAIN_2: 'k2' },
      CHAIN_CONFIG(),
    )
    ctx = h.ctx
    const agent = mockAgent(h.ctx, 'rot-advance')

    await dispatchError(h.ctx, agent, quotaFailure()) // → k1 (index 0)
    const action = await dispatchError(h.ctx, agent, quotaFailure()) // → k2 (index 1)

    expect(action).toEqual({ kind: 'retry' })
    expect(h.credentials.setCalls).toEqual([
      { ref: 'TEST_API_KEY', value: 'k1' },
      { ref: 'TEST_API_KEY', value: 'k2' },
    ])
  })

  it('delegates once every chain key has been written within the window', async () => {
    const h = await harness(
      { TEST_API_KEY_CHAIN_1: 'k1', TEST_API_KEY_CHAIN_2: 'k2' },
      CHAIN_CONFIG(),
    )
    ctx = h.ctx
    const agent = mockAgent(h.ctx, 'rot-exhaust')

    await dispatchError(h.ctx, agent, quotaFailure()) // k1
    await dispatchError(h.ctx, agent, quotaFailure()) // k2
    const action = await dispatchError(h.ctx, agent, quotaFailure()) // exhausted

    expect(action).toBeUndefined()
    expect(h.credentials.setCalls).toEqual([
      { ref: 'TEST_API_KEY', value: 'k1' },
      { ref: 'TEST_API_KEY', value: 'k2' },
    ])
  })

  it('restarts from the chain head once 300s have passed since the last write', async () => {
    vi.useFakeTimers()
    try {
      const h = await harness(
        { TEST_API_KEY_CHAIN_1: 'k1', TEST_API_KEY_CHAIN_2: 'k2' },
        CHAIN_CONFIG(),
      )
      ctx = h.ctx
      const agent = mockAgent(h.ctx, 'rot-stale')

      await dispatchError(h.ctx, agent, quotaFailure()) // k1 (chanIndex 0)
      await dispatchError(h.ctx, agent, quotaFailure()) // k2 (chanIndex 1)

      // Stale the window: 300s+ later the next failure restarts at index 0.
      vi.advanceTimersByTime(300_001)
      const action = await dispatchError(h.ctx, agent, quotaFailure())

      expect(action).toEqual({ kind: 'retry' })
      expect(h.credentials.setCalls[2]).toEqual({ ref: 'TEST_API_KEY', value: 'k1' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('logs a [llm-key-rotation] rotated line on success with no key values', async () => {
    const h = await harness(
      { TEST_API_KEY_CHAIN_1: 'super-secret-1', TEST_API_KEY_CHAIN_2: 'k2' },
      CHAIN_CONFIG(),
    )
    ctx = h.ctx
    const agent = mockAgent(h.ctx, 'rot-log')

    await dispatchError(h.ctx, agent, quotaFailure())

    const entry = h.logs.find((l) => String(l[0]).includes('[llm-key-rotation] rotated'))
    expect(entry).toBeDefined()
    const flat = entry!.map((x) => String(x)).join(' ')
    expect(flat).toContain('test')
    expect(flat).toContain('TEST_API_KEY')
    expect(flat).toContain('QUOTA')
    expect(flat).not.toContain('super-secret-1')
    expect(flat).not.toContain('k2')
  })

  it('emits llm/key-rotation telemetry with the rotation record', async () => {
    const h = await harness(
      { TEST_API_KEY_CHAIN_1: 'k1' },
      CHAIN_CONFIG(),
    )
    ctx = h.ctx
    const agent = mockAgent(h.ctx, 'rot-telemetry')
    const events: KeyRotationEvent[] = []
    h.ctx.on('llm/key-rotation', (event) => { events.push(event) })

    await dispatchError(h.ctx, agent, quotaFailure())

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      provider: 'test',
      triggerCode: 'QUOTA',
      toRef: 'TEST_API_KEY',
      chainIndex: 0,
      targetRef: 'TEST_API_KEY',
    })
  })

  it('removes its listeners on plugin disposal', async () => {
    const h = await harness(
      { TEST_API_KEY_CHAIN_1: 'k1' },
      CHAIN_CONFIG(),
    )
    const agent = mockAgent(h.ctx, 'rot-dispose')
    const events: KeyRotationEvent[] = []
    const disposeObserver = h.ctx.on('llm/key-rotation', (event) => { events.push(event) })

    await dispatchError(h.ctx, agent, quotaFailure())
    expect(events).toHaveLength(1)

    const reg = h.ctx.registry.get(keyRotation)
    if (reg) for (const fiber of reg.fibers) await fiber.dispose()
    await new Promise((resolve) => setTimeout(resolve, 20))

    const action = await dispatchError(h.ctx, agent, quotaFailure())
    expect(action).toBeUndefined()
    expect(events).toHaveLength(1)

    disposeObserver()
    ctx = h.ctx
  })
})
