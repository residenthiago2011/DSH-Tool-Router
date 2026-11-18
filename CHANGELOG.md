# Changelog

All notable changes to `@residenthiago/dsh-tool-router` are documented here:
**what** changed, **why** it changed, and **what it fixes** / what to check
after upgrading. Releases follow this file — see `RELEASING.md` for the
commit/publish gate.

## [Unreleased]

_(nothing staged for a release yet — future changes land here first)_

---

## [1.3.1] — 2026-11-18 — "the no-prefill mask stays in its preset"

### Fixed

1. **Standard sessions lost 13 tools — including `find_tool` — to the No
   Prefill tool-hiding mask.**
   - *Why it happened:* three adopt call sites (boot-adopt, the `find_tool`
     self-heal and the `agent/pre-step` self-heal) called `adopt()` without
     asking which preset the agent was running. Any live agent present at
     router mount, or any session that had passed through `no-prefill`, was
     masked while running `standard`: 20 tools instead of 33 and no discovery
     path at all.
   - *Fix:* `adopt()` now resolves the composed preset through the registry's
     `composedPreset()` predicate with a session-cache fallback, and refuses
     to mask an agent that is not `no-prefill`. The skip is logged.
   - *Verify after upgrading:* a Standard session shows 33 tools in
     `request/header`, `tool-router.log` contains
     `adopt skipped ... preset=standard is not no-prefill`, and no step ends
     with `unknown tool`.

