/**
 * Key Rotation settings card — premium UI for configuring API-key rotation
 * chains per provider. Users pick from already-configured providers, add
 * API keys directly (values, not env-var names), and choose trigger codes.
 */

import { type ReactNode, useState, useCallback } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  KeyRotationCardFace, KeyRotationCardState, RotationProviderRow, KeyEntry,
} from './key-rotation-card-controller.ts'
import type { KeyRotationKey } from './locales.ts'
import css from './KeyRotationCard.module.css'

/** Props the renderer binds for the key-rotation card. */
export type KeyRotationCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.key-rotation'>
  & InjectFace<KeyRotationCardFace>

const TRIGGERS: ReadonlyArray<{ code: string, label: string }> = [
  { code: 'QUOTA', label: 'Quota exceeded' },
  { code: 'RATE_LIMIT', label: 'Rate limited' },
  { code: 'AUTH', label: 'Auth failed (401/403)' },
]

/**
 * The key-rotation card.
 * @param props - composed slot props (runtime, locale, inject face).
 */
export function KeyRotationCard(props: KeyRotationCardProps): ReactNode {
  const { t, useKeyRotationCard, toggleProvider, addKey, removeKey, editKey, moveKey, toggleTrigger, setOnExhausted, storeKey, save } = props
  const state = useKeyRotationCard((s: KeyRotationCardState) => s)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [revealed, setRevealed] = useState<Set<string>>(new Set())

  const toggleExpand = useCallback((provider: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(provider)) next.delete(provider)
      else next.add(provider)
      return next
    })
  }, [])

  const toggleReveal = useCallback((keyId: string) => {
    setRevealed(prev => {
      const next = new Set(prev)
      if (next.has(keyId)) next.delete(keyId)
      else next.add(keyId)
      return next
    })
  }, [])

  if (!state.available) return null
  if (state.error !== null) return <div className={css.errorBanner}>{state.error}</div>
  if (state.providers.length === 0) return null

  return (
    <div className={css.card}>
      <div className={css.header}>
        <h3 className={css.title}>{t('nav')}</h3>
        <p className={css.description}>{t('description')}</p>
      </div>

      <div className={css.providers}>
        {state.providers.map((row) => (
          <ProviderSection
            key={row.provider}
            row={row}
            expanded={expanded.has(row.provider)}
            revealed={revealed}
            onToggleExpand={() => toggleExpand(row.provider)}
            onToggle={() => toggleProvider(row.provider, !row.enabled)}
            onAddKey={() => addKey(row.provider)}
            onRemoveKey={(keyId) => removeKey(row.provider, keyId)}
            onEditKey={(keyId, val) => editKey(row.provider, keyId, val)}
            onMoveKey={(keyId, dir) => moveKey(row.provider, keyId, dir)}
            onToggleTrigger={(code) => toggleTrigger(row.provider, code)}
            onSetOnExhausted={(val) => setOnExhausted(row.provider, val)}
            onStoreKey={(keyId) => storeKey(row.provider, keyId)}
            onToggleReveal={toggleReveal}
            t={t}
          />
        ))}
      </div>

      <div className={css.actions}>
        <button
          className={`${css.btn} ${css.btnPrimary}`}
          onClick={save}
          disabled={state.saving || !state.writable}
        >
          {state.saving ? t('saving') : t('save')}
        </button>
        {state.failed && <span className={`${css.badge} ${css.badgeErr}`}>{t('failed')}</span>}
      </div>
    </div>
  )
}

