# dsh-llm-key-rotation — Diagnosis & "Works 100%" Plan (rev 4 — UI overhaul + harden, no `cycle`)

Author: debugging session, 2026-08-20.

**Constraint (user):** no harness changes (no `dsh-session`, no `SessionEventMap`, no wire
API, no `dsh-*` source edits). **Replaced `cycle` mode entirely**; the plugin manages
**only additional (extra) keys** on top of a primary that is configured in the **main
settings (Models)**, never in the plugin. All changes stay inside this package.

Everything below is verified against the live `web` profile
(`$DSH_HOME=/Users/m1khal3v/.dsh`, GUI at `http://127.0.0.1:3080`) and the harness source.

---

## TL;DR

The plugin loads and config is correct; the real gaps are (a) no stdout log on a successful
rotation (so you can't confirm it works), and (b) several **card/UX bugs** that you listed.
This plan: adds the stdout log, and reworks the card + server model so the plugin is purely
**"extra keys manager"** with a clean, non-purple UI. `delegate` is the only mode left.

---

## What is verified working

- Bundle composed in the `web` profile; live server serves
  `/plugins/@m1khal3v/dsh-llm-key-rotation/client.js` (boot manifest row present). Server
  plugin active (client-modules includes only active fibers).
- Config present in `settings.yaml` for `opencode-go` and `opencode`; credentials present,
  none env-shadowed; `QUOTA/AUTH/RATE_LIMIT` not retried by `dsh-llm-retry`, so rotation acts.
- The rotation mechanism (per-request credential re-resolution + `{kind:'retry'}`) is sound.

---

## The single "can't confirm it works" gap

`rotate()` on success only does `ctx.emit('llm/key-rotation', …)` and returns
`{kind:'retry'}` — **no `ctx.logger` line**. Fix in Change 1.

---

## PLAN

### Change 1 — stdout logging on every rotation event (core fix)
In `src/index.ts`, `rotate()`, on the success path (after `state.rotatedSinceSuccess += 1`):
```ts
ctx.logger.info(
  '[llm-key-rotation] rotated provider="%s" %d→%d (%s) retry=%d rotationId=%s targetRef="%s"',
  provider, fromIndex, toIndex, failure.code, state.rotatedSinceSuccess, state.rotationId, profile.targetRef,
)
```
No key values logged (indices/refs/codes only). Also tag the existing seed and delegate
(`warn`) lines with `[llm-key-rotation]`. Document in README that stdout of the launching
process is the rotation trail.

### Change 2 — in-repo regression test for the log line
Capture `ctx.logger` in `tests/rotation.spec.ts`; assert a `[llm-key-rotation] rotated …`
line on success with correct `from→to`/code/`retry` and **no** key values.

### Change 3 — `pnpm run verify`
`typecheck` + `test` in one script.

---

### Change 4 — remove `cycle` entirely (server schema + all references)
- **Delete** `'cycle'` from the `onExhausted` union in `src/index.ts` schema and
  `src/types.ts` (`RotationProfile.onExhausted`). The server no longer has the infinite-burn
  path: only `delegate` remains.
- Since the plugin now manages only **extra keys**, redefine the pool so `poolRefs` are the
  **additional refs only** (the primary is `targetRef`, set in main settings, NOT a pool
  entry). Server rotation chain = primary (in targetRef) → each extra → exhausted/delegate.
  Adjust the exhaustion cap from `pool.length - 1` to `pool.length` (try every extra once).
  - Migration: when reading an existing profile where `poolRefs[0] === targetRef`, drop that
    head entry so `poolRefs` becomes extras-only. Keep the card from ever writing the primary
    into the pool again.
- Update README (remove `cycle`, document "extra keys only" model).

### Change 5 — card: only extra keys, primary handled in main settings
Reorder/navigate the card so it manages **additional keys only**:
- Read the provider's `targetRef`/`apiKeyEnv` from the adapter (main settings) as the
  **primary ref**.
- If the primary ref is **not configured**: show a clear message, e.g.
  "Настройте сначала основной ключ в основных настройках (Models), потом добавьте
  дополнительные", and disable add/store until the primary exists.
- Label rows/buttons explicitly "Дополнительный ключ 1 / 2 / …" (additional), distinct from
  the primary which the card never edits.
- Pool written to settings = extras only (`poolRefs` minus primary).
- Show a small indicator that the primary is configured (so the user knows the gate).

### Change 6 — card bug fixes (the ones you reported)
- **Green checkmark on every key after Store** — root cause: after a single store,
  `storeKey()` calls `refreshCredentials()`, which re-`describe`s **all** refs of **all**
  rows and sets `key.stored = views[key.ref]?.configured ?? false` for every key; when a
  provider's refs map to the same/blank credential entry, the `configured` flag spreads to
  unrelated keys. Fix: only refresh/affect the **stored key's own** row/ref; derive stored
  state per ref from `describe`, not by blanket-assigning across rows. Add a regression test
  with a mock `describe` that returns configured only for the stored ref.
- **Visual "filled" indicator** — add an explicit filled/unfilled state per key: a filled
  dot / "• filled" vs "empty" badge driven by (a) `describe().configured` for that ref and
  (b) whether the input currently holds a value. Show it independently of the store
  status, so "this key has a stored value" is visible at a glance.
- **"1 key" shown for providers with no configured key** — currently a row always renders at
  least the primary-style row and the count `row.keys.length` (≥1). With extras-only
  management, a provider with no extras should show **0 keys** (or an explicit
  "не настроено дополнительных ключей"), not "1 key". Fix the initial row construction so
  no phantom key exists when none is stored.
- **Show button** — make `◉/◯` reveal reliable across reopen: either persist reveal for
  stored keys consistently (reset reveal only on brand-new key rows) or, per your
  preference, **remove the Show toggle entirely** and keep the field as `password` with a
  filled indicator. Decision noted: simplest robust choice is to remove Show and rely on the
  filled dot; the plan follows that unless you prefer keep-Show-always. (Handled by you
  saying "либо всегда, либо убрать" — default to **remove** for simplicity, mention both.)
- **Remove Save Profiles button; autosave on store** — delete the `save()`/Save button.
  When a user stores an extra key, immediately write the current profile (extras + triggers)
  to the settings namespace as part of the same action, so config is always in sync with the
  stored keys. Add `credential.set` + `settings.set` as one logical commit (with per-key
  error surfacing).

### Change 7 — card styling: match normal settings colors (not purple)
Root cause: `KeyRotationCard.module.css` hardcodes `#4b6fff` (and `#5d7eff`, `#1a1a2e`,
`#999`) as literal fallbacks for `--dsw-accent`/color in ~20 places — standard settings cards
use only semantic `--dsw-alias-*` / `--dsw-*` tokens (see
`ui-settings-plugins/src/client/fields.module.css`). Fix: replace every literal color
override with the shared tokens (`--dsw-alias-accent/…`, `--dsw-alias-bg-surface…`,
`--dsw-text-*`, `--dsw-border`, `--dsw-error`/`--dsw-success`), so the card matches normal
settings and never renders purple. Drop `--dsw-accent` fallbacks.

### Change 8 — hardening (server) after `cycle` is gone
With only `delegate`, keep:
- **`maxIncidentRotations?: number`** — optional explicit cap (default = try every extra
  once, `pool.length`); useful to try *fewer* keys.
- **`cooldownMs?: number`** — after the cap, stop rotating this provider for the window and
  delegate (prevents a rapid refire loop from hammering keys). Reset on success.
- **Index reset to 0 on success** — plus **restore the primary value to `targetRef`** after
  a successful incident, so the next run starts from the primary (matching "primary owned by
  main settings"). Log `[llm-key-rotation] reset provider="…" index→0`.
  - ⚠️ Decision to confirm with user: restoring the primary to `targetRef` overwrites the
    ref with the primary's value after each success. Alternative: leave the last-used extra
    in `targetRef`. Default plan = restore primary (cleanest vs "primary via main settings"),
    flag for confirmation.
- Tests: cap stops after N and delegates; cooldown window suppresses; index reset + primary
  restore after success; schema defaults preserve behavior when fields absent.

### Change 9 — browser QA of the card
Use the browser-automation skill: open Settings → Plugins → Configurable, confirm the card
renders, colors match other settings cards (no purple), primary-gate message shows when the
primary is unset, extra keys store + autosave into `settings.yaml`, filled indicator and
per-key status are correct, and no phantom "1 key" row. If the card does not render at all:
a contained client-half `apply` bug (check browser console for `client-modules`/slot errors).

---

## Manual verification
1. `dsh web` in a visible terminal; trigger a failure; watch
   `[llm-key-rotation] rotated …` then confirm the next request succeeds.
2. In the GUI: primary unset → see "настройте сначала основной ключ". Set primary in Models;
   add extras via the card; confirm Store autosaves, filled indicators appear per stored key,
   no phantom "1 key", no purple, no green-checkmark-on-all bug.

---

## Why this stays inside the plugin (no mоvетон)
Server schema, card, CSS, and tests are all in this package. Uses only existing settings /
credentials / webServer-slot / wire services. No `SessionEventMap`, no `dsh-*` source edits.

## Priority
1. **Change 1/2/3** — stdout proof it works.
2. **Change 4** — drop `cycle`; extras-only model.
3. **Change 5/6/7** — card rework: primary gate, bug fixes (checkmark / filled / "1 key" /
   Show / autosave), colors.
4. **Change 8** — hardening (cap/cooldown/restore-primary).
5. **Change 9** — browser QA.

---

## Implementation status (2026-08-20)

Implemented in this session (src/ + tests + README + build), `pnpm verify` green (14 tests):

- **Change 1** — `[llm-key-rotation] rotated …` stdout line on every commit; tagged seed-blocked /
  delegate / cooldown / restore `warn|info` lines; no key values logged. ✓
- **Change 2/3** — log-line regression test; `pnpm run verify` script (`typecheck && test`). ✓
- **Change 4** — `cycle` removed from schema/types; `onExhausted` gone; extras-only pool model
  (primary = `targetRef` configured in main settings; legacy `poolRefs[0] === targetRef` ignored);
  proactive seed removed (primary not configured → stdout warning instead). ✓
- **Change 5** — card shows primary ref + configured gate; adds/stores/reorders **additional** keys
  only; gate message when primary unset; labels "Additional Keys". ✓
- **Change 6** — green checkmark scoped to the just-stored key (no blanket all-keys); **filled** dot
  indicator from `describe`; no phantom "1 key" (0 keys until an extra is added); **Show button
  removed** (password field + filled indicator); **Save button removed** — autosave on
  store/add/remove/reorder/trigger via `commitProfile`; provider profile deleted when no extras. ✓
- **Change 7** — CSS rewritten on `--dsw-alias-*` semantic tokens; no hardcoded purple. ✓
- **Change 8** — `maxIncidentRotations` (default = #extras) + `cooldownMs` (both computed on the
  extras model); synchronous incident reset on success + background primary restore to `targetRef`. ✓
- **Change 9** — browser QA not yet run (needs a live GUI check); defer to after publish/replace.
- **Packaging** — `prepare` was only `tsdown`, which wiped the `.d.ts` emitted by
  `tsc -p tsconfig.types.json` during `npm pack`; the published tarball had **no TypeScript
  types**. Fixed `prepare` to `pnpm run build`; `npm pack --dry-run` now lists all 15 files
  including `lib/**/*.d.ts`. ✓

Remaining for the user:
1. Bump to 0.5.0, publish, replace in the `web` profile, restart.
2. In the live GUI: verify the card renders, no purple, primary gate works, Store autosaves,
   filled dots appear, no all-green bug, no phantom "1 key". (Change 9.)
