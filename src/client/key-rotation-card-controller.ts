/**
 * Controller for the key-rotation settings card.
 *
 * The card manages **only additional keys** on top of a provider's primary key.
 * The primary key (the adapter's `apiKeyEnv`) is configured through the harness
 * main settings (Models) and is never edited here. If the primary is not
 * configured, the card shows a gate message instead of the key editor.
 *
 * Reads the configurable-provider directory (llm.providers wire API) to show
 * already-configured providers as pickable rows. For each provider the user
 * adds/adjusts additional keys (values, not env-var names); the controller
 * derives their credential references automatically (PROVIDER_API_KEY_2, _3,
 * …), stores key values through the credentials wire API, and writes the
 * rotation profile through the settings wire API. Saving is automatic: every
 * store/remove/reorder persists the profile, so there is no Save button.
 */

import type { SettingsScope, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { IApiClient, CredentialView, ConfigurableProviderView } from '@deepseek-ai/dsh-api-remotes/client'

/** The settings binder service (`ctx.settingsScope`): binds a scope to any namespace. */
export interface SettingsBinder {
  bind<T>(spec: { namespace: string }): SettingsScope<T>
}

/** Walk a nested settings-profile object by path (a provider's settings address). */
function getPath(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const segment of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/** Derive the conventional additional-key credential reference for a provider route. */
function deriveExtraKeyRef(provider: string, index: number): string {
  const base = provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
  return `${base}_API_KEY_${index + 2}`
}

/** One additional key in the rotation chain. */
export interface KeyEntry {
  /** Stable client-side id for React keys. */
  id: string
  /** The credential reference derived from the provider + position. */
  ref: string
  /** The key value the user typed (write-only; never read back). */
  value: string
  /** Whether a durable value exists for this ref (from credential describe). */
  filled: boolean
  /** Whether this key was stored in the current session (transient green checkmark). */
  stored: boolean
  /** Whether a store is in flight. */
  storing: boolean
  /** Whether the last store failed. */
  failed: boolean
}

/** One provider row with its rotation configuration. */
export interface RotationProviderRow {
  /** Provider route id. */
  provider: string
  /** Display name from the directory. */
  displayName: string
  /** Whether this provider is active (has a registered adapter). */
  active: boolean
  /** The primary credential reference the adapter resolves (its apiKeyEnv). */
  primaryRef: string | undefined
  /** Whether the primary key is configured in the main settings. */
  primaryConfigured: boolean
  /** Ordered additional keys the user manages. */
  keys: KeyEntry[]
  /** Trigger codes for rotation. */
  triggerCodes: string[]
}

/** Card state the React component renders. */
export interface KeyRotationCardState {
  /** False while the provider directory is loading. */
  available: boolean
  /** Whether the Host document accepts writes. */
  writable: boolean
  /** Provider rows from the directory, joined with rotation config. */
  providers: readonly RotationProviderRow[]
  /** Whether a settings write is in flight. */
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
  addKey: (provider: string) => void
  removeKey: (provider: string, keyId: string) => void
  editKey: (provider: string, keyId: string, value: string) => void
  moveKey: (provider: string, keyId: string, direction: 'up' | 'down') => void
  toggleTrigger: (provider: string, code: string) => void
  storeKey: (provider: string, keyId: string) => void
}

let keyIdCounter = 0
function newKeyId(): string { return `key-${++keyIdCounter}` }

const DEFAULT_TRIGGERS = ['QUOTA', 'AUTH']

/** Saved rotation profile shape read from the settings namespace. */
interface SavedProfile {
  keys: KeyEntry[]
  triggerCodes: string[]
  /** The saved primary reference (`targetRef`), used as a fallback when the adapter's section is unavailable. */
  targetRef?: string
}

/**
 * Bridges the configurable-provider directory and the `llm-key-rotation`
 * settings namespace onto a card for managing a provider's additional keys.
 */
export class KeyRotationCardController {
  private readonly store: SnapshotStore<KeyRotationCardState>
  private rows = new Map<string, RotationProviderRow>()
  private namespaceScopes = new Map<string, SettingsScope<Record<string, unknown>>>()
  private saving = false
  private failed = false

  /**
   * @param scope - the bound settings scope for the `llm-key-rotation` namespace.
   * @param api - the wire API client.
   * @param binder - the settings binder service, used to read a provider's
   *   `apiKeyEnv` from its OWN namespace section (e.g. `llm-pi-ai`).
   */
  constructor(
    private readonly scope: SettingsScope<Record<string, unknown>>,
    private readonly api: IApiClient,
    private readonly binder: SettingsBinder,
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
      // Bind one scope per distinct owning namespace (e.g. `llm-pi-ai`) so the
      // card can read each provider's `apiKeyEnv`. Subscribe so a namespace
      // that is still loading re-runs this load once it becomes ready.
      for (const entry of response.result.value.providers) {
        if (this.namespaceScopes.has(entry.settingsNs)) continue
        const bound = this.binder.bind<Record<string, unknown>>({ namespace: entry.settingsNs })
        this.namespaceScopes.set(entry.settingsNs, bound)
        bound.subscribe(() => {
          if (bound.getSnapshot().status === 'ready') void this.loadProviders()
        })
      }
      this.rows.clear()
      for (const entry of response.result.value.providers) {
        const existing = this.readProfile(snapshot.value, entry.provider)
        const section = this.namespaceScopes.get(entry.settingsNs)?.getSnapshot().value
        const primaryRef = this.readAdapterKeyRef(section, entry)
          ?? existing?.targetRef
        this.rows.set(entry.provider, this.buildRow(entry, existing, primaryRef))
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

  /** Refresh credential facts for the primary ref and all additional refs across rows. */
  private async refreshCredentials(): Promise<void> {
    const refs = new Set<string>()
    for (const row of this.rows.values()) {
      if (row.primaryRef !== undefined) refs.add(row.primaryRef)
      for (const key of row.keys) refs.add(key.ref)
    }
    if (refs.size === 0) { this.publish(); return }
    try {
      const response = await this.api.credentials.describe({ refs: [...refs] })
      if (response.result.ok) {
        const views = response.result.value.credentials as Record<string, CredentialView>
        for (const row of this.rows.values()) {
          if (row.primaryRef !== undefined) {
            row.primaryConfigured = views[row.primaryRef]?.configured ?? false
          }
          for (const key of row.keys) {
            // Facts only: `filled` reflects the durable credential state. Do
            // NOT touch `stored` here — that is a transient "just stored this
            // session" flag set only by storeKey, so one store never greens the
            // other keys.
            key.filled = views[key.ref]?.configured ?? false
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
      id: newKeyId(), ref, value: '', filled: false, stored: false, storing: false, failed: false,
    }))
    const targetRef = profile['targetRef']
    return {
      keys,
      triggerCodes: (profile['triggerCodes'] as string[]) ?? [...DEFAULT_TRIGGERS],
      ...typeof targetRef === 'string' && targetRef.length > 0 ? { targetRef } : {},
    }
  }

  /** Read the adapter's apiKeyEnv from its owning settings section. */
  private readAdapterKeyRef(
    section: Record<string, unknown> | undefined,
    entry: ConfigurableProviderView,
  ): string | undefined {
    if (section === undefined) return undefined
    const node = entry.settingsPath.length === 0
      ? section
      : getPath(section, entry.settingsPath)
    if (typeof node !== 'object' || node === null) return undefined
    const ref = (node as Record<string, unknown>).apiKeyEnv
    return typeof ref === 'string' && ref.length > 0 ? ref : undefined
  }

  /** Build a provider row from the directory entry and any saved profile. */
  private buildRow(
    entry: ConfigurableProviderView,
    existing: SavedProfile | undefined,
    primaryRef: string | undefined,
  ): RotationProviderRow {
    // Drop any saved pool entry that duplicates the primary (a legacy profile
    // whose head was `targetRef`): the card manages additional keys only.
    const keys = existing === undefined
      ? []
      : existing.keys.filter((k) => k.ref !== primaryRef)
    return {
      provider: entry.provider, displayName: entry.displayName, active: entry.active,
      primaryRef, primaryConfigured: false,
      keys,
      triggerCodes: existing?.triggerCodes ?? [...DEFAULT_TRIGGERS],
    }
  }

  /** Re-sync rows after a settings change. */
  private syncFromSettings(): void {
    const snapshot = this.scope.getSnapshot()
    for (const [provider, row] of this.rows) {
      const existing = this.readProfile(snapshot.value, provider)
      if (existing !== undefined) {
        row.keys = existing.keys.filter((k) => k.ref !== row.primaryRef)
        row.triggerCodes = existing.triggerCodes
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

  /** Write the current profiles (additional keys + triggers) to the settings namespace. */
  private async commitProfile(): Promise<boolean> {
    const profiles: Record<string, unknown> = {}
    for (const [provider, row] of this.rows) {
      const keys = row.keys.filter((k) => k.ref !== '' && k.ref !== row.primaryRef)
      if (row.primaryRef === undefined || keys.length === 0) {
        // No primary, or no additional keys: rotation has nothing to rotate to,
        // so remove this provider's profile entirely (the server requires a
        // non-empty poolRefs).
        continue
      }
      profiles[provider] = {
        targetRef: row.primaryRef,
        poolRefs: keys.map((k) => k.ref),
        triggerCodes: row.triggerCodes,
      }
    }
    this.saving = true
    this.failed = false
    this.publish()
    try {
      await this.scope.set('providers', profiles)
      return true
    } catch {
      this.failed = true
      return false
    } finally {
      this.saving = false
      this.publish()
    }
  }

  /** Build the face the card's slot registration injects. */
  inject(): KeyRotationCardFace {
    return {
      hooks: { keyRotationCard: this.store },
      addKey: (provider) => {
        const row = this.rows.get(provider)
        if (row === undefined || row.primaryRef === undefined) return
        let suffix = row.keys.length
        while (row.keys.some((k) => k.ref === deriveExtraKeyRef(provider, suffix))) suffix++
        row.keys.push({
          id: newKeyId(), ref: deriveExtraKeyRef(provider, suffix), value: '',
          filled: false, stored: false, storing: false, failed: false,
        })
        this.publish()
        void this.commitProfile()
      },
      removeKey: (provider, keyId) => {
        const row = this.rows.get(provider)
        if (row === undefined) return
        if (row.keys.length <= 1) return
        row.keys = row.keys.filter((k) => k.id !== keyId)
        row.keys.forEach((key, i) => { key.ref = deriveExtraKeyRef(provider, i) })
        this.publish()
        void this.commitProfile()
      },
      editKey: (provider, keyId, value) => {
        const row = this.rows.get(provider)
        if (row === undefined) return
        const key = row.keys.find((k) => k.id === keyId)
        if (key !== undefined) { key.value = value; key.failed = false; this.publish() }
      },
      moveKey: (provider, keyId, direction) => {
        const row = this.rows.get(provider)
        if (row === undefined) return
        const index = row.keys.findIndex((k) => k.id === keyId)
        if (index < 0) return
        const target = direction === 'up' ? index - 1 : index + 1
        if (target < 0 || target >= row.keys.length) return
        ;[row.keys[index]!, row.keys[target]!] = [row.keys[target]!, row.keys[index]!]
        row.keys.forEach((key, i) => { key.ref = deriveExtraKeyRef(provider, i) })
        this.publish()
        void this.commitProfile()
      },
      toggleTrigger: (provider, code) => {
        const row = this.rows.get(provider)
        if (row === undefined) return
        const idx = row.triggerCodes.indexOf(code)
        if (idx >= 0) row.triggerCodes = row.triggerCodes.filter((c) => c !== code)
        else row.triggerCodes = [...row.triggerCodes, code]
        this.publish()
        void this.commitProfile()
      },
      storeKey: (provider, keyId) => { void this.storeKey(provider, keyId) },
    }
  }

  private async storeKey(provider: string, keyId: string): Promise<void> {
    const row = this.rows.get(provider)
    if (row === undefined) return
    const key = row.keys.find((k) => k.id === keyId)
    if (key === undefined || key.value.trim() === '') return
    key.storing = true
    key.failed = false
    this.publish()
    try {
      await this.api.credentials.set({ ref: key.ref, value: key.value.trim() })
      // Only the key just stored gets the transient green checkmark.
      key.stored = true
      key.filled = true
      key.value = ''
      await this.commitProfile()
    } catch {
      key.failed = true
    } finally {
      key.storing = false
      this.publish()
    }
    void this.refreshCredentials()
  }
}
