/** English and Chinese copy for the key-rotation settings card. */

export const en = {
  nav: 'Key Rotation',
  description: 'List every API key a provider can use. When a provider hits a subscription or rate limit, the plugin rotates through these keys automatically.',
  noProviders: 'No providers configured yet. Add a provider in the main settings first.',
  triggers: 'Rotate On',
  triggerQuota: 'Quota exceeded',
  triggerRateLimit: 'Rate limited',
  triggerAuth: 'Auth failed (401/403)',
  addKey: 'Add key',
  keyPlaceholder: 'Paste API key value…',
  save: 'Save',
  remove: 'Remove',
  rotating: 'Key rotation enabled',
}

export const zh = {
  nav: '密钥轮转',
  description: '列出提供商可用的所有 API 密钥。当提供商达到订阅或速率限制时，插件会自动在这些密钥之间轮转。',
  noProviders: '尚未配置任何提供商。请先在主设置中添加提供商。',
  triggers: '轮转触发',
  triggerQuota: '配额已用尽',
  triggerRateLimit: '触发限流',
  triggerAuth: '认证失败 (401/403)',
  addKey: '添加密钥',
  keyPlaceholder: '粘贴 API 密钥值…',
  save: '保存',
  remove: '移除',
  rotating: '密钥轮转已启用',
}

export type KeyRotationKey = keyof typeof en