2. **The mask survived a switch away from No Prefill.**
   - *Why it happened:* the deny layer is keyed to the agent scope and was only
     lifted at agent disposal or plugin teardown. There was no
     `agent-preset/selected` listener, so a session that opened as No Prefill
     (the profile's `selectedDefault`) and was then switched to Standard kept
     the mask forever.
   - *Fix:* subscribe to `agent-preset/selected` (and its `session/event`
     form) and release the deny layer on any switch to another preset. Disposal
     and teardown now share the same `release()` helper.
   - *Verify after upgrading:* switching a No Prefill session to Standard
     restores 33 tools and logs
     `released mask for ... (preset switched to standard)`.

### Changed

- Stage-0 ranking and Stage-1 request-body construction now live in
  `plugin/decision.js`, imported by `index.js`. Default request bodies stay
  byte-identical to 1.3.0, guarded by `test/legacy-bodies-test.mjs`.
- `tool-registry.json` criteria now carry explicit "Not for … (use X)"
  disambiguation (`read`/`grep`/`read_image`, `write`/`edit`, `bash`/`pwsh`,
  `web_search`/`web_fetch`, …) so the small decision model can separate
  overlapping tools.

### Tests

- New `test/preset-gate-test.mjs` covers boot-adopt, `agent/created`, the
  session-cache fallback, both preset-switch event forms, and the legacy
  no-host-API path. Verified on the Moto G8 with its bundled Node v24 runtime
  against the deployed package, then through a live DSH restart.

---

## [1.3.0] — 2026-11-04 — "never arm a mask mid-step"

The consistency release: the request a step sends and the view dispatch
enforces can no longer disagree, and a live agent is masked at mount instead
of at its first step boundary.

### Fixed

1. **First request advertised tools the registry already denied**
   (`Error: unknown tool "…"`) — incident session `f631c7b5`, 2026-11-04.
   - *Why it happened:* the host snapshots the step's tool schemas
     (`systemPrompt.assemble(...)`) **before** it runs `agent/pre-step`
     (`dsh-agent-loop` `preStep()`), while tool execution resolves names
     against the restricted view at call time. When the first mask for an agent
     was armed from the pre-step self-heal, that write landed after the
     snapshot but before dispatch: step 1's `request/header` listed all 12
     tools (`reason: initial`) against an already-restricted registry, so the
     model's first action died with `unknown tool "working_directory"` and a
     wasted step; the correct `[find_tool]`-only header only appeared from
     step 2 (`reason: change` + tool-removal delta).
   - *Fix:* deny-set **additions** (hides) may only be written at a host
     boundary that precedes the next `assemble()` — `turn/start`, `step/end`,
     or `turn/end`. An arm requested while its turn is open is parked
     (`deferring hide of N tool(s) … to the next boundary`) and flushed at the
     boundary instead of arming mid-step, so advertised = callable for that
     one step. Reveals (deny-set removals) still apply immediately because
     they only widen visibility.
   - *Verify after upgrading:* the first turn of a resumed session shows
     `request/header` with only `find_tool` from `reason: initial`, and no
     `unknown tool` step anywhere in the turn.

2. **`agent/created` missed when the host resumes the session before the
   bundle applies** (boot-order race; the trigger for incident
   `f631c7b5` above — the plugin only found the agent at its first
   `agent/pre-step`).
   - *Fix:* `apply()` now scans `ctx.get('agents').list()` at mount and
     adopts every live agent there, logging
     `boot-adopt: N/M pre-existing agent(s) masked at mount`. Both boot
     orders are now covered: agent-then-plugin → the scan; plugin-then-agent
     → `agent/created`.
   - *Verify after upgrading:* the boot log contains either
     `boot-adopt: N/M … masked at mount` (N > 0) or an
     `agent/created … MASK ARMED` line **before** any traffic in the session.

3. **A tool called during the one un-masked step could be re-hidden when the
   parked arm landed**, restarting the `unknown tool` → `find_tool` →
   full-context retry loop (the same class that burned 419,672 input tokens
   in the 2026-10-28 incident, 98.9% of that turn).
   - *Fix:* `revealed` is now re-seeded from the session log on **every**
     `recompute()`, not only at adoption. `seedRevealed(agent, into)` unions
     the log's `tool/call` names into the live set, so anything the model
     actually used during the window stays visible when the mask closes.
   - *Verify:* after the boundary arm, `armed mask hiding N tool(s);
     revealed=K` counts K ≥ tools used in that step, and the model never gets
     `unknown tool` for a tool it just called.

4. **Arm-retry pump churned on a parked write.** A deferred (parked) arm used
   to re-trigger the 500 ms retry loop, logging the same defer 20 times and
   finally reporting a healthy plugin as `gave up arming mask`.
   - *Fix:* `retryUnlessDeferred()` skips the pump while a write is parked;
     the boundary flush owns it. `adopt()` now reports
     `DEFERRED to boundary` instead of `PENDING` for that state.

5. **Record leak for disposed agents.** An agent removed by the host left its
   bookkeeping record (and a stale restriction disposer) behind, blocking a
   re-adopt of its successor.
   - *Fix:* new `agent/disposed` subscription drops the record, releases the
     restriction, and logs `disposed <id> (mask released)`.

### Changed

- Subscriptions are now four events — `agent/created`, `agent/pre-step`,
  `session/event` (boundaries only, read-only), `agent/disposed` — and still
  **never** `tools/change` (the two host-killing feedback loops of
  2026-10-26 / 2026-10-28). The mount log line was updated accordingly.
- `session/event` is used only for `turn/start`, `step/end`, `turn/end`; it is
  the boundary family measured relative to `assemble()`:
  `turn/start` appends before `preStep()` assembles, `step/end` appends after
  every dispatch of the step, `turn/end` appends in the turn's `finally`.
- Module header documents the boundary rule and the `f631c7b5` incident.

### Tests / Docs

- New suite `plugin/test/midstep-defer-test.mjs` (19 assertions): mount-time
  adoption before `assemble()`, park-vs-arm inside an open turn, seed-during-
  the-window, immediate reveals, `agent/disposed` cleanup. `npm test` now runs
  five endpoint-free suites (all `ALL_PASS`).
- READMEs: incident write-up ("Arm between steps, never mid-step"), updated
  test catalog, install URLs bumped to the `v1.3.0` release tarball.

## [1.2.0] — 2026-11-03 — plugins-panel release

- **feat** plugins panel metadata — `locale/en.json` + `locale/zh.json`
  ("Tool Router" title/description), `icon.svg`, matching `exports` entries.
  *Why:* cards rendered as the bare package name (`readPluginMeta` falls back
  to `package.json` when no locale file exists). Now the plugin appears as a
  proper **Tool Router** card with icon under the Personal group.
- **chore(release)** package renamed to `@residenthiago/dsh-tool-router`.
  *Why:* scope migration across the three personal DSH plugins. **Breaking
  for installs** (dependency key / bundle entry / bundle-patch `name` change);
  row-id and behavior unchanged.
- **refactor** package moved to `plugin/`, tests to `plugin/test/`.
- **ci** GitHub Actions release workflow: `npm test` (non-fatal) →
  `npm pack` → `SHA256SUMS.txt` → GitHub Release with a ready-to-paste panel
  install URL. *Why:* releases must be reproducible from the tag; CI-built
  tarballs are the canonical (LF) artifacts.
- **docs** rebrand + install-from-release instructions.
  (Also includes PR #1/#2 line: see 1.1.1 for the behavior changes.)

## [1.1.1] — 2026-10-31

- **fix** `tools.restrict()` rejects deny lists containing names unknown to
  the GLOBAL registry (agent-scoped tools like `send_message`). The failure
  aborted arming entirely — 20 retries, `gave up arming mask`, every schema
  left in prefill (measured `toolsTokens = 5837`).
  *Fix:* reconcile the deny set against the admission list the rejection
  reports and memoise it per exact surface.
- **fix** reconcile moved from `tools/change` to the `agent/pre-step` step
  boundary (PR #2). *Why:* `restrict()`/`register()` publish `tools/change`
  synchronously; two plugins reacting to it formed a feedback loop that killed
  the host twice (2026-10-26: log grew to 130.5 MB; 2026-10-28: `crash-*-host.log`).
- **fix** `revealed` seeded from the session log using **`session.events`** —
  the property `@deepseek-ai/dsh-session` actually exposes. *Why:* the earlier
  `snapshotEvents()/ownEvents()` calls matched no installed build, so the seed
  silently returned `[]` while the stub-invented API passed its test; on a
  restart the model re-called hidden tools and burned 419,672 input tokens.
- **tests** `restrict-scope-test.mjs` (admission self-heal, empty-deny guard)
  and `router-storm-test.mjs` (no `tools/change` listener, 200 foreign events →
  0 restricts, log-seeded reveal, `already_available`).

## [1.1.0] — 2026-10-17 — "find_tool misses" release

- **fix** misses: **full-surface send** (every mounted tool carries a 160-char
  criterion, capped at 24), **confidence-only acceptance gate** (`CONF_MIN
  0.70`, `usable`/noul demoted to telemetry — it pinned `pNone=0.841` even on
  certain matches), and **recovery paths** (shortlist + exact-name retry hint,
  exact-name fast path, empty-request catalog hint).
  *Why:* tighter budgets and the noul gate were bouncing correct matches
  (measured matched conf 0.72–1.00 vs unmatched ≤0.71).
- **rebrand** DSH Tool Router; endpoint documented as a decision-model API.
- **docs** measured `Why?` section: 6,559 vs 283 prefill tokens (23×).

## [1.0.0] — 2026-10-08

- Initial release with the prebuilt tarball linked from the install docs
  (original upstream history).

---

[Unreleased]: https://github.com/residenthiago2011/DSH-Tool-Router/compare/v1.3.0...HEAD
[1.3.0]: https://github.com/residenthiago2011/DSH-Tool-Router/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/residenthiago2011/DSH-Tool-Router/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/residenthiago2011/DSH-Tool-Router/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/residenthiago2011/DSH-Tool-Router/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/residenthiago2011/DSH-Tool-Router/releases/tag/v1.0.0