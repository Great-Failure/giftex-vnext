---
applyTo: '.copilot-tracking/changes/2026-06-30/frontend-v2-wiring-and-notifications-changes.md'
---
<!-- markdownlint-disable-file -->
# Implementation Plan: Frontend v2 Wiring + Lifecycle Notifications

> **Closes:** #8 (URL routing) · #9 (invite/RSVP UI) · #10 (wishlist UI) · #11 (exchange creation/publishing UI) · #12 (lifecycle email notifications)
> **Strategy:** one-big-PR (all 5 issues, ~8 phases)
> **Coexistence:** v2 lives at NEW URLs (`/x/*`, `/rsvp/*`, `/u/*`); v1 view-state navigation UNCHANGED

## Overview

Wire the v2 API shipped in PR #28 to a new React-Router-v6 frontend coexisting with the v1 view-state navigation, and replace the inline Phase 1 email helpers with a bilingual idempotent notification system using a global-token unsubscribe.

## Objectives

### User Requirements

* URL-based routing using React Router v6 — Source: GitHub issue #8 + User decision (`router=react-router-v6`)
* Invite + RSVP UI: organizer adds emails, triggers sends, resends; participant RSVPs via email link — Source: GitHub issue #9
* Wishlist UI: multi-item CRUD; editable until `matched`; giver views recipient post-reveal — Source: GitHub issue #10
* Exchange creation + publishing UI: name, description, dates, budget; draft editable; publish with confirmation — Source: GitHub issue #11
* Lifecycle emails: 5 types (InviteSent, RSVPAccepted, WishlistReminder, MatchReveal, GiftByReminder) with idempotency + unsubscribe — Source: GitHub issue #12
* v1 frontend coexistence: v2 under new URLs; v1 unchanged — Source: User decision (`coexistence=coexist`)
* One big PR for all 5 issues — Source: User decision (`prStrategy=one-big-pr`)
* Bilingual emails day 1 (en + es) — Source: User decision (`emailLocalization=bilingual-day-one`)
* Global-token unsubscribe (reminders suppressed; invites + reveal always send) — Source: User decision (`unsubscribe=global-token`)

### Derived Objectives

* ADR-001 Phase 1 alignment: 3–50 participant bounds, single `custom` exchange type, NO address fields, RSVP requires only `displayName`, optional profile prompts (avatar/interests/sizes/pronouns/allergens), no template picker — Derived from: ADR-001 alignment sections in issues #9 #10 #11
* Reuse the existing `exchanges` Cosmos container for `NotificationEvent` + `Unsubscribe` records (avoid net-new container, avoid Bicep change) — Derived from: minimize infra friction; PR #27 already provisioned `exchanges`
* E2E test coverage parity with PR #28; backend coverage floor stays at 53% — Derived from: maintain existing quality gate
* No new frontend unit-test framework — use Playwright E2E (existing pattern) — Derived from: only-Playwright tests in this repo

## Context Summary

### Project Files

