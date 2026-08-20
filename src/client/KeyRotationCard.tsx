/**
 * Key Rotation settings card — manages a provider's spare-key chain. Active keys
 * are written by the server into the provider's env reference; this card manages
 * the spare-key chain (`apiKeyEnvChain` refs). Each saved key is stored and never
 * read back, so its input becomes disabled with a `[hidden]` placeholder and can
 * only be removed.
 */

import { type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  KeyRotationCardFace, KeyRotationCardState, RotationProviderRow, ChainEntry,
} from './key-rotation-card-controller.ts'
import type { KeyRotationKey } from './locales.ts'
import css from './KeyRotationCard.module.css'

/** Props the renderer binds for the key-rotation card. */
export type KeyRotationCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.key-rotation'>
  & InjectFace<KeyRotationCardFace>

const ROTATE_ON: ReadonlyArray<{ code: string, labelKey: KeyRotationKey }> = [
  { code: 'QUOTA', labelKey: 'triggerQuota' },
  { code: 'RATE_LIMIT', labelKey: 'triggerRateLimit' },
  { code: 'AUTH', labelKey: 'triggerAuth' },
]

/**
 * The key-rotation card.
 * @param props - composed slot props (runtime, locale, inject face).
 */
export function KeyRotationCard(props: KeyRotationCardProps): ReactNode {
  const { t, useKeyRotationCard, toggleEnabled, toggleRotateOn, addKey, removeKey, editKey, save } = props
  const state = useKeyRotationCard((s: KeyRotationCardState) => s)

  if (!state.available) return null
  if (state.error !== null) return <div className={css.errorBanner}>{state.error}</div>
  if (state.providers.length === 0) return <div className={css.emptyProviders}>{t('noProviders')}</div>

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
            onToggleEnabled={(enabled) => toggleEnabled(row.provider, enabled)}
            onToggleRotateOn={(code) => toggleRotateOn(row.provider, code)}
            onAddKey={() => addKey(row.provider)}
            onRemoveKey={(keyId) => removeKey(row.provider, keyId)}
            onEditKey={(keyId, val) => editKey(row.provider, keyId, val)}
            onSave={() => save(row.provider)}
            t={t}
          />
        ))}
      </div>
    </div>
  )
}

/** One provider section with its toggle, rotate-on chips, and spare-key chain. */
function ProviderSection(props: {
  row: RotationProviderRow
  onToggleEnabled: (enabled: boolean) => void
  onToggleRotateOn: (code: string) => void
  onAddKey: () => void
  onRemoveKey: (keyId: string) => void
  onEditKey: (keyId: string, val: string) => void
  onSave: () => void
  t: (key: KeyRotationKey) => string
}): ReactNode {
  const { row, onToggleEnabled, onToggleRotateOn, onAddKey, onRemoveKey, onEditKey, onSave, t } = props
  const hasChain = row.chain.length > 0

  return (
    <div className={css.provider}>
      <div className={css.providerHeader}>
        <label className={css.switch}>
          <input type="checkbox" checked={row.enabled} onChange={(e) => onToggleEnabled(e.target.checked)} />
          <span className={css.switchSlider} />
        </label>
        <span className={css.providerName}>{row.displayName}</span>
      </div>

      {row.enabled && (
        <div className={css.providerBody}>
          {hasChain ? (
            <>
              <div className={css.keyList}>
                {row.chain.map((key) => (
                  <KeyRow
                    key={key.id}
                    entry={key}
                    onRemove={() => onRemoveKey(key.id)}
                    onEdit={(val) => onEditKey(key.id, val)}
                    t={t}
                  />
                ))}
              </div>

              <div className={css.actions}>
                <button
                  className={`${css.btn} ${css.btnPrimary}`}
                  onClick={onSave}
                  disabled={!row.chain.some((k) => k.value.trim() !== '')}
                >
                  {t('save')}
                </button>
                <button className={`${css.btn} ${css.btnAdd}`} onClick={onAddKey}>
                  {t('addKey')}
                </button>
              </div>

              <div className={css.triggers}>
                <div className={css.chainLabel}>{t('triggers')}</div>
                <div className={css.triggerChips}>
                  {ROTATE_ON.map(({ code, labelKey }) => (
                    <button
                      key={code}
                      className={`${css.chip} ${row.rotateOn.includes(code) ? css.chipOn : ''}`}
                      onClick={() => onToggleRotateOn(code)}
                    >
                      {t(labelKey)}
                    </button>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <div className={css.emptyChain}>
              <button className={`${css.btn} ${css.btnAdd}`} onClick={onAddKey}>
                {t('addKey')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** One key row in the chain. */
function KeyRow(props: {
  entry: ChainEntry
  onRemove: () => void
  onEdit: (val: string) => void
  t: (key: KeyRotationKey) => string
}): ReactNode {
  const { entry, onRemove, onEdit, t } = props

  return (
    <div className={css.keyRow}>
      <div className={css.keyPosition}>#{entry.n}</div>
      <input
        className={`${css.keyInput} ${entry.saved ? css.keyInputSaved : ''}`}
        type="password"
        value={entry.saved ? '' : entry.value}
        onChange={(e) => onEdit(e.target.value)}
        placeholder={entry.saved ? '••••••••••••••••••••' : t('keyPlaceholder')}
        disabled={entry.saved}
        readOnly={entry.saved}
        spellCheck={false}
      />
      <button
        className={`${css.iconBtn} ${css.iconBtnRemove}`}
        onClick={onRemove}
        title={t('remove')}
      >
        ✕
      </button>
    </div>
  )
}
