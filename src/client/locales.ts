/** English and Chinese copy for the key-rotation settings card. */

export const en = {
  nav: 'Key Rotation',
  description: 'Configure a spare-key chain per provider. When a provider hits a subscription limit, the plugin rotates through these spare keys.',
  noProviders: 'No providers configured yet. Add a provider in the main settings first.',
  triggers: 'Rotate On',
  triggerQuota: 'Quota exceeded',
  triggerRateLimit: 'Rate limited',
  triggerAuth: 'Auth failed (401/403)',
  addKey: '+ Add key',
  keyPlaceholder: 'Paste API key value…',
  save: 'Save',
  hidden: '[hidden]',
  remove: 'Remove',
}

export const zh = {
  nav: '密钥轮转',
  description: '为每个提供商配置备用密钥链。当提供商达到订阅上限时，插件会轮转到这些备用密钥。',
  noProviders: '尚未配置任何提供商。请先在主设置中添加提供商。',
  triggers: '轮转触发',
  triggerQuota: '配额已用尽',
  triggerRateLimit: '触发限流',
  triggerAuth: '认证失败 (401/403)',
  addKey: '+ 添加密钥',
  keyPlaceholder: '粘贴 API 密钥值…',
  save: '保存',
  hidden: '[已隐藏]',
  remove: '移除',
}

export type KeyRotationKey = keyof typeof en