/** One provider section with its key chain. */
function ProviderSection(props: {
  row: RotationProviderRow
  expanded: boolean
  revealed: Set<string>
  onToggleExpand: () => void
  onToggle: () => void
  onAddKey: () => void
  onRemoveKey: (keyId: string) => void
  onEditKey: (keyId: string, val: string) => void
  onMoveKey: (keyId: string, dir: 'up' | 'down') => void
  onToggleTrigger: (code: string) => void
  onSetOnExhausted: (val: 'delegate' | 'cycle') => void
  onStoreKey: (keyId: string) => void
  onToggleReveal: (keyId: string) => void
  t: (key: KeyRotationKey) => string
}): ReactNode {
  const { row, expanded, revealed, onToggleExpand, onToggle, onAddKey, onRemoveKey, onEditKey, onMoveKey, onToggleTrigger, onSetOnExhausted, onStoreKey, onToggleReveal, t } = props
  const enabledKeys = row.keys.length

  return (
    <div className={`${css.provider} ${row.enabled ? css.providerOn : ''}`}>
      <div className={css.providerHeader} onClick={onToggleExpand}>
        <label className={css.switch} onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" checked={row.enabled} onChange={onToggle} />
          <span className={css.switchSlider} />
        </label>
        <span className={css.providerName}>{row.displayName}</span>
        {row.active
          ? <span className={`${css.tag} ${css.tagActive}`}>Active</span>
          : <span className={`${css.tag} ${css.tagInactive}`}>Inactive</span>}
        <span className={css.keyCount}>
          {enabledKeys} {enabledKeys === 1 ? 'key' : 'keys'}
        </span>
        <span className={`${css.chevron} ${expanded ? css.chevronOpen : ''}`}>▸</span>
      </div>

      {expanded && row.enabled && (
        <div className={css.providerBody}>
          <div className={css.keyChain}>
            <div className={css.chainLabel}>{t('keyChain')}</div>
            {row.keys.map((key, i) => (
              <KeyRow
                key={key.id}
                entry={key}
                index={i}
                total={row.keys.length}
                revealed={revealed.has(key.id)}
                onRemove={() => onRemoveKey(key.id)}
                onEdit={(val) => onEditKey(key.id, val)}
                onMove={(dir) => onMoveKey(key.id, dir)}
                onStore={() => onStoreKey(key.id)}
                onToggleReveal={() => onToggleReveal(key.id)}
                t={t}
              />
            ))}
            <button className={`${css.btn} ${css.btnAdd}`} onClick={onAddKey}>
              + {t('addKey')}
            </button>
          </div>

          <div className={css.triggers}>
            <div className={css.chainLabel}>{t('triggers')}</div>
            <div className={css.triggerChips}>
              {TRIGGERS.map(({ code, label }) => (
                <button
                  key={code}
                  className={`${css.chip} ${row.triggerCodes.includes(code) ? css.chipOn : ''}`}
                  onClick={() => onToggleTrigger(code)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className={css.exhausted}>
            <div className={css.chainLabel}>{t('onExhausted')}</div>
            <div className={css.radioGroup}>
              <label className={css.radio}>
                <input
                  type="radio"
                  name={`exhausted-${row.provider}`}
                  checked={row.onExhausted === 'delegate'}
                  onChange={() => onSetOnExhausted('delegate')}
                />
                <span>{t('delegate')}</span>
              </label>
              <label className={css.radio}>
                <input
                  type="radio"
                  name={`exhausted-${row.provider}`}
                  checked={row.onExhausted === 'cycle'}
                  onChange={() => onSetOnExhausted('cycle')}
                />
                <span>{t('cycle')}</span>
              </label>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** One key row in the chain. */
function KeyRow(props: {
  entry: KeyEntry
  index: number
  total: number
  revealed: boolean
  onRemove: () => void
  onEdit: (val: string) => void
  onMove: (dir: 'up' | 'down') => void
  onStore: () => void
  onToggleReveal: () => void
  t: (key: KeyRotationKey) => string
}): ReactNode {
  const { entry, index, total, revealed, onRemove, onEdit, onMove, onStore, onToggleReveal, t } = props
  const showRemove = total > 1

  return (
    <div className={css.keyRow}>
      <div className={css.keyPosition}>#{index + 1}</div>
      <div className={css.keyControls}>
        <button
          className={css.iconBtn}
          onClick={() => onMove('up')}
          disabled={index === 0}
          title="Move up"
        >↑</button>
        <button
          className={css.iconBtn}
          onClick={() => onMove('down')}
          disabled={index === total - 1}
          title="Move down"
        >↓</button>
      </div>
      <input
        className={css.keyInput}
        type={revealed ? 'text' : 'password'}
        value={entry.value}
        onChange={(e) => onEdit(e.target.value)}
        placeholder={t('keyPlaceholder')}
        spellCheck={false}
      />
      <button
        className={`${css.iconBtn} ${css.iconBtnReveal}`}
        onClick={onToggleReveal}
        title={revealed ? 'Hide' : 'Show'}
      >
        {revealed ? '◉' : '◯'}
      </button>
      <button
        className={`${css.btn} ${css.btnStore}`}
        onClick={onStore}
        disabled={entry.value.trim() === '' || entry.storing}
      >
        {entry.storing ? '…' : t('store')}
      </button>
      <span className={css.keyStatus}>
        {entry.stored ? (
          <span className={css.statusOk}>✓ {t('stored')}</span>
        ) : entry.view?.configured ? (
          <span className={css.statusOk}>✓ {t('stored')} ({entry.view.source})</span>
        ) : entry.failed ? (
          <span className={css.statusErr}>✗ {t('failed')}</span>
        ) : (
          <span className={css.statusEmpty}>{t('notConfigured')}</span>
        )}
      </span>
      {showRemove && (
        <button className={`${css.iconBtn} ${css.iconBtnRemove}`} onClick={onRemove} title="Remove">
          ✕
        </button>
      )}
    </div>
  )
}
