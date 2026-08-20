/**
 * Controller for the key-rotation settings card.
 *
 * Reads the configurable-provider directory (llm.providers wire API) to show
 * already-configured providers as pickable rows. For each provider, the user
 * adds API keys directly (values, not env-var names); the controller derives
 * credential references automatically (PROVIDER_API_KEY, _2, _3, …), stores
 * the key values through the credentials wire API, and writes the rotation
 * profile through the settings wire API.
 */

import type { SettingsScope, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { IApiClient, CredentialView, ConfigurableProviderView } from '@deepseek-ai/dsh-api-remotes/client'

/** Derive the conventional credential reference for a provider route. */
function deriveKeyRef(provider: string, index: number): string {
  const base = provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
  return index === 0 ? `${base}_API_KEY` : `${base}_API_KEY_${index + 1}`
}

/** One key in the rotation chain. */
export interface KeyEntry {
  /** Stable client-side id for React keys. */
  id: string
  /** The credential reference derived from the provider + position. */
  ref: string
  /** The key value the user typed (write-only; never read back). */
  value: string
  /** Whether this key is stored in the credential store. */
  stored: boolean
  /** Whether a store is in flight. */
  storing: boolean
  /** Whether the last store failed. */
  failed: boolean
  /** Credential state from the Host. */
  view: CredentialView | undefined
}

/** One provider row with its rotation configuration. */
export interface RotationProviderRow {
  /** Provider route id. */
  provider: string
  /** Display name from the directory. */
  displayName: string
  /** Whether this provider is active (has a registered adapter). */
  active: boolean
  /** The credential reference the adapter resolves (its apiKeyEnv), when known. */
  adapterKeyRef: string | undefined
  /** Whether rotation is enabled for this provider. */
  enabled: boolean
  /** Ordered key entries the user typed. */
  keys: KeyEntry[]
  /** Trigger codes for rotation. */
  triggerCodes: string[]
  /** Behavior when pool is exhausted. */
  onExhausted: 'delegate' | 'cycle'
}

/** Card state the React component renders. */
export interface KeyRotationCardState {
  /** False while the provider directory is loading. */
  available: boolean
  /** Whether the Host document accepts writes. */
  writable: boolean
  /** Provider rows from the directory, joined with rotation config. */
  providers: readonly RotationProviderRow[]
  /** Whether a settings save is in flight. */
  saving: boolean
  /** Whether the last save did not land. */
  failed: boolean
  /** Load error message. */
  error: string | null
}

/** The face the card's slot registration injects. */
export interface KeyRotationCardFace {
  hooks: {
    keyRotationCard: SnapshotStore<KeyRotationCardState>
  }
  toggleProvider: (provider: string, enabled: boolean) => void
  addKey: (provider: string) => void
  removeKey: (provider: string, keyId: string) => void
  editKey: (provider: string, keyId: string, value: string) => void
  moveKey: (provider: string, keyId: string, direction: 'up' | 'down') => void
  toggleTrigger: (provider: string, code: string) => void
  setOnExhausted: (provider: string, value: 'delegate' | 'cycle') => void
  storeKey: (provider: string, keyId: string) => void
  save: () => void
}

let keyIdCounter = 0
function newKeyId(): string { return `key-${++keyIdCounter}` }

const DEFAULT_TRIGGERS = ['QUOTA', 'AUTH']

/** Saved rotation profile shape read from the settings namespace. */
interface SavedProfile {
  keys: KeyEntry[]
  triggerCodes: string[]
  onExhausted: 'delegate' | 'cycle'
  enabled: boolean
}

/**
 * Bridges the configurable-provider directory and the `llm-key-rotation`
 * settings namespace onto a premium card form with direct key input.
 */
export class KeyRotationCardController {
  private readonly store: SnapshotStore<KeyRotationCardState>
  private rows = new Map<string, RotationProviderRow>()
  private saving = false
  private failed = false

  /**
   * @param scope - the bound settings scope for the `llm-key-rotation` namespace.
   * @param api - the wire API client.
   */
  constructor(
    private readonly scope: SettingsScope<Record<string, unknown>>,
    private readonly api: IApiClient,
  ) {
    this.store = createSnapshotStore(this.initialState())
    this.scope.subscribe(() => { void this.syncFromSettings() })
    void this.loadProviders()
  }

  private initialState(): KeyRotationCardState {
    return { available: false, writable: false, providers: [], saving: false, failed: false, error: null }
  }

  /** Load the provider directory from the Host. */
  private async loadProviders(): Promise<void> {
    try {
      const response = await this.api.llm.providers({})
      if (!response.result.ok) throw new Error(response.result.error.message)
      const snapshot = this.scope.getSnapshot()
      this.rows.clear()
      for (const entry of response.result.value.providers) {
        const existing = this.readProfile(snapshot.value, entry.provider)
        const adapterRef = this.readAdapterKeyRef(snapshot.value, entry)
        this.rows.set(entry.provider, this.buildRow(entry, existing, adapterRef))
      }
      void this.refreshCredentials()
      this.publish()
    } catch (error) {
      this.store.set({
        ...this.initialState(),
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** Refresh credential views for all refs in current rows. */
  private async refreshCredentials(): Promise<void> {
    const refs: string[] = []
    for (const row of this.rows.values()) {
      for (const key of row.keys) refs.push(key.ref)
    }
    if (refs.length === 0) { this.publish(); return }
    try {
      const response = await this.api.credentials.describe({ refs })
      if (response.result.ok) {
        const views = response.result.value.credentials
        for (const row of this.rows.values()) {
          for (const key of row.keys) {
            key.view = views[key.ref]
            key.stored = views[key.ref]?.configured ?? false
          }
        }
      }
    } catch { /* best-effort enrichment */ }
    this.publish()
  }

  /** Read a saved rotation profile from the settings section value. */
  private readProfile(value: Record<string, unknown> | undefined, provider: string): SavedProfile | undefined {
    const providers = value?.['providers'] as Record<string, unknown> | undefined
    if (providers === undefined) return undefined
    const profile = providers[provider] as Record<string, unknown> | undefined
    if (profile === undefined) return undefined
    const poolRefs = profile['poolRefs'] as string[] | undefined
    const keys: KeyEntry[] = (poolRefs ?? []).map((ref) => ({
      id: newKeyId(), ref, value: '', stored: false, storing: false, failed: false, view: undefined,
    }))
    return {
      keys,
      triggerCodes: (profile['triggerCodes'] as string[]) ?? [...DEFAULT_TRIGGERS],
      onExhausted: (profile['onExhausted'] as 'delegate' | 'cycle') ?? 'delegate',
      enabled: true,
    }
  }

  /** Read the adapter's apiKeyEnv from the settings section for a provider. */
  private readAdapterKeyRef(
    value: Record<string, unknown> | undefined,
    entry: ConfigurableProviderView,
  ): string | undefined {
    if (value === undefined) return undefined
    if (entry.settingsPath.length === 0) {
      const ref = value['apiKeyEnv']
      return typeof ref === 'string' && ref.length > 0 ? ref : undefined
    }
    let current: unknown = value
    for (const segment of entry.settingsPath) {
      if (typeof current !== 'object' || current === null) return undefined
      current = (current as Record<string, unknown>)[segment]
    }
    const ref = (current as Record<string, unknown>)?.['apiKeyEnv']
    return typeof ref === 'string' && ref.length > 0 ? ref : undefined
  }

  /** Build a provider row from the directory entry and any saved profile. */
  private buildRow(
    entry: ConfigurableProviderView,
    existing: SavedProfile | undefined,
    adapterRef: string | undefined,
  ): RotationProviderRow {
    if (existing !== undefined) {
      return {
        provider: entry.provider, displayName: entry.displayName, active: entry.active,
        adapterKeyRef: adapterRef, enabled: existing.enabled, keys: existing.keys,
        triggerCodes: existing.triggerCodes, onExhausted: existing.onExhausted,
      }
    }
    return {
      provider: entry.provider, displayName: entry.displayName, active: entry.active,
      adapterKeyRef: adapterRef, enabled: false,
      keys: [{ id: newKeyId(), ref: adapterRef ?? deriveKeyRef(entry.provider, 0), value: '', stored: false, storing: false, failed: false, view: undefined }],
      triggerCodes: [...DEFAULT_TRIGGERS], onExhausted: 'delegate',
    }
  }

  /** Re-sync rows after a settings change. */
  private syncFromSettings(): void {
    const snapshot = this.scope.getSnapshot()
    for (const [provider, row] of this.rows) {
      const existing = this.readProfile(snapshot.value, provider)
      if (existing !== undefined && !row.enabled) {
        row.enabled = existing.enabled
        row.keys = existing.keys
        row.triggerCodes = existing.triggerCodes
        row.onExhausted = existing.onExhausted
      }
    }
    void this.refreshCredentials()
    this.publish()
  }

  private publish(): void {
    const snapshot = this.scope.getSnapshot()
    this.store.set({
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      providers: [...this.rows.values()],
      saving: this.saving,
      failed: this.failed,
      error: null,
    })
  }

  /** Build the face the card's slot registration injects. */
  inject(): KeyRotationCardFace {
    return {
      hooks: { keyRotationCard: this.store },
      toggleProvider: (provider, enabled) => {
        const row = this.rows.get(provider)
        if (row !== undefined) { row.enabled = enabled; this.publish() }
      },
      addKey: (provider) => {
        const row = this.rows.get(provider)
        if (row === undefined) return
        let suffix = row.keys.length
        while (row.keys.some(k => k.ref === deriveKeyRef(provider, suffix))) suffix++
        row.keys.push({
          id: newKeyId(), ref: deriveKeyRef(provider, suffix), value: '',
          stored: false, storing: false, failed: false, view: undefined,
        })
        this.publish()
      },
      removeKey: (provider, keyId) => {
        const row = this.rows.get(provider)
        if (row === undefined) return
        if (row.keys.length <= 1) return
        row.keys = row.keys.filter(k => k.id !== keyId)
        row.keys.forEach((key, i) => { key.ref = deriveKeyRef(provider, i) })
        this.publish()
      },
      editKey: (provider, keyId, value) => {
        const row = this.rows.get(provider)
        if (row === undefined) return
        const key = row.keys.find(k => k.id === keyId)
        if (key !== undefined) { key.value = value; key.failed = false; this.publish() }
      },
      moveKey: (provider, keyId, direction) => {
        const row = this.rows.get(provider)
        if (row === undefined) return
        const index = row.keys.findIndex(k => k.id === keyId)
        if (index < 0) return
        const target = direction === 'up' ? index - 1 : index + 1
        if (target < 0 || target >= row.keys.length) return
        ;[row.keys[index]!, row.keys[target]!] = [row.keys[target]!, row.keys[index]!]
        row.keys.forEach((key, i) => { key.ref = deriveKeyRef(provider, i) })
        this.publish()
      },
      toggleTrigger: (provider, code) => {
        const row = this.rows.get(provider)
        if (row === undefined) return
        const idx = row.triggerCodes.indexOf(code)
        if (idx >= 0) row.triggerCodes = row.triggerCodes.filter(c => c !== code)
        else row.triggerCodes = [...row.triggerCodes, code]
        this.publish()
      },
      setOnExhausted: (provider, value) => {
        const row = this.rows.get(provider)
        if (row !== undefined) { row.onExhausted = value; this.publish() }
      },
      storeKey: (provider, keyId) => { void this.storeKey(provider, keyId) },
      save: () => { void this.save() },
    }
  }

  private async storeKey(provider: string, keyId: string): Promise<void> {
    const row = this.rows.get(provider)
    if (row === undefined) return
    const key = row.keys.find(k => k.id === keyId)
    if (key === undefined || key.value.trim() === '') return
    key.storing = true
    key.failed = false
    this.publish()
    try {
      await this.api.credentials.set({ ref: key.ref, value: key.value.trim() })
      key.stored = true
      key.value = ''
    } catch {
      key.failed = true
    }
    key.storing = false
    this.publish()
    void this.refreshCredentials()
  }

  private async save(): Promise<void> {
    const profiles: Record<string, unknown> = {}
    for (const [provider, row] of this.rows) {
      if (!row.enabled || row.keys.length === 0) continue
      profiles[provider] = {
        targetRef: row.adapterKeyRef ?? deriveKeyRef(row.provider, 0),
        poolRefs: row.keys.map(k => k.ref),
        triggerCodes: row.triggerCodes,
        onExhausted: row.onExhausted,
      }
    }
    this.saving = true
    this.failed = false
    this.publish()
    try {
      await this.scope.set('providers', profiles)
    } catch {
      this.failed = true
    }
    this.saving = false
    this.publish()
  }
}