* src/App.tsx - View-state nav root; wraps in `<BrowserRouter>`; v1 routes preserved via catchall fallback — verified Lines 1-80
* src/components/*.tsx - 18 v1 view components (5,800 LOC) — DO NOT MODIFY in this PR (coexist decision)
* src/lib/translations.ts - i18n key registry — extended with ~50 new keys (es + en, en first per existing convention)
* src/lib/v2/types.ts - v2 entity mirror — needs sync check vs api copy
* api/src/shared/v2/email.ts - 3 minimal Phase 1 helpers — deprecated by new `notifications.ts` module
* api/src/shared/v2/types.ts - `NotificationEvent` already defined (Line 218+); `NotificationType` enum already includes `giftByReminder`, `inviteSent`, `rsvpAccepted`, `wishlistReminder`, `matchReveal`
* api/src/shared/v2/cosmosdb.ts - 10 helpers from PR #28; adds 3 notification helpers + 2 unsubscribe helpers
* api/src/shared/email-service.ts - underlying ACS `sendEmail` wrapper — unchanged
* infra/main.bicep - NO infra changes in this PR (reuse existing `exchanges` container)

### References

* .copilot-tracking/research/subagents/2026-06-30/v2-frontend-wiring-research.md - v2 API contract, v1 nav, i18n conventions, email gap analysis (Lines 1-416)
* docs/data-model-v2.md - v2 schema spec
* docs/api-reference.md - v1+v2 endpoint reference
* GitHub issues #8 #9 #10 #11 #12 — acceptance criteria source of truth

### Standards References

* .github/copilot-instructions.md - project conventions (Azure Functions v4, Cosmos partitioning, i18n via `useLanguage`)
* ADR-001 (linked from issues #9 #10 #11) - Phase 1 product decisions

## Implementation Checklist

### [ ] Phase 1: Foundation

<!-- parallelizable: false -->

* [ ] Step 1.1: Install `react-router-dom@^6.27.0` (root package.json) + types
  * Details: .copilot-tracking/details/2026-06-30/frontend-v2-wiring-and-notifications-details.md (Step 1.1)
* [ ] Step 1.2: **Verify** existing `staticwebapp.config.json` SPA fallback (no edit expected — already configured for `/index.html` rewrite with asset exclusions + 404→index.html responseOverride)
  * Details: .copilot-tracking/details/2026-06-30/frontend-v2-wiring-and-notifications-details.md (Step 1.2)
* [ ] Step 1.3: Create `src/lib/v2/api.ts` — typed fetch client for all 17 v2 endpoints
  * Details: .copilot-tracking/details/2026-06-30/frontend-v2-wiring-and-notifications-details.md (Step 1.3)
* [ ] Step 1.4: Create `src/lib/v2/auth.ts` — organizer + invite token handling (sessionStorage + URL params)
  * Details: .copilot-tracking/details/2026-06-30/frontend-v2-wiring-and-notifications-details.md (Step 1.4)
* [ ] Step 1.5: Wrap App.tsx in `<BrowserRouter>` with v2 `<Routes>` + v1 catchall fallback
  * Details: .copilot-tracking/details/2026-06-30/frontend-v2-wiring-and-notifications-details.md (Step 1.5)
* [ ] Step 1.6: Add ~70-80 v2 i18n keys to **all 9 existing language files** (`src/lib/translations/{en,es,pt,fr,it,ja,zh,de,nl}.ts`) using flat camelCase convention. Author en + es fully; stub the other 7 with en text + `// TODO(i18n)` markers (covers user `bilingual-day-one` decision; full localization for 7 languages tracked as follow-up)
  * Details: .copilot-tracking/details/2026-06-30/frontend-v2-wiring-and-notifications-details.md (Step 1.6)
* [ ] Step 1.7: Add `UNSUBSCRIBE_HMAC_SECRET` as a **secure Bicep parameter** (not `uniqueString()`) — pass at deploy via `--parameters unsubscribeHmacSecret=$(openssl rand -hex 32)` or Key Vault reference; document rotation procedure in deployment.md
  * Details: .copilot-tracking/details/2026-06-30/frontend-v2-wiring-and-notifications-details.md (Step 1.7)
* [ ] Step 1.7b: Add `timezone` field to `Exchange` API type + `createExchange`/`patchExchange` handlers (IANA string, default `'UTC'`) — required because issue #11 captures timezone but shipped API has no such field
  * Details: .copilot-tracking/details/2026-06-30/frontend-v2-wiring-and-notifications-details.md (Step 1.7b)
* [ ] Step 1.8: Run `npm run lint && npm run build` — confirm clean

### [ ] Phase 2A: #8 URL routing skeleton

<!-- parallelizable: true -->

* [ ] Step 2A.1: Define route constants in `src/lib/v2/routes.ts`
  * Details: .copilot-tracking/details/2026-06-30/frontend-v2-wiring-and-notifications-details.md (Step 2A.1)
* [ ] Step 2A.2: Create `src/components/v2/V2Layout.tsx` — header/footer/language toggle wrapper
  * Details: .copilot-tracking/details/2026-06-30/frontend-v2-wiring-and-notifications-details.md (Step 2A.2)
* [ ] Step 2A.3: Create placeholder route components for all 7 v2 routes
  * Details: .copilot-tracking/details/2026-06-30/frontend-v2-wiring-and-notifications-details.md (Step 2A.3)
* [ ] Step 2A.4: Wire `<Routes>` block in App.tsx with all v2 paths
  * Details: .copilot-tracking/details/2026-06-30/frontend-v2-wiring-and-notifications-details.md (Step 2A.4)
* [ ] Step 2A.5: Playwright test — each v2 route returns 200 (placeholder renders)

### [ ] Phase 2B: #12 Notification infrastructure (backend)

<!-- parallelizable: true -->

* [ ] Step 2B.1: Create `api/src/shared/v2/notifications.ts` — **race-safe** send wrapper: atomic upsert with deterministic id (`${type}:${exchangeId}:${sha256(email)}:${dateKey}`); catches Cosmos 409 conflict as `duplicate` signal; only sends email AFTER successful reservation
  * Details: .copilot-tracking/details/2026-06-30/frontend-v2-wiring-and-notifications-details.md (Step 2B.1)
* [ ] Step 2B.2: Add 5 cosmos helpers in `cosmosdb.ts` (NotificationEvent partitioned by `/exchangeId`; unsubscribes by special PK `_global`); extend `NotificationStatus` type to include `'skipped'`
  * Details: .copilot-tracking/details/2026-06-30/frontend-v2-wiring-and-notifications-details.md (Step 2B.2)
* [ ] Step 2B.3: Create bilingual template registry `api/src/shared/v2/templates/` (en + es × 5 types)
  * Details: .copilot-tracking/details/2026-06-30/frontend-v2-wiring-and-notifications-details.md (Step 2B.3)
* [ ] Step 2B.4: Create `POST /api/v2/unsubscribe/{token}` endpoint
  * Details: .copilot-tracking/details/2026-06-30/frontend-v2-wiring-and-notifications-details.md (Step 2B.4)
* [ ] Step 2B.5: Mint/verify unsubscribe tokens (HMAC-SHA256 of recipient email + server secret)
  * Details: .copilot-tracking/details/2026-06-30/frontend-v2-wiring-and-notifications-details.md (Step 2B.5)
* [ ] Step 2B.6: Unit tests — idempotency, token verify, template rendering, unsubscribe suppression (~12 tests)

### [ ] Phase 3: #11 Exchange creation + publishing UI

<!-- parallelizable: false -->

* [ ] Step 3.1: Build `CreateExchangeView` — comprehensive form per **issue #11 + ADR-001**: name, description, **timezone (IANA, defaults to browser TZ)**, **rsvpDeadline + wishlistDeadline + revealAt (datetime-local, all cross-field validated)**, **exchangeDate (YYYY-MM-DD — matches actual API field, NOT `eventDate`)**, exchangeTime, budget, maxParticipants (3-50). HIDDEN: `exchangeType='custom'` per ADR-001. NEGATIVE: no address fields
  * Details: .copilot-tracking/details/2026-06-30/frontend-v2-wiring-and-notifications-details.md (Step 3.1)
* [ ] Step 3.2: Build `ExchangeDashboardView` — organizer's main page; status badge + edit + publish + section anchors
  * Details: .copilot-tracking/details/2026-06-30/frontend-v2-wiring-and-notifications-details.md (Step 3.2)
* [ ] Step 3.3: Build `PublishExchangeDialog` — confirmation modal with validation summary
  * Details: .copilot-tracking/details/2026-06-30/frontend-v2-wiring-and-notifications-details.md (Step 3.3)
* [ ] Step 3.4: Wire to `POST /api/v2/exchanges`, `PATCH /{id}`, `POST /publish`
* [ ] Step 3.5: Organizer-token one-time display + sessionStorage capture flow
  * Details: .copilot-tracking/details/2026-06-30/frontend-v2-wiring-and-notifications-details.md (Step 3.5)
* [ ] Step 3.6: ADR-001 form constraints: min=3, max=50, single `type='custom'` (hidden field), no address fields
* [ ] Step 3.7: Build `ParticipantsPanel` in `ExchangeDashboardView` — table of invites + accepted participants with columns: name, email, RSVP status, **wishlist item count + completion badge** (resolves #10 acceptance criterion "wishlist completion status visible to organizer")
  * Details: .copilot-tracking/details/2026-06-30/frontend-v2-wiring-and-notifications-details.md (Step 3.7)
* [ ] Step 3.8: Playwright test — create → publish happy path with all date fields

### [ ] Phase 4: #9 Invite + RSVP UI

<!-- parallelizable: false -->

* [ ] Step 4.1: Build `InvitePanel` — embedded in dashboard; multi-email input, batch send, list with status, resend. **Status gating**: invite controls enabled in `draft|published|matching`; READ-ONLY in `matched|completed|cancelled` (per issue #9 "add participants until matching"). Client-side cap warning at 50 BEFORE API rejects
  * Details: .copilot-tracking/details/2026-06-30/frontend-v2-wiring-and-notifications-details.md (Step 4.1)
* [ ] Step 4.2: Build `RsvpView` — reads invite token from URL `?t=`, fetches exchange context, accept/decline buttons
  * Details: .copilot-tracking/details/2026-06-30/frontend-v2-wiring-and-notifications-details.md (Step 4.2)
* [ ] Step 4.3: Wire to `POST /invites` (batch), `POST /invites/{id}/resend`, `GET /invites/me`, `POST /invites/me/accept`, `POST /invites/me/decline`
* [ ] Step 4.4: ADR-001: cap maxParticipants at 50 in UI; require only `displayName` on RSVP; optional profile prompts shown collapsed
* [ ] Step 4.5: Playwright test — invite → accept → list shows new participant

### [ ] Phase 5: #10 Wishlist UI

<!-- parallelizable: false -->

* [ ] Step 5.1: Build `WishlistView` (self) — list + add/edit/delete forms; lock view when `exchange.status === 'matched'`. Item shape per API: `title`, `url?`, `notes?`, `priority: 'high' | 'medium' | 'low'` (string enum, NOT 1-5 number — aligned to `WishlistPriority` in api/src/shared/v2/types.ts)
  * Details: .copilot-tracking/details/2026-06-30/frontend-v2-wiring-and-notifications-details.md (Step 5.1)
* [ ] Step 5.2: Build `GiverWishlistView` — post-reveal view of assigned recipient's wishlist (auth via participant token + match)
  * Details: .copilot-tracking/details/2026-06-30/frontend-v2-wiring-and-notifications-details.md (Step 5.2)
* [ ] Step 5.3: Wire to all 5 wishlist endpoints
* [ ] Step 5.4: Empty + locked state messaging; ADR-001 — no address field
* [ ] Step 5.5: Playwright test — add item → match → giver sees it; cannot edit after match

### [ ] Phase 6: #12 Lifecycle email triggers wired

<!-- parallelizable: false -->

* [ ] Step 6.1: Replace inline `sendInviteSentEmail` in `invites.ts` with `sendNotification({ type: 'inviteSent', ... })`
  * Details: .copilot-tracking/details/2026-06-30/frontend-v2-wiring-and-notifications-details.md (Step 6.1)
* [ ] Step 6.2: Add `RSVPAccepted` trigger in `rsvp.ts` accept handler (organizer is recipient)
* [ ] Step 6.3: Add `WishlistReminder` timer cron (`0 0 9 * * *` daily, exchange-tz aware) — fires N-2 days before `wishlistDeadline` for participants with empty wishlists
  * Details: .copilot-tracking/details/2026-06-30/frontend-v2-wiring-and-notifications-details.md (Step 6.3)
* [ ] Step 6.4: Replace inline `MatchReveal` HTML with template lookup
* [ ] Step 6.5: Add `GiftByReminder` timer — fires 24h before `eventDate` for ALL participants
  * Details: .copilot-tracking/details/2026-06-30/frontend-v2-wiring-and-notifications-details.md (Step 6.5)
* [ ] Step 6.6: Add unsubscribe footer link to reminder templates only (invite + reveal SKIP — critical transactional)
* [ ] Step 6.7: Integration tests — idempotent send on retry, suppression of unsubscribed recipients (~8 tests)

### [ ] Phase 7: Full E2E coverage

<!-- parallelizable: false -->

* [ ] Step 7.1: New `e2e/v2-full-flow.spec.ts` — exercises full lifecycle through the new UI
* [ ] Step 7.2: New `e2e/v2-unsubscribe.spec.ts` — visits unsubscribe URL, asserts (1) unsubscribe page renders success, (2) subsequent `wishlistReminder` send call returns `{ skipped: 'unsubscribed' }` (via direct API call assertion + NotificationEvent record with `status='skipped'` since 2B.2 added that status)

### [ ] Phase 8: Validation + Deploy

<!-- parallelizable: false -->

* [ ] Step 8.1: Full validation: `npm run lint`, `npm run build`, `cd api && npm test`, `npm run test:e2e`
* [ ] Step 8.2: Coverage check — ensure backend stays >= 53% statements/lines
* [ ] Step 8.3: Manual smoke against local emulator (`docker-compose up -d` + F5 debug)
* [ ] Step 8.4: Deploy to QA via `./scripts/deploy-app-to-swa.sh qa`
* [ ] Step 8.5: Live smoke against QA URL using curl harness from PR #28 — verify v2 endpoints + v1 endpoints both green
* [ ] Step 8.6: Open PR with detailed body (issues closed, ADR-001 compliance map, endpoint table)
* [ ] Step 8.7: If validation surfaces large refactors, file follow-up issues — DO NOT scope-creep this PR

## Planning Log

See .copilot-tracking/plans/logs/2026-06-30/frontend-v2-wiring-and-notifications-log.md for discrepancy tracking, implementation paths considered, and suggested follow-on work.

## Dependencies

* react-router-dom@^6.27.0 — to install in Phase 1.1
* PR #28 (v2 API) — already merged + deployed to QA ✅
* PR #27 (`exchanges` Cosmos container) — already merged + deployed to QA ✅
* ACS Email — configured in QA ✅
* Existing translations.ts pattern — extended, not replaced

## Success Criteria

* All 8 phases complete with green CI — Traces to: User requirement (one-big-pr)
* E2E test exercises full v2 flow (create → publish → invite → 3× RSVP → wishlist → match → reveal → complete → unsubscribe) — Traces to: issues #8 #9 #10 #11 #12 acceptance criteria
* 5 lifecycle emails fire bilingually with NotificationEvent idempotency tracking — Traces to: issue #12
* Unsubscribe global token suppresses ONLY reminders (invite + reveal always send) — Traces to: User decision + issue #12
* ADR-001 Phase 1 UI constraints enforced: 3-50 cap, single `custom` type, no address fields, displayName-only RSVP — Traces to: ADR-001 callouts in issues #9 #10 #11
* v1 view-state nav still functional in browser (manual smoke) — Traces to: User decision (coexist)
* Backend coverage stays >= 53% statements/lines — Traces to: existing quality gate
