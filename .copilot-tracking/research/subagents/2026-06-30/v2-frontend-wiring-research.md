<!-- markdownlint-disable-file -->
# v2 Frontend Wiring Research
> Generated: 2026-06-30 · Repo: Great-Failure/giftex-vnext
> Scope: Issues #8 (routing), #9 (RSVP UI), #10 (wishlist UI), #11 (exchange UI), #12 (lifecycle emails)

---

## 1. v2 API Surface (HTTP Contract)

All routes are prefixed `/api/`. Auth is token-in-query OR token-in-header (no cookies, no SWA EasyAuth).
- Organizer: `?organizerToken=<id>.<secret>` or header `x-organizer-token`
- Participant: `?inviteToken=<exchangeId>.<secret>` or header `x-invite-token`

Reference: `api/src/shared/v2/auth.ts (Lines 95-115)`, `api/src/shared/v2/http.ts (Lines 1-75)`

### Exchange CRUD

| Method | Route | Auth | Key Request Fields | Key Response Fields | Status Codes |
|--------|-------|------|--------------------|---------------------|--------------|
| POST | `v2/exchanges` | Public | `name*`, `exchangeDate*` (YYYY-MM-DD), `organizerEmail?`, `organizerLanguage?`, `budget?{currency,amountMin,amountMax}`, `maxParticipants?` (3–50), `revealAt?` (ISO8601), `description?`, `location?`, `rsvpDeadline?`, `wishlistDeadline?` | `{ exchange, organizerToken }` (`organizerTokenHash` stripped) | 201, 400, 500 |
| GET | `v2/exchanges/{exchangeId}` | Organizer | — | `{ exchange, counts:{invites,acceptedInvites,participants,wishlistItems,matches} }` | 200, 401, 403, 500 |
| GET | `v2/exchanges/by-code/{code}` | Public | — | `{ id, code, name, status, exchangeDate }` (minimal — no token fields) | 200, 400, 404, 500 |
| PATCH | `v2/exchanges/{exchangeId}` | Organizer | Any subset of mutable Exchange fields (immutable: id, code, status, organizerTokenHash) | `{ exchange }` | 200, 400, 401, 403, 409, 500 |
| POST | `v2/exchanges/{exchangeId}/publish` | Organizer | — | `{ exchange }` | 200, 401, 403, 409, 500 |
| POST | `v2/exchanges/{exchangeId}/cancel` | Organizer | — | `{ exchange }` | 200, 401, 403, 409, 500 |
| POST | `v2/exchanges/by-email/recover` | Public | `{ email?, language? }` | `{ ok: true }` (always 202, never discloses existence) | 202, 429, 500 |

Sources: `api/src/functions/v2/createExchange.ts`, `getExchange.ts`, `getExchangeByCode.ts`, `patchExchange.ts`, `publishExchange.ts`, `cancelExchange.ts`, `recoverOrganizerLink.ts`

### Invite Admin

| Method | Route | Auth | Key Request Fields | Key Response Fields | Status Codes |
|--------|-------|------|--------------------|---------------------|--------------|
| POST | `v2/exchanges/{exchangeId}/invites` | Organizer | `{ invites: [{email*, suggestedName?, preferredLanguage?}] }` | `{ invites[], tokens:{[inviteId]: rawToken} }` | 201, 400, 401, 403, 409, 500 |
| GET | `v2/exchanges/{exchangeId}/invites` | Organizer | — | `{ invites[] }` (`inviteTokenHash` stripped) | 200, 401, 403, 500 |
| POST | `v2/exchanges/{exchangeId}/invites/{inviteId}/resend` | Organizer | — | `{ invite, token }` (token rotated) | 200, 401, 403, 404, 409, 500 |
| POST | `v2/exchanges/{exchangeId}/invites/{inviteId}/approve` | Organizer | — | `{ invite }` | 200, 401, 403, 404, 409, 500 |

Source: `api/src/functions/v2/invites.ts`, `inviteAdmin.ts`

### RSVP (Participant)

