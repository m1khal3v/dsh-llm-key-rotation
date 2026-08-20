/**
 * Key-rotation settings card, browser half. Registers a card in the Plugins
 * settings page under the `settings.plugin.item` keyed slot, keyed to the
 * `llm-key-rotation` namespace. The card reads the configurable-provider
 * directory and manages a provider's **additional** keys (the primary key lives
 * in the main settings).
 * @module @m1khal3v/dsh-llm-key-rotation/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
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

export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']

/**
 * Mount the key-rotation card in the Plugins settings page.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const { api } = ctx.get('connection') as ConnectionHandle
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'ui-key-rotation: dictionaries')

  const controller = new KeyRotationCardController(
    ctx.settingsScope.bind({ namespace: NS }),
    api,
    ctx.settingsScope,
  )

  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: NS,
    locale: LOCALE_NS,
    inject: () => controller.inject(),
  }, KeyRotationCard))
}
