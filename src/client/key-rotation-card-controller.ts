/**
 * Controller for the key-rotation settings card. Bridges the `llm-key-rotation`
 * settings namespace onto a YAML-editor form and manages credential writes
 * through the wire API.
 */

import type { SettingsScope, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { IApiClient, CredentialView } from '@deepseek-ai/dsh-api-remotes/client'

/** One credential reference extracted from the profiles YAML. */
export interface CredentialRow {
  /** Credential reference name (e.g. `OPENCODE_API_KEY_2`). */
  ref: string
  /** Current credential state from the Host. */
  view: CredentialView | undefined
  /** Draft key value the user typed; blank until typed. */
  draft: string
  /** Whether a store is crossing the wire. */
  storing: boolean
  /** Whether the last store succeeded. */
  stored: boolean
}

/** Card state the React component renders. */
export interface KeyRotationCardState {
  /** False while the namespace is not served; the card renders nothing. */
  available: boolean
  /** Whether the Host document accepts writes. */
  writable: boolean
  /** YAML draft text the editor renders. */
  yamlText: string
  /** Whether the YAML draft parses without error. */
  yamlValid: boolean
  /** YAML parse error message, when invalid. */
  yamlError: string | undefined
  /** Whether a save is crossing the wire. */
  saving: boolean
  /** Whether the last save did not land. */
  failed: boolean
  /** Credential rows derived from the current profiles. */
  credentials: readonly CredentialRow[]
}

/** The face the card's slot registration injects. */
export interface KeyRotationCardFace {
  hooks: {
    /** Card snapshot bound by the renderer as useKeyRotationCard. */
    keyRotationCard: SnapshotStore<KeyRotationCardState>
  }
  /** Stage YAML draft text. */
  editYaml: (text: string) => void
  /** Stage a credential draft for one ref. */
  editCredential: (ref: string, value: string) => void
  /** Write the YAML draft to the Host settings document. */
  save: () => void
  /** Discard YAML edits. */
  discard: () => void
  /** Store one credential value through the wire API. */
  storeCredential: (ref: string) => void
}

/** Parse a YAML string into a providers map, returning undefined on failure. */
function parseProviders(text: string): Record<string, unknown> | undefined {
  try {
    // Dynamic import would be ideal, but the browser bundle must stay self-contained.
    // A minimal YAML parser inline avoids a heavy dependency.
    const result = simpleYamlParse(text)
    if (typeof result !== 'object' || result === null || Array.isArray(result)) return undefined
    return result as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** Extract all credential references from a providers map. */
function extractRefs(providers: Record<string, unknown>): string[] {
  const refs = new Set<string>()
  for (const profile of Object.values(providers)) {
    if (typeof profile !== 'object' || profile === null) continue
    const p = profile as Record<string, unknown>
    const target = p['targetRef']
    if (typeof target === 'string' && target.length > 0) refs.add(target)
    const pool = p['poolRefs']
    if (Array.isArray(pool)) {
      for (const ref of pool) {
        if (typeof ref === 'string' && ref.length > 0) refs.add(ref)
      }
    }
  }
  return [...refs].sort()
}

/**
 * A minimal YAML subset parser sufficient for the `providers` map shape:
 * nested mappings, sequences of strings, and scalar values. It is NOT a
 * general YAML parser — it handles the key-rotation config format only.
 */
function simpleYamlParse(text: string): unknown {
  const lines = text.split('\n')
  return parseBlock(lines, 0, 0).value
}

interface ParseResult {
  value: unknown
  consumed: number
}

function parseBlock(lines: string[], start: number, indent: number): ParseResult {
  const map: Record<string, unknown> = {}
  let i = start
  while (i < lines.length) {
    const line = lines[i]!
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) { i++; continue }
    const lineIndent = line.length - line.trimStart().length
    if (lineIndent < indent) break
    if (lineIndent > indent) { i++; continue }
    if (trimmed.startsWith('- ')) {
      // Sequence at this indent level
      const seq: unknown[] = []
      while (i < lines.length) {
        const seqLine = lines[i]!
        const seqTrimmed = seqLine.trim()
        if (seqTrimmed === '' || seqTrimmed.startsWith('#')) { i++; continue }
        const seqIndent = seqLine.length - seqLine.trimStart().length
        if (seqIndent < indent) break
        if (seqIndent > indent) { i++; continue }
        if (!seqTrimmed.startsWith('- ')) break
        seq.push(seqTrimmed.slice(2).trim())
        i++
      }
      return { value: seq, consumed: i - start }
    }
    const colonIdx = trimmed.indexOf(':')
    if (colonIdx < 0) { i++; continue }
    const key = trimmed.slice(0, colonIdx).trim()
    const rest = trimmed.slice(colonIdx + 1).trim()
    if (rest === '') {
      // Nested block
      const nested = parseBlock(lines, i + 1, indent + 2)
      map[key] = nested.value
      i += 1 + nested.consumed
    } else {
      map[key] = rest
      i++
    }
  }
  return { value: map, consumed: i - start }
}

/**
 * Bridges the `llm-key-rotation` scope onto the card's YAML-editor form and
 * manages credential writes through the wire API.
 */
export class KeyRotationCardController {
  private readonly store: SnapshotStore<KeyRotationCardState>
  private yamlDraft: string | undefined
  private credentialDrafts = new Map<string, string>()
  private credentialStoring = new Set<string>()
  private credentialStored = new Set<string>()
  private credentialViews = new Map<string, CredentialView>()
  private saving = false
  private failed = false

  /**
   * @param scope - the bound settings scope for the `llm-key-rotation` namespace.
   * @param api - the wire API client for credential reads/writes.
   */
  constructor(
    private readonly scope: SettingsScope<Record<string, unknown>>,
    private readonly api: IApiClient,
  ) {
    this.store = createSnapshotStore(this.projection())
    this.scope.subscribe(() => {
      this.refreshCredentials()
      this.store.set(this.projection())
    })
    void this.refreshCredentials()
  }

  /** Refresh credential views for all refs in the current profiles. */
  private async refreshCredentials(): Promise<void> {
    const snapshot = this.scope.getSnapshot()
    const providers = snapshot.value?.['providers']
    if (typeof providers !== 'object' || providers === null) return
    const refs = extractRefs(providers as Record<string, unknown>)
    if (refs.length === 0) return
    try {
      const response = await this.api.credentials.describe({ refs })
      if (response.result.ok) {
        for (const [ref, view] of Object.entries(response.result.value.credentials)) {
          this.credentialViews.set(ref, view)
        }
      }
    } catch {
      // Credential enrichment is best-effort; the card still works without it.
    }
    this.store.set(this.projection())
  }

  private projection(): KeyRotationCardState {
    const snapshot = this.scope.getSnapshot()
    const providers = snapshot.value?.['providers']
    const baseYaml = typeof providers === 'object' && providers !== null
      ? yamlStringify(providers as Record<string, unknown>)
      : ''
    const yamlText = this.yamlDraft ?? baseYaml
    const parsed = parseProviders(yamlText)
    const refs = parsed ? extractRefs(parsed) : []
    const credentials: CredentialRow[] = refs.map(ref => ({
      ref,
      view: this.credentialViews.get(ref),
      draft: this.credentialDrafts.get(ref) ?? '',
      storing: this.credentialStoring.has(ref),
      stored: this.credentialStored.has(ref),
    }))
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      yamlText,
      yamlValid: parsed !== undefined,
      yamlError: parsed === undefined ? 'Invalid YAML structure' : undefined,
      saving: this.saving,
      failed: this.failed,
      credentials,
    }
  }

  /** Build the face the card's slot registration injects. */
  inject(): KeyRotationCardFace {
    return {
      hooks: { keyRotationCard: this.store },
      editYaml: (text) => {
        this.yamlDraft = text
        this.failed = false
        this.store.set(this.projection())
      },
      editCredential: (ref, value) => {
        this.credentialDrafts.set(ref, value)
        this.credentialStored.delete(ref)
        this.store.set(this.projection())
      },
      save: () => { void this.save() },
      discard: () => {
        this.yamlDraft = undefined
        this.failed = false
        this.store.set(this.projection())
      },
      storeCredential: (ref) => { void this.storeCredential(ref) },
    }
  }

  private async save(): Promise<void> {
    const text = this.yamlDraft
    if (text === undefined || this.saving) return
    const parsed = parseProviders(text)
    if (parsed === undefined) return
    this.saving = true
    this.failed = false
    this.store.set(this.projection())
    try {
      await this.scope.set('providers', parsed)
      this.yamlDraft = undefined
    } catch {
      this.failed = true
    }
    this.saving = false
    this.store.set(this.projection())
    void this.refreshCredentials()
  }

  private async storeCredential(ref: string): Promise<void> {
    const value = this.credentialDrafts.get(ref)?.trim()
    if (value === undefined || value === '') return
    this.credentialStoring.add(ref)
    this.credentialStored.delete(ref)
    this.store.set(this.projection())
    try {
      await this.api.credentials.set({ ref, value })
      this.credentialDrafts.set(ref, '')
      this.credentialStored.add(ref)
    } catch {
      // Store failure is surfaced per-row; the card stays usable.
    }
    this.credentialStoring.delete(ref)
    this.store.set(this.projection())
    void this.refreshCredentials()
  }
}

/** Serialize a providers map back to YAML text (minimal serializer). */
function yamlStringify(value: Record<string, unknown>): string {
  const lines: string[] = []
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
      lines.push(`${key}:`)
      for (const [innerKey, innerVal] of Object.entries(val as Record<string, unknown>)) {
        if (Array.isArray(innerVal)) {
          lines.push(`  ${innerKey}:`)
          for (const item of innerVal) {
            lines.push(`    - ${String(item)}`)
          }
        } else {
          lines.push(`  ${innerKey}: ${String(innerVal)}`)
        }
      }
    } else if (Array.isArray(val)) {
      lines.push(`${key}:`)
      for (const item of val) {
        lines.push(`  - ${String(item)}`)
      }
    } else {
      lines.push(`${key}: ${String(val)}`)
    }
  }
  return lines.join('\n')
}