| Method | Route | Auth | Key Request Fields | Key Response Fields | Status Codes |
|--------|-------|------|--------------------|---------------------|--------------|
| GET | `v2/invites/me` | Participant | — | `{ invite, exchange:{id,code,name,description,exchangeDate,exchangeTime,location,generalNotes,budget,status,rsvpDeadline,wishlistDeadline}, participantId? }` | 200, 401, 403, 500 |
| POST | `v2/invites/me/accept` | Participant | `{ displayName*, preferredLanguage?, profile? }` | `{ participant, invite }` | 200, 400, 401, 403, 409, 500 |
| POST | `v2/invites/me/decline` | Participant | — | `{ invite }` | 200, 401, 403, 409, 500 |

Source: `api/src/functions/v2/rsvp.ts`

### Wishlist

| Method | Route | Auth | Key Request Fields | Key Response Fields | Status Codes |
|--------|-------|------|--------------------|---------------------|--------------|
| POST | `v2/participants/me/wishlist` | Participant | `{ title*, url?, notes?, priority?: 'high'\|'medium'\|'low' }` | `{ item }` | 201, 400, 401, 403, 409, 500 |
| GET | `v2/participants/me/wishlist` | Participant | — | `{ items[] }` | 200, 401, 403, 500 |
| PATCH | `v2/wishlist/{itemId}` | Participant (owner) | `{ title?, url?: string\|null, notes?: string\|null, priority? }` | `{ item }` | 200, 400, 401, 403, 404, 409, 500 |
| DELETE | `v2/wishlist/{itemId}` | Participant (owner) | — | _(empty body)_ | 204, 401, 403, 409, 500 |
| GET | `v2/exchanges/{exchangeId}/participants/{participantId}/wishlist` | Organizer or revealed-Participant | — | `{ participant:{id,displayName,profile}, items[] }` | 200, 401, 403, 404, 500 |

Source: `api/src/functions/v2/wishlist.ts`

### Matching & Lifecycle

| Method | Route | Auth | Key Request Fields | Key Response Fields | Status Codes |
|--------|-------|------|--------------------|---------------------|--------------|
| POST | `v2/exchanges/{exchangeId}/match` | Organizer | — | `{ exchange, matches[] }` | 200, 400, 401, 403, 409, 500 |
| POST | `v2/exchanges/{exchangeId}/rematch` | Organizer | — | `{ matches[] }` (pre-reveal only) | 200, 401, 403, 409, 500 |
| POST | `v2/exchanges/{exchangeId}/complete` | Organizer | — | `{ exchange }` | 200, 401, 403, 409, 500 |
| GET | `v2/matches/me` | Participant | — | Pre-reveal: `{revealStatus:'pending',revealAt}`; Post: `{revealStatus:'revealed',revealedAt,match,receiver:{id,displayName,profile},wishlist[]}` | 200, 401, 403, 404, 409, 500 |

**Timer trigger** (not HTTP): `v2RevealMatches` runs every 15 min, finds `status=matched` exchanges with `revealAt <= now`, sends reveal emails, marks matches `revealed`.
Source: `api/src/functions/v2/match.ts`, `matchesMe.ts`, `revealMatches.ts`

### Identity

| Method | Route | Auth | Response |
|--------|-------|------|----------|
| GET | `v2/me` | Any | `{role, exchangeId?, principalId?, exchangeName?, tokenExpiresAt?, participantId?}` |

Source: `api/src/functions/v2/me.ts`

---

## 2. v2 Type Definitions — Drift Detection

**Result: Zero drift.** `src/lib/v2/types.ts` is an exact copy of `api/src/shared/v2/types.ts` as of the reviewed commit. Both files are 100% in sync — every exported entity, field, and constant matches character-for-character.

Sources: `api/src/shared/v2/types.ts`, `src/lib/v2/types.ts`

**Exported entities and key fields:**

