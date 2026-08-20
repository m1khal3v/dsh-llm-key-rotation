/**
 * Key Rotation settings card — manages a provider's **additional** keys on top
 * of a primary key configured through the harness main settings (Models). If
 * the primary is not configured, the card shows a gate message and disables the
 * key editor. Storing/removing/reordering an additional key persists the
 * profile automatically (no Save button).
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

const TRIGGERS: ReadonlyArray<{ code: string, labelKey: KeyRotationKey }> = [
  { code: 'QUOTA', labelKey: 'triggerQuota' },
  { code: 'RATE_LIMIT', labelKey: 'triggerRateLimit' },
  { code: 'AUTH', labelKey: 'triggerAuth' },
]

/**
 * The key-rotation card.
 * @param props - composed slot props (runtime, locale, inject face).
 */
export function KeyRotationCard(props: KeyRotationCardProps): ReactNode {
  const { t, useKeyRotationCard, addKey, removeKey, editKey, moveKey, toggleTrigger, storeKey } = props
  const state = useKeyRotationCard((s: KeyRotationCardState) => s)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const toggleExpand = useCallback((provider: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(provider)) next.delete(provider)
      else next.add(provider)
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
            onToggleExpand={() => toggleExpand(row.provider)}
            onAddKey={() => addKey(row.provider)}
            onRemoveKey={(keyId) => removeKey(row.provider, keyId)}
            onEditKey={(keyId, val) => editKey(row.provider, keyId, val)}
            onMoveKey={(keyId, dir) => moveKey(row.provider, keyId, dir)}
            onToggleTrigger={(code) => toggleTrigger(row.provider, code)}
            onStoreKey={(keyId) => storeKey(row.provider, keyId)}
            t={t}
          />
        ))}
      </div>
    </div>
  )
}

/** One provider section with its additional-key chain. */
function ProviderSection(props: {
  row: RotationProviderRow
  expanded: boolean
  onToggleExpand: () => void
  onAddKey: () => void
  onRemoveKey: (keyId: string) => void
  onEditKey: (keyId: string, val: string) => void
  onMoveKey: (keyId: string, dir: 'up' | 'down') => void
  onToggleTrigger: (code: string) => void
  onStoreKey: (keyId: string) => void
  t: (key: KeyRotationKey) => string
}): ReactNode {
  const { row, expanded, onToggleExpand, onAddKey, onRemoveKey, onEditKey, onMoveKey, onToggleTrigger, onStoreKey, t } = props

  return (
    <div className={css.provider}>
      <div className={css.providerHeader} onClick={onToggleExpand}>
        <span className={css.providerName}>{row.displayName}</span>
        {row.active
          ? <span className={`${css.tag} ${css.tagActive}`}>{t('active')}</span>
          : <span className={`${css.tag} ${css.tagInactive}`}>{t('inactive')}</span>}
        <span className={css.keyCount}>
          {row.keys.length} {row.keys.length === 1 ? t('additionalKeyOne') : t('additionalKeyMany')}
        </span>
        <span className={`${css.chevron} ${expanded ? css.chevronOpen : ''}`}>▸</span>
      </div>

      {expanded && (
        <div className={css.providerBody}>
          <div className={css.primaryRow}>
            <span className={css.primaryLabel}>{t('primary')}</span>
            <code className={css.primaryRef}>{row.primaryRef ?? '—'}</code>
            {row.primaryConfigured ? (
              <span className={`${css.tag} ${css.tagActive}`}>{t('primaryConfigured')}</span>
            ) : (
              <span className={`${css.tag} ${css.tagWarn}`}>{t('primaryMissing')}</span>
            )}
          </div>

          {row.primaryConfigured ? (
            <>
              <div className={css.keyChain}>
                <div className={css.chainLabel}>{t('additionalKeys')}</div>
                {row.keys.length === 0 && (
                  <div className={css.emptyHint}>{t('noAdditionalKeys')}</div>
                )}
                {row.keys.map((key, i) => (
                  <KeyRow
                    key={key.id}
                    entry={key}
                    index={i}
                    total={row.keys.length}
                    onRemove={() => onRemoveKey(key.id)}
                    onEdit={(val) => onEditKey(key.id, val)}
                    onMove={(dir) => onMoveKey(key.id, dir)}
                    onStore={() => onStoreKey(key.id)}
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
                  {TRIGGERS.map(({ code, labelKey }) => (
                    <button
                      key={code}
                      className={`${css.chip} ${row.triggerCodes.includes(code) ? css.chipOn : ''}`}
                      onClick={() => onToggleTrigger(code)}
                    >
                      {t(labelKey)}
                    </button>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <div className={css.gateMessage}>{t('primaryGate')}</div>
          )}
        </div>
      )}
    </div>
  )
}

/** One additional key row in the chain. */
function KeyRow(props: {
  entry: KeyEntry
  index: number
  total: number
  onRemove: () => void
  onEdit: (val: string) => void
  onMove: (dir: 'up' | 'down') => void
  onStore: () => void
  t: (key: KeyRotationKey) => string
}): ReactNode {
  const { entry, index, total, onRemove, onEdit, onMove, onStore, t } = props
  const showRemove = total > 1

  return (
    <div className={css.keyRow}>
      <div className={css.keyPosition}>#{index + 1}</div>
      <div className={css.keyControls}>
        <button
          className={css.iconBtn}
          onClick={() => onMove('up')}
          disabled={index === 0}
          title={t('moveUp')}
        >↑</button>
        <button
          className={css.iconBtn}
          onClick={() => onMove('down')}
          disabled={index === total - 1}
          title={t('moveDown')}
        >↓</button>
      </div>
      <input
        className={css.keyInput}
        type="password"
        value={entry.value}
        onChange={(e) => onEdit(e.target.value)}
        placeholder={t('additionalKeyPlaceholder')}
        spellCheck={false}
      />
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
        ) : entry.filled ? (
          <span className={css.statusFilled}>● {t('filled')}</span>
        ) : entry.failed ? (
          <span className={css.statusErr}>✗ {t('failed')}</span>
        ) : (
          <span className={css.statusEmpty}>{t('empty')}</span>
        )}
      </span>
      {showRemove && (
        <button className={`${css.iconBtn} ${css.iconBtnRemove}`} onClick={onRemove} title={t('remove')}>
          ✕
        </button>
      )}
    </div>
  )
}
