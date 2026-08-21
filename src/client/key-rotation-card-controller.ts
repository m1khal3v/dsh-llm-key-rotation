/**
 * Controller for the key-rotation settings card.
 *
 * The card manages the chain of API keys a provider may use. Each provider lists
 * its chain references in the `llm-key-rotation` settings section as
 * `apiKeyEnvChain` (e.g. `OPENCODE_GO_API_KEY_CHAIN_1`, `_CHAIN_2`, …). A key
 * value lives under each such reference in the credential store — a value is
 * written (credentials.set) and never read back, so a saved key's input becomes
 * disabled with a `[hidden]` placeholder and can only be removed. The active key
 * itself is written by the server into the provider's env reference
 * (`OPENCODE_GO_API_KEY`) and is not touched here.
 *
 * Only providers marked `active` by the harness (added in the main settings) are
 * shown. State is re-read every time the controller (re)loads, so reopening the
 * settings window refreshes the current configuration.
 */

import type { SettingsScope, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { IApiClient, CredentialView, ConfigurableProviderView } from '@deepseek-ai/dsh-api-remotes/client'

/** Derive the provider's env (apiKeyEnv) reference from its route id by convention. */
export function envRefOf(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

/** Derive a provider's slot-N key reference (`…_CHAIN_N`). */
function chainRefOf(provider: string, n: number): string {
  return `${envRefOf(provider)}_CHAIN_${n}`
}

/** One key row in a provider's chain. */
export interface ChainEntry {
  /** Stable client-side id for React keys. */
  id: string
  /** Numeric suffix `N` in `…_CHAIN_N`. */
  n: number
  /** The full credential reference for this slot. */
  ref: string
  /** The typed key value (write-only; never read back). */
  value: string
  /** Whether a durable value exists for this ref (from credential describe). */
  saved: boolean
}

/** One provider row with its rotation configuration. */
export interface RotationProviderRow {
  /** Provider route id. */
  provider: string
  /** Display name from the directory. */
  displayName: string
  /** Whether rotation is enabled for this provider. */
  enabled: boolean
  /** The provider's env reference (its apiKeyEnv). */
  envRef: string
  /** Trigger codes that rotate. */
  rotateOn: string[]
  /** Key chain slots (values written to their refs). */
  chain: ChainEntry[]
}

/** Card state the React component renders. */
export interface KeyRotationCardState {
  /** True once the provider directory has been read. */
  available: boolean
  /** Provider rows (only active providers). */
  providers: readonly RotationProviderRow[]
  /** Whether a settings/credentials write is in flight. */
  saving: boolean
  /** Whether the last write did not land. */
  failed: boolean
  /** Load error message. */
  error: string | null
}

/** The face the card's slot registration injects. */
export interface KeyRotationCardFace {
  hooks: {
    keyRotationCard: SnapshotStore<KeyRotationCardState>
  }
  toggleEnabled: (provider: string, enabled: boolean) => void
  toggleRotateOn: (provider: string, code: string) => void
  addKey: (provider: string) => void
  removeKey: (provider: string, keyId: string) => void
  editKey: (provider: string, keyId: string, value: string) => void
  save: (provider: string) => void
}

let keyIdCounter = 0
function newKeyId(): string { return `key-${++keyIdCounter}` }

const DEFAULT_ROTATE_ON = ['QUOTA', 'AUTH']

/** Saved rotation profile shape read from the settings namespace. */
interface SavedProfile {
  enabled: boolean
  rotateOn: string[]
  apiKeyEnvChain: string[]
}

/**
 * Bridges the configurable-provider directory and the `llm-key-rotation`
 * settings namespace onto a card for managing a provider's key chain.
 */
export class KeyRotationCardController {
  private readonly store: SnapshotStore<KeyRotationCardState>
  private rows = new Map<string, RotationProviderRow>()
  private saving = false
  private failed = false
  private loaded = false

  /**
   * @param scope - the bound settings scope for the `llm-key-rotation` namespace.
   * @param api - the wire API client.
   */
  constructor(
    private readonly scope: SettingsScope<Record<string, unknown>>,
    private readonly api: IApiClient,
  ) {
    this.store = createSnapshotStore(this.initialState())
    this.scope.subscribe(() => { void this.loadProviders() })
    void this.loadProviders()
  }

  private initialState(): KeyRotationCardState {
    return { available: false, providers: [], saving: false, failed: false, error: null }
  }

  /** Load the active providers and their saved rotation configuration. */
  private async loadProviders(): Promise<void> {
    try {
      const response = await this.api.llm.providers({})
      if (!response.result.ok) throw new Error(response.result.error.message)
      const snapshot = this.scope.getSnapshot()
      const saved = this.readProfiles(snapshot.value)
      const active = response.result.value.providers.filter((entry) => entry.active)
      this.rows.clear()
      for (const entry of active) {
        this.rows.set(entry.provider, this.buildRow(entry, saved.get(entry.provider)))
      }
      await this.refreshCredentialState()
      this.loaded = true
      this.publish()
    } catch (error) {
      this.store.set({
        ...this.initialState(),
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** Read saved profiles from the settings section value. */
  private readProfiles(value: Record<string, unknown> | undefined): Map<string, SavedProfile> {
    const out = new Map<string, SavedProfile>()
    const providers = value?.['providers'] as Record<string, unknown> | undefined
    if (providers === undefined) return out
    for (const [provider, raw] of Object.entries(providers)) {
      if (typeof raw !== 'object' || raw === null) continue
      const p = raw as Record<string, unknown>
      const chain = Array.isArray(p['apiKeyEnvChain'])
        ? (p['apiKeyEnvChain'] as string[]).filter((ref) => typeof ref === 'string')
        : []
      out.set(provider, {
        enabled: p['enabled'] === true,
        rotateOn: Array.isArray(p['rotate_on']) && (p['rotate_on'] as unknown[]).length > 0
          ? (p['rotate_on'] as string[])
          : [...DEFAULT_ROTATE_ON],
        apiKeyEnvChain: chain,
      })
    }
    return out
  }

  /** Build a provider row from its directory entry and any saved profile. */
  private buildRow(entry: ConfigurableProviderView, saved: SavedProfile | undefined): RotationProviderRow {
    const chain: ChainEntry[] = (saved?.apiKeyEnvChain ?? []).map((ref) => {
      const match = /_CHAIN_(\d+)$/.exec(ref)
      const n = match === null ? 0 : Number(match[1])
      return { id: newKeyId(), n, ref, value: '', saved: true }
    })
    return {
      provider: entry.provider, displayName: entry.displayName, envRef: envRefOf(entry.provider),
      enabled: saved?.enabled ?? false,
      rotateOn: saved?.rotateOn ?? [...DEFAULT_ROTATE_ON],
      chain,
    }
  }

  /** Update per-reference saved flags (which chain slots have a stored value) from describe. */
  private async refreshCredentialState(): Promise<void> {
    const refs = new Set<string>()
    for (const row of this.rows.values()) for (const key of row.chain) refs.add(key.ref)
    if (refs.size === 0) { this.loaded = true; return }
    try {
      const response = await this.api.credentials.describe({ refs: [...refs] })
      if (response.result.ok) {
        const views = response.result.value.credentials as Record<string, CredentialView>
        for (const row of this.rows.values()) {
          for (const key of row.chain) key.saved = views[key.ref]?.configured ?? false
        }
      }
    } catch { /* best-effort */ }
  }

  /** The next never-used chain index: max numeric suffix in the current chain + 1. */
  private nextChainIndex(row: RotationProviderRow): number {
    let max = 0
    for (const key of row.chain) if (key.n > max) max = key.n
    return max + 1
  }

  private publish(): void {
    this.store.set({
      available: this.loaded,
      providers: [...this.rows.values()],
      saving: this.saving,
      failed: this.failed,
      error: null,
    })
  }

  /** Persist one provider's profile (enabled, rotateOn, apiKeyEnvChain) to the settings section. */
  private async commitProvider(provider: string): Promise<void> {
    const snapshot = this.scope.getSnapshot()
    const providers = { ...(snapshot.value?.['providers'] as Record<string, unknown> | undefined ?? {}) }
    const row = this.rows.get(provider)
    if (row === undefined) return
    const chain = row.chain.filter((k) => k.saved || k.value.trim() !== '').map((k) => k.ref)
    providers[provider] = chain.length > 0
      ? { enabled: row.enabled, rotate_on: row.rotateOn, apiKeyEnvChain: chain }
      : { enabled: row.enabled, rotate_on: row.rotateOn, apiKeyEnvChain: [] }
    this.saving = true
    this.failed = false
    this.publish()
    try {
      await this.scope.set('providers', providers)
    } catch {
      this.failed = true
    } finally {
      this.saving = false
      this.publish()
    }
  }

  /** Build the face the card's slot registration injects. */
  inject(): KeyRotationCardFace {
    return {
      hooks: { keyRotationCard: this.store },
      toggleEnabled: (provider, enabled) => {
        const row = this.rows.get(provider)
        if (row === undefined) return
        row.enabled = enabled
        this.publish()
        void this.commitProvider(provider)
      },
      toggleRotateOn: (provider, code) => {
        const row = this.rows.get(provider)
        if (row === undefined) return
        const idx = row.rotateOn.indexOf(code)
        if (idx >= 0) row.rotateOn = row.rotateOn.filter((c) => c !== code)
        else row.rotateOn = [...row.rotateOn, code]
        this.publish()
        void this.commitProvider(provider)
      },
      addKey: (provider) => {
        const row = this.rows.get(provider)
        if (row === undefined) return
        const n = this.nextChainIndex(row)
        row.chain.push({ id: newKeyId(), n, ref: chainRefOf(provider, n), value: '', saved: false })
        this.publish()
      },
      removeKey: (provider, keyId) => {
        const row = this.rows.get(provider)
        if (row === undefined) return
        const key = row.chain.find((k) => k.id === keyId)
        row.chain = row.chain.filter((k) => k.id !== keyId)
        this.publish()
        if (key !== undefined) void this.api.credentials.unset({ ref: key.ref }).catch(() => {})
        void this.commitProvider(provider)
      },
      editKey: (provider, keyId, value) => {
        const row = this.rows.get(provider)
        if (row === undefined) return
        const key = row.chain.find((k) => k.id === keyId)
        if (key !== undefined) { key.value = value; this.publish() }
      },
      save: (provider) => { void this.save(provider) },
    }
  }

  /** Save non-empty keys to their refs, then persist the chain configuration. */
  private async save(provider: string): Promise<void> {
    const row = this.rows.get(provider)
    if (row === undefined) return
    const dirty = row.chain.filter((k) => k.value.trim() !== '')
    if (dirty.length === 0) return
    this.saving = true
    this.failed = false
    this.publish()
    try {
      for (const key of dirty) {
        try {
          await this.api.credentials.set({ ref: key.ref, value: key.value.trim() })
          key.saved = true
          key.value = ''
        } catch {
          this.failed = true
        }
      }
    } finally {
      this.saving = false
      this.publish()
    }
    await this.commitProvider(provider)
  }
}