| Entity | Key Fields |
|--------|-----------|
| `Exchange` | `id, exchangeId, entityType:'exchange', code(6-digit), exchangeType:'custom', status(6-state enum), name, exchangeDate(YYYY-MM-DD), organizerTokenHash, organizerEmail?, organizerLanguage?, budget?{currency,amountMin,amountMax}, maxParticipants?(3–50), revealAt?(ISO8601), publishedAt?, matchedAt?, cancelledAt?` |
| `Invite` | `id, exchangeId, entityType:'invite', inviteTokenHash, email, suggestedName?, preferredLanguage?, status('sent'\|'accepted'\|'declined'\|'expired'), sentAt, respondedAt?, requiresApproval?, approvedAt?, participantId?` |
| `Participant` | `id, exchangeId, entityType:'participant', inviteId, displayName, email, preferredLanguage?, profile?{avatarUrl?,pronouns?,interests?,sizes?,allergens?}, hasConfirmedAssignment?, joinedAt` |
| `WishlistItem` | `id, exchangeId, entityType:'wishlistItem', participantId, title, url?, notes?, priority('high'\|'medium'\|'low')` |
| `Match` | `id, exchangeId, entityType:'match', giverParticipantId, receiverParticipantId, revealStatus('pending'\|'revealed'), revealedAt?` |
| `NotificationEvent` | `id, exchangeId, entityType:'notificationEvent', type(5-value enum), recipientKind, recipientRefId, recipientEmail, status('queued'\|'sent'\|'failed'\|'bounced'), sentAt, providerMessageId?, failureReason?, idempotencyKey` |

`PARTICIPANT_BOUNDS = { min: 3, max: 50 }` exported from both files.

---

## 3. v1 Navigation Pattern & Router Coexistence

### v1 View State

`src/App.tsx (Lines 28-41)`:
```typescript
type View =
  | 'home' | 'create-game' | 'game-created' | 'select-participant'
  | 'assignment' | 'organizer-panel' | 'privacy' | 'game-not-found'
  | 'error' | 'organizer-guide' | 'participant-guide' | 'join-invitation'
```

**State shape** (`src/App.tsx Lines 63-73`):
```typescript
const [view, setView] = useState<View>('home')
const [games, setGames] = useLocalStorage<Record<string, Game>>('games', {})
const [currentGameCode, setCurrentGameCode] = useState<string>('')
const [currentParticipant, setCurrentParticipant] = useState<Participant | null>(null)
const [currentInvitationToken, setCurrentInvitationToken] = useState<string>('')
const [bannerType, setBannerType] = useState<BannerType>('none')   // 'none'|'api-unavailable'|'database-unavailable'
const [emailConfigured, setEmailConfigured] = useState(false)
const [errorType, setErrorType] = useState<ErrorType | null>(null)
const [isLoadingGame, setIsLoadingGame] = useState(false)
const [isCheckingApi, setIsCheckingApi] = useState(true)
```

**How `view` changes** (`src/App.tsx Lines 282-400`):
- `useEffect` on mount: reads `window.location.pathname` for `/privacy`, `/organizer-guide`, `/participant-guide`; reads `?code`, `?organizer`, `?participant`, `?invitation`, `?view` query params → calls `handleJoinGame()` or `handleOrganizerAccess()` → `setView()`
- `handleBack()` → `setView('home')` + `window.history.pushState({}, '', '/')`
- `handlePrivacy()` → `window.history.pushState({}, '', '/privacy')` + `setView('privacy')`
- Guide/create/join transitions → `setView()` + optional `window.history.pushState()`
- `popstate` listener restores view from URL on back/forward (`src/App.tsx Lines 339-380`)

**Already partially URL-driven**: `/privacy`, `/organizer-guide`, `/participant-guide` are matched by pathname. All others use `?view=` or `?code=` query params.

