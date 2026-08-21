<p align="center">
  <a href="https://www.npmjs.com/package/@m1khal3v/dsh-llm-key-rotation"><img alt="npm" src="https://img.shields.io/npm/v/@m1khal3v/dsh-llm-key-rotation?style=flat-square&color=4b6fff"></a>
  <img alt="DeepSeek Harness" src="https://img.shields.io/badge/deepseek--harness-v0.1.1--rc.1-263146?style=flat-square">
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square"></a>
  <img alt="Status" src="https://img.shields.io/badge/status-beta-7da1de?style=flat-square">
</p>

<h1 align="center">dsh-llm-key-rotation</h1>
<p align="center">
  <img width="500" height="502" alt="изображение" src="https://github.com/user-attachments/assets/84f63f77-3492-4027-ace7-30b6d08616ef" />
</p>
<p align="center">
  <b>Seamless API-key rotation for <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a>.</b><br>
  Hit a quota limit or 429 Rate Limit? The plugin swaps in the next key you configured and retries instantly — no restarts, no context loss, and zero interruptions.
</p>

---

## ⚡️ Highlights

- 🔄 **Invisible to Agent & User**: Request fails with quota/rate limit → plugin hot-swaps the key → request retries and succeeds seamlessly.
- 🎛 **Native Web UI**: List every key a provider can use and toggle rotation right inside Settings.
- 🧠 **Smart Anti-Spin**: Cooldown discipline prevents infinite loops if all your keys are exhausted.
- 🧼 **Zero Core Patches**: Plugs cleanly into the Harness recovery waterfall — safe to install, safe to remove.

---

## 🛠 How It Works

```text
┌─────────────────┐          429 / QUOTA / AUTH          ┌──────────────────────┐
│  Model Request  │ ───────────────────────────────────► │  llm-key-rotation    │
└─────────────────┘                                      └──────────┬───────────┘
         ▲                                                          │
         │                  { kind: 'retry' }                       │ 1. Pick next key
         │             (Adapter re-resolves key)                    │ 2. Hot-swap env ref
         └──────────────────────────────────────────────────────────┘
```

1. You keep working with your currently-active key as usual.
2. If a request fails (`QUOTA`, `RATE_LIMIT`, or `AUTH`), the plugin loads the next key from your configured chain.
3. The turn retries with the new key, and future requests continue with the working key.

---

## 🚀 Quick Start

### 1. Install the plugin

```sh
dsh plugin --profile web add @m1khal3v/dsh-llm-key-rotation
```

### 2. Configure via Web UI

Navigate to **Settings** → **Plugins** → **Key Rotation**:

1. **Toggle on** rotation for your target provider.
2. Select your trigger codes (default: `QUOTA`, `AUTH`).
3. Click **Add key**, paste all the keys you want that provider to rotate through, and hit **Save**.

*(Keys are safely saved to the Harness credential store)*.

---

## ⚙️ Behavior & Good to Know

- **Smart Rotation Window (300s):** During consecutive failures, the plugin walks forward through your configured keys. If no failures occur for >5 minutes, the chain resets to start from the top again.
- **Interplay with `dsh-llm-retry`:**
  - `QUOTA` and `AUTH` rotate **immediately**.
  - `RATE_LIMIT` is handled by `dsh-llm-retry` first (with backoff). To rotate instantly on 429 errors instead, simply remove `RATE_LIMIT` from your provider's `retryableCodes`.
- **Live Terminal Logs:** Watch rotation events in real time right in your `dsh` terminal:
  ```text
  [llm-key-rotation] rotated provider="opencode-go" chain[0]→"OPENCODE_GO_API_KEY" (QUOTA)
  ```
  *(Secret values are never logged — only provider names, indices, and error codes).*

---

## 🧑‍💻 Development

```sh
pnpm install
pnpm run verify    # typecheck + test
pnpm run build
```

## 📄 License

[MIT](LICENSE)
