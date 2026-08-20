/** English and Chinese copy for the key-rotation settings card. */

export const en = {
  nav: 'Key Rotation',
  description: 'Automatically rotate API keys when a provider hits subscription limits. Pick a provider, add your keys, and the plugin rotates to the next key on failure — no restart needed.',
  keyChain: 'Key Chain',
  addKey: 'Add Key',
  keyPlaceholder: 'Paste API key value…',
  store: 'Store',
  stored: 'Stored',
  failed: 'Failed',
  notConfigured: 'Not stored',
  triggers: 'Rotate On',
  onExhausted: 'When All Keys Tried',
  delegate: 'Delegate to retry policy',
  cycle: 'Cycle back to first key',
  save: 'Save Profiles',
  saving: 'Saving…',
}

export const zh = {
  nav: '密钥轮转',
  description: '当提供商达到订阅限制时自动轮转 API 密钥。选择提供商，添加密钥，插件会在失败时轮转到下一个密钥 — 无需重启。',
  keyChain: '密钥链',
  addKey: '添加密钥',
  keyPlaceholder: '粘贴 API 密钥值…',
  store: '存储',
  stored: '已存储',
  failed: '失败',
  notConfigured: '未存储',
  triggers: '轮转触发',
  onExhausted: '所有密钥用尽时',
  delegate: '委托给重试策略',
  cycle: '循环回第一个密钥',
  save: '保存配置',
  saving: '保存中…',
}

export type KeyRotationKey = keyof typeof en
