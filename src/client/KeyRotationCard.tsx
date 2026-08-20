/**
 * Key-rotation settings card component. Renders a YAML editor for the
 * `providers` map and credential inputs for each pool ref.
 */

import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { KeyRotationCardFace, KeyRotationCardState } from './key-rotation-card-controller.ts'

/** Props the renderer binds for the key-rotation card. */
export type KeyRotationCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.key-rotation'>
  & InjectFace<KeyRotationCardFace>

const styles = {
  card: 'key-rot-card',
  header: 'key-rot-header',
  title: 'key-rot-title',
  description: 'key-rot-description',
  section: 'key-rot-section',
  label: 'key-rot-label',
  hint: 'key-rot-hint',
  textarea: 'key-rot-textarea',
  error: 'key-rot-error',
  actions: 'key-rot-actions',
  button: 'key-rot-btn',
  buttonPrimary: 'key-rot-btn-primary',
  buttonDisabled: 'key-rot-btn-disabled',
  badge: 'key-rot-badge',
  badgeOk: 'key-rot-badge-ok',
  badgeErr: 'key-rot-badge-err',
  credList: 'key-rot-cred-list',
  credRow: 'key-rot-cred-row',
  credRef: 'key-rot-cred-ref',
  credInput: 'key-rot-cred-input',
  credStatus: 'key-rot-cred-status',
  credStatusOk: 'key-rot-cred-status-ok',
  credStatusRo: 'key-rot-cred-status-ro',
  empty: 'key-rot-empty',
}

/**
 * The key-rotation card: a YAML editor for provider profiles and credential
 * inputs for each pool ref.
 * @param props - the composed slot props (runtime, locale, inject face).
 */
export function KeyRotationCard(props: KeyRotationCardProps): ReactNode {
  const { t, useKeyRotationCard, editYaml, editCredential, save, discard, storeCredential } = props
  const state = useKeyRotationCard((snapshot: KeyRotationCardState) => snapshot)

  if (!state.available) return null

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <h3 className={styles.title}>{t('nav')}</h3>
        <p className={styles.description}>{t('description')}</p>
      </div>

      <div className={styles.section}>
        <label className={styles.label}>{t('yamlLabel')}</label>
        <p className={styles.hint}>{t('yamlHint')}</p>
        <textarea
          className={styles.textarea}
          value={state.yamlText}
          onChange={(e) => editYaml(e.target.value)}
          placeholder={t('yamlPlaceholder')}
          rows={12}
          spellCheck={false}
        />
        {!state.yamlValid && (
          <p className={styles.error}>{state.yamlError ?? t('invalid')}</p>
        )}
        <div className={styles.actions}>
          <button
            className={`${styles.button} ${styles.buttonPrimary}`}
            onClick={() => save()}
            disabled={!state.yamlValid || state.saving || !state.writable}
          >
            {state.saving ? t('saving') : t('save')}
          </button>
          <button
            className={styles.button}
            onClick={() => discard()}
            disabled={state.saving}
          >
            {t('discard')}
          </button>
          {state.failed && <span className={`${styles.badge} ${styles.badgeErr}`}>{t('failed')}</span>}
        </div>
      </div>

      <div className={styles.section}>
        <label className={styles.label}>{t('credentials')}</label>
        <p className={styles.hint}>{t('credentialsHint')}</p>
        {state.credentials.length === 0 ? (
          <p className={styles.empty}>{t('noCredentials')}</p>
        ) : (
          <div className={styles.credList}>
            {state.credentials.map((row) => (
              <div key={row.ref} className={styles.credRow}>
                <span className={styles.credRef}>{row.ref}</span>
                <input
                  className={styles.credInput}
                  type="password"
                  value={row.draft}
                  onChange={(e) => editCredential(row.ref, e.target.value)}
                  placeholder={t('keyValue')}
                />
                <button
                  className={styles.button}
                  onClick={() => storeCredential(row.ref)}
                  disabled={row.draft.trim() === '' || row.storing}
                >
                  {row.storing ? '…' : t('store')}
                </button>
                <span className={styles.credStatus}>
                  {row.stored ? (
                    <span className={styles.credStatusOk}>{t('stored')}</span>
                  ) : row.view?.configured ? (
                    <span className={styles.credStatusOk}>
                      {t('stored')} ({row.view.source})
                    </span>
                  ) : row.view?.writable === false ? (
                    <span className={styles.credStatusRo}>{t('readonly')}</span>
                  ) : (
                    <span>{t('notConfigured')}</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
