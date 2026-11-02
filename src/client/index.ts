/**
 * Key-rotation settings page, browser half. Registers a tab in the Plugins
 * settings page (`settings.plugins.tab`) keyed to the `llm-key-rotation`
 * namespace. The card reads the registered-provider directory and manages each
 * provider's key chain (its `_CHAIN_N` refs).
 * @module @m1khal3v/dsh-llm-key-rotation/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { KeyRotationCard } from './KeyRotationCard.tsx'
import { KeyRotationCardController } from './key-rotation-card-controller.ts'
import { en, zh, type KeyRotationKey } from './locales.ts'

/** Settings namespace owned by the server plugin. */
const NS = 'llm-key-rotation'
/** Dictionary namespace owned by this card. */
const LOCALE_NS = 'settings.key-rotation' as const

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Key Rotation settings card copy. */
    'settings.key-rotation': KeyRotationKey
  }
}

export const inject = [
  'slots',
  'locale',
  'remote',
  'remote.credentials',
  'remote.llm',
  'remote.settings',
  'configForms',
]

/**
 * Mount the key-rotation card as a Plugins settings tab.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'ui-key-rotation: dictionaries')

  const t = ctx.locale.bind(LOCALE_NS)
  const form: ConfigForm<Record<string, unknown>> = ctx.configForms.get<Record<string, unknown>>(NS)
  const controller = new KeyRotationCardController(form, ctx.remote)

  ctx.effect(() => ctx.configForms.whileServed([NS], () => ctx.slots.inject(
    'settings.plugins.tab',
    () => ctx.slots.register({
      name: 'settings.plugins.tab',
      id: NS,
      order: 100,
      label: () => t('nav'),
      locale: LOCALE_NS,
      inject: () => controller.inject(),
    }, KeyRotationCard),
  )), 'ui-key-rotation: settings page')
}