**Wrapping pattern** (`src/App.tsx Lines 497-530`):
```tsx
<LanguageProvider>
  <div className="min-h-screen flex flex-col">
    <StatusBanner bannerType={bannerType} isCheckingApi={isCheckingApi} />
    <div className="flex-1">
      {isLoadingGame && <LoadingView />}
      {!isLoadingGame && view === 'home' && <HomeView … />}
      {/* … other views … */}
    </div>
  </div>
</LanguageProvider>
```
`<Toaster>` (sonner) and analytics init also happen inside `App`. No `<ErrorBoundary>` wrapping `App` itself in `App.tsx` — `ErrorFallback.tsx` exists at `src/ErrorFallback.tsx` but is wired in `src/main.tsx`.

### Router Recommendation: BrowserRouter ✅

**Verdict: wrap in `<BrowserRouter>`, match v2 paths as `<Routes>` inside `App`, keep the existing `view` state block as a catch-all Route.**

Rationale:
1. **SWA already handles BrowserRouter** — `staticwebapp.config.json` has `navigationFallback: { rewrite: "/index.html", exclude: ["/api/*", "/*.{css,…}"] }` and a 404 → 200 rewrite. Deep-linking to `/exchange/*` will correctly land at `index.html`. No additional SWA config needed. `HashRouter` would break the existing `/privacy`, `/organizer-guide`, `/participant-guide` path routing that the app already relies on.
2. **v1 is untouched** — place `<Routes>` before the view-switch block; if no v2 route matches, the original `view` state logic handles rendering. The v1 `popstate` listener and `window.history.pushState` calls coexist cleanly — react-router-v6 `<BrowserRouter>` uses the History API internally and does not conflict.
3. **`react-router-dom` is not yet installed** — must be added as a dependency (`"react-router-dom": "^6"` in `package.json`). Currently absent from `package.json (Line 53-85)`.

**Proposed slot-in architecture:**
```tsx
// src/main.tsx
import { BrowserRouter } from 'react-router-dom'
<BrowserRouter><App /></BrowserRouter>

// src/App.tsx — inside existing <LanguageProvider><div>
<Routes>
  <Route path="/exchange/new"              element={<V2CreateExchangePage />} />
  <Route path="/exchange/:exchangeId/*"    element={<V2OrganizerPanel />} />
  <Route path="/rsvp"                      element={<V2RsvpPage />} />  {/* ?inviteToken= */}
  <Route path="/wishlist"                  element={<V2WishlistPage />} />
  <Route path="/match"                     element={<V2MatchRevealPage />} />
  <Route path="/*"                         element={<V1ViewSwitch />} />  {/* existing block */}
</Routes>
```
v1 URL parameters (`?code=`, `?organizer=`, `?participant=`, `?invitation=`) remain unchanged — v1 views only render at `/*`.

---

## 4. i18n / translations.ts Pattern

Source: `src/lib/translations/index.ts`, `src/components/LanguageProvider.tsx`, `src/lib/translations/en.ts`

**Adding a key:**
1. Add `myNewKey: "English text"` to `src/lib/translations/en.ts`
2. Add matching `myNewKey: "Texto en español"` to `es.ts` (and other language files)
3. TypeScript infers `TranslationKey = keyof typeof translations.en` automatically — no separate type edit needed (`src/lib/translations/index.ts Lines 15-16`)

**Interpolation pattern** — there is no built-in interpolation helper; string templates are used inline, e.g.:
```typescript
// en.ts
emailsSentToParticipants: "{count} emails sent to participants",
shareMessage: "Hi! Join our gift exchange \"{eventName}\". Click here: {link}",
```
Callers do manual replacement: `t('shareMessage').replace('{eventName}', name)`. No `{count, plural}` support. `src/lib/translations/en.ts (Lines 90-91)`.

**Required languages:** `en` (index order) + `es` day one per decision #4. Other 7 languages (`pt`, `fr`, `it`, `ja`, `zh`, `de`, `nl`) already scaffolded.

**Naming convention:** flat camelCase, no dots, no namespacing prefixes (e.g., `joinGameTitle`, `wishlistReminderSent`). `src/lib/translations/en.ts (Lines 1-476)`.

**Existing key count:** **476 keys** in `en.ts` (verified via grep count).

**Estimated new v2 keys needed:**

| Feature Area | Estimate |
|---|---|
| v2 home / empty exchange list | 10 |
| Exchange creation form (#11) | 20 |
| Publish / cancel / status badges | 8 |
| Invite list (organizer) + resend/approve | 12 |
| RSVP flow (#9): accept/decline, profile fields | 15 |
| Wishlist CRUD (#10): add/edit/delete/priority/empty/frozen | 15 |
| Match reveal page (#8): pending/revealed/receiver context | 10 |
| Error states (expired invite, cancelled exchange, late-join pending) | 10 |
| **Total (rounded)** | **~100** |

---

## 5. Email Service — Current State & Gap Analysis

### Current `sendEmail()` mechanics

`api/src/shared/email-service.ts (Lines 87-135)`:
- Uses `@azure/communication-email` `EmailClient.beginSend()` (long-poll)
- Returns `{ success: boolean, messageId?: string, error?: string }`
- Short-circuits with `{ success: false, error: 'Email service not configured' }` if `ACS_CONNECTION_STRING` or `ACS_SENDER_ADDRESS` are not set
- No language handling inside `sendEmail()` itself — language is handled by callers that build the subject/body

**Environment variables (from `api/src/shared/email-service.ts` + `api/local.settings.json.example`):**

| Var | Example | Notes |
|-----|---------|-------|
| `ACS_CONNECTION_STRING` | `""` | ACS connection string |
| `ACS_SENDER_ADDRESS` | _(missing from example file)_ | [UNVERIFIED] required by email-service init |
| `APP_BASE_URL` | `http://localhost:5173` | Base URL for magic links |
| `COSMOS_V2_CONTAINER_NAME` | _(missing from example file)_ | Defaults to `exchanges` in cosmosdb.ts |
| `AUTH_ORGANIZER_TOKEN_TTL_DAYS` | _(missing from example file)_ | Defaults to `90` in auth.ts |

### Existing v2 Email Helpers (`api/src/shared/v2/email.ts`)

| Helper | Sends To | Template | Bilingual? | Skip when unconfigured? |
|--------|----------|----------|------------|------------------------|
| `sendOrganizerLinkCreatedEmail(exchange, rawToken)` | `organizerEmail` | Inline HTML (EN only) | ❌ | ✅ `{ success:true, skipped:true }` |
| `sendInviteSentEmail(exchange, invite, rawToken)` | `invite.email` | Inline HTML (EN only) | ❌ | ✅ |
| `sendMatchRevealEmail(exchange, giver, receiver, rawToken)` | `giver.email` | Inline HTML (EN only) | ❌ | ✅ |
| `sendOrganizerLinkResentEmail(exchange, magicLink, language)` | `organizerEmail` | Delegates to v1 `generateOrganizerRecoveryEmailContent()` | ✅ (via v1 helper) | No — relies on ACS being configured |

Sources: `api/src/shared/v2/email.ts (Lines 55-130)`

**Known raw-token gap in reveal emails** (`api/src/functions/v2/match.ts Lines 108-114`, `revealMatches.ts Lines 65-70`): reveal emails pass an empty/placeholder token because raw invite tokens are not stored at rest. The reveal email links to `/match` without a valid token. Marked with `// #12 will redesign` comments.

### Gap for Issue #12

| Email Type | Status | Missing |
|-----------|--------|---------|
| `inviteSent` | ✅ Exists (`sendInviteSentEmail`) | Bilingual templates, idempotency record |
| `rsvpAccepted` | ❌ Missing | New helper, bilingual, idempotency record |
| `wishlistReminder` | ❌ Missing | New helper, bilingual, idempotency with date key |
| `matchReveal` | ⚠️ Partial (`sendMatchRevealEmail`) | Valid giver token in link, bilingual templates, idempotency |
| `giftByReminder` | ❌ Missing | New helper, bilingual, days-before-event configurable |

**Idempotency key composition recommendation:**

```
key = `${exchangeId}:${type}:${recipientRefId}:${dateKey}`
```
- `dateKey = ""` for one-time events (inviteSent, rsvpAccepted, matchReveal)
- `dateKey = YYYY-MM-DD` for recurring/scheduled sends (wishlistReminder, giftByReminder)
- Store as `NotificationEvent.idempotencyKey`; query before send: `SELECT TOP 1 FROM c WHERE c.entityType='notificationEvent' AND c.idempotencyKey=@key AND c.exchangeId=@exchangeId`

Rationale: `exchangeId` is the partition key so the idempotency lookup is a single-partition point read. Appending `dateKey` allows one reminder per recipient per day without blocking future sends.

**Unsubscribe token recommendation:**

```
token = HMAC-SHA256(recipientEmail, UNSUBSCRIBE_HMAC_SECRET) → base64url
```
- Deterministic — no storage needed to verify; just re-derive and compare
- Store opt-outs as a Cosmos document `{ id: token, entityType: 'unsubscribeRecord', email: recipientEmail }` in a new **`notifications`** container (separate from `exchanges`, no partition-key dependency on exchangeId)
- Check before send: `SELECT TOP 1 FROM c WHERE c.id = @token` in notifications container
- `inviteSent` and `matchReveal` always send (per decision #5); check is skipped for those types
- Add `UNSUBSCRIBE_HMAC_SECRET` env var (min 32 bytes random, stored in Key Vault)

[UNVERIFIED]: No unsubscribe infrastructure exists anywhere in `api/src`. The `NotificationEvent` type and `notifications` container schema must be created from scratch.

---

## 6. NotificationEvent Infrastructure

### What Exists

`api/src/shared/v2/types.ts (Lines 233-285)`: Full `NotificationEvent` interface ✅  
`src/lib/v2/types.ts (Lines 233-285)`: Frontend mirror, identical ✅

### What Is Missing

`api/src/shared/v2/cosmosdb.ts`: **Zero NotificationEvent helpers** — no `createNotificationEvent()`, `queryNotificationEventByIdempotencyKey()`, `listNotificationEventsByExchange()`, or `updateNotificationEventStatus()`.

Items to add for #12:
```typescript
// cosmosdb.ts additions needed
createNotificationEvent(event: NotificationEvent): Promise<NotificationEvent>
queryNotificationEventByIdempotencyKey(exchangeId: string, key: string): Promise<NotificationEvent | null>
listNotificationEventsByExchange(exchangeId: string): Promise<NotificationEvent[]>
updateNotificationEventStatus(event: NotificationEvent, status: NotificationStatus, providerMessageId?: string, failureReason?: string): Promise<NotificationEvent>
```

---

## 7. Existing Test Patterns

### API Unit Tests (Jest)

Pattern (consistent across all v2 test files):

```typescript
// 1. Mock entire module
jest.mock('../shared/v2/cosmosdb')
jest.mock('../shared/v2/email')

// 2. Grab typed mocks
const mockCreateDocument = jest.mocked(v2Cosmos.createDocument)

// 3. Import handler AFTER mocks
import { createExchangeHandler } from '../functions/v2/createExchange'

// 4. Factory helpers
function makeRequest(body: any): HttpRequest { return { json: jest.fn().mockResolvedValue(body) } as unknown as HttpRequest }
function makeContext(): InvocationContext { return { invocationId: 'test-…', log: jest.fn(), error: jest.fn() } as unknown as InvocationContext }
function makeExchange(overrides = {}): Exchange { return { id:'ex-1', exchangeId:'ex-1', entityType:'exchange', code:'100000', ... , ...overrides } }

// 5. beforeEach: clearAllMocks + set default mock returns
beforeEach(() => {
  jest.clearAllMocks()
  mockCreateDocument.mockImplementation(async (doc) => doc)
})
```

**Auth wiring in tests** (`api/src/__tests__/v2.rsvp.test.ts Lines 56-65`):
```typescript
function wireInvite(invite, exchange): string {
  const { generateToken } = require('../shared/v2/auth')
  const { token, tokenHash } = generateToken(exchange.id)
  invite.inviteTokenHash = tokenHash
  mockQueryInviteByTokenHash.mockResolvedValue(invite)
  mockGetExchangeById.mockResolvedValue(exchange)
  return token  // pass as query param to makeRequest
}
```

Sources: `api/src/__tests__/v2.createExchange.test.ts`, `v2.rsvp.test.ts`, `v2.wishlist.test.ts`, `v2.auth.test.ts`

### E2E Tests (Playwright)

`e2e/app.spec.ts` — no Page Object Model; raw `page.getByRole()`, `getByLabel()`, `getByPlaceholder()`, `getByText()`.

```typescript
test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    window.localStorage.setItem('zavaexchangegift:analytics-declined', 'true')
  })
})

test('full game creation flow', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /crear nuevo juego|create new game/i }).click()
  await page.getByLabel(/nombre del evento|event name/i).fill('Test Gift Exchange 2025')
  // … bilingual regex matchers throughout
  await expect(page.getByRole('heading', { name: /juego creado|game created/i })).toBeVisible()
})
```

Key conventions to match:
- `test.beforeEach` suppresses cookie banner via `addInitScript`
- Bilingual regex (`/en text|es text/i`) for all user-visible strings
- `page.getByRole()` preferred; `page.locator()` for complex selectors
- No auth setup helper (v2 tests will need one — token injection via `page.goto('/rsvp?inviteToken=…')`)

---

## 8. SWA Routing Config

`staticwebapp.config.json` (root):

```json
{
  "navigationFallback": {
    "rewrite": "/index.html",
    "exclude": ["/api/*", "/*.{css,scss,js,png,gif,ico,jpg,svg,woff,woff2,ttf,eot}"]
  },
  "responseOverrides": { "404": { "rewrite": "/index.html", "statusCode": 200 } }
}
```

**Assessment:** No changes needed for BrowserRouter. The fallback already rewrites all unknown paths to `/index.html`, which is precisely what a SPA with BrowserRouter requires. `/exchange/*`, `/rsvp`, `/wishlist`, `/match` will all resolve to `index.html` and be handled by react-router client-side.

**One addition recommended** — add `COSMOS_V2_CONTAINER_NAME` and `ACS_SENDER_ADDRESS` to the SWA application settings in the Azure portal (not in `staticwebapp.config.json` itself); also update `api/local.settings.json.example` to document these missing vars.

---

## 9. Open Questions for the Planner

1. **`ACS_SENDER_ADDRESS` in local.settings.json.example** — This env var is referenced in `api/src/shared/email-service.ts` but is absent from `api/local.settings.json.example`. Should it be added to the example file and the SWA app settings documentation in the PR? Likely yes — confirm with user.

2. **GiftByReminder trigger timing** — `giftByReminder` type is defined in `NotificationType` (`api/src/shared/v2/types.ts Line 244`) but there is no specification for how many days before `exchangeDate` it fires. The `revealMatches` timer runs every 15 min — should a new timer handle `giftByReminder`, or should `revealMatches` be extended? Also: should it fire once per participant or only to participants who have not confirmed (`hasConfirmedAssignment === false`)?

3. **Unsubscribe container** — The global unsubscribe token mechanism requires a second Cosmos container (`notifications`) separate from `exchanges`. This is a new infra resource. Should it be created in `cosmosdb.ts`'s `initializeV2Container()` equivalent, or as a separate `initializeNotificationsContainer()`? What is the TTL / retention policy on `unsubscribeRecord` documents (indefinite, or expiring when exchange is deleted)?

4. **`react-router-dom` not installed** — `package.json` contains no `react-router-dom` dependency. It must be added before any routing work begins. Confirm version: `^6.x` (v6 API as per decision #3).

5. **v1 deprecation banner** — Decision #1 says v1 views stay at current routes UNCHANGED. Should the `HomeView` show a "Try the new v2 experience" banner linking to `/exchange/new`, or remain completely silent about v2? This affects the `home` view and needs ~3 new translation keys if added.
