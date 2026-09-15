# SelfLatitude Companion - API contract

All endpoints are under `/api`, JSON in / JSON out, authenticated by the `sl_session` httpOnly cookie.
Errors: `{ error: string, code: string, ...extra }` with an HTTP status. Codes you will see:
`unauthorized` (401), `forbidden` (403), `mfa_required` (403), `not_found` (404), `validation` (400),
`usage_exhausted` (402, extra `resetDate`), `model_requires_key` (402), `key_invalid` (400), `busy` (400),
`companion_unavailable` (503), `registration_closed` (403), `too_many_attempts` (429),
`bad_origin` (403, the request carried an `Origin` that is not `APP_URL` or one of `ALLOWED_ORIGINS`),
`server_error` (500).

**Two-step verification is enforced server-side.** When an account uses an authenticator or emailed
codes (or the owner has turned on codes for everyone), a session that has only supplied a password
gets `403 mfa_required` on every endpoint except `/api/auth/mfa/*`, `/api/auth/logout` and
`/api/auth/me`. The client should send such a session to the verification screen. Changing or
removing two-step verification (`/mfa/setup`, `/mfa/enable`, `/mfa/use-email`, `/mfa/disable`) also
requires a session that has already passed the current factor, so a stolen password cannot re-enrol.

Client helper: `client/src/api/client.ts` exports `api.get/post/put/patch/del/upload`, `streamPost` (SSE), `ApiError`, `downloadUrl`.
Types: `client/src/api/types.ts`.

## Auth  (`/api/auth`)
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /config | | `{ allowSelfRegistration, emailCodeMinutes }` public; drives whether the sign-up page is offered |
| GET | /me | | `{ user: User \| null, usage: UsageStatus \| null }` |
| POST | /register | `{email,name,password}` | `{ user }` - 403 `registration_closed` unless the owner enabled public sign-up |
| POST | /login | `{email,password}` | `{ user, mfaRequired, mfaMethod: 'totp'\|'email'\|null }` (an emailed code is sent automatically when the method is email) |
| POST | /logout | | `{ok}` |
| POST | /forgot | `{email}` | `{ok}` (always) |
| POST | /reset | `{token,password}` | `{ok}` |
| POST | /one-time | `{token}` | `{ user, mfaRequired, mfaMethod }` |
| POST | /change-password | `{currentPassword,newPassword}` | `{ok}` |
| POST | /onboarding | `{acceptTerms:true,acceptPrivacy:true,isAdult:true,memoryEnabled}` | `{ok}` |
| PATCH | /profile | `{name}` | `{ok}` |
| POST | /mfa/setup | | `{ secret, qr }` (qr = data URL png) |
| POST | /mfa/enable | `{code}` | `{ok}` |
| POST | /mfa/verify | `{code}` | `{ok}` accepts an authenticator code or an emailed code; marks the session verified |
| POST | /mfa/use-email | | `{ok, codeSent}` switch to emailed codes; a code is sent and the session must verify with it |
| POST | /mfa/send-code | | `{ok, minutes}` email a fresh 6-digit code |
| POST | /mfa/disable | `{password}` | `{ok}` (not allowed for superadmin) |

`User` = `{ id, email, name, role:'student'|'owner'|'superadmin', companionActive, companionEnd, courseAccess, onboardingCompleted, memoryEnabledDefault, journalShareAllowed, mfaEnabled, mfaMethod:'none'|'totp'|'email', mfaRequired, planId, avatarUrl, pendingEmail, mfaVerified, mustChangePassword }`

`GET /me` also returns `plan` (the student's plan, or null) alongside `user` and `usage`.

## Profile  (`/api/profile`)
| Method | Path | Body | Returns |
|---|---|---|---|
| POST | /avatar | multipart `avatar` (PNG/JPEG/WebP, max 2 MB; the browser resizes to 256px first) | `{ avatarUrl }` |
| DELETE | /avatar | | `{ok}` |
| GET | /avatar/:userId | | the image; only the owner or an administrator, otherwise 404 |
| POST | /email | `{newEmail, password}` | `{ok, pendingEmail}` emails a code to the NEW address; the address does not change yet |
| POST | /email/verify | `{code}` | `{ok, email}` |
| POST | /email/cancel | | `{ok}` |
| GET | /support | | `{ support: { email, responseTime, helpUrl, crisisNote } }` public; drives the Help page |

## Companion info  (`GET /api/companion`)
`{ name, description, starters:[{title,prompt}], models:[{id,label,included,isDefault}], defaultModelId, depths:{fast,medium,extended -> label}, version }`

## Conversations  (`/api/conversations`)
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /?archived=0\|1&q= | | `{ conversations: Conversation[] }` (temporary chats excluded) |
| POST | / | `{modelId?,depth?,memoryEnabled?,isTemporary?,title?}` | `{ conversation }` |
| GET | /:id | | `{ conversation (incl. summary), messages: Message[] }` |
| PATCH | /:id | `{title?,archived?,modelId?,depth?,memoryEnabled?}` | `{ conversation }` |
| DELETE | /:id | | `{ok}` |
| POST | /:id/messages | `{content, attachments?:[{type:'journal',entryId}]}` | **SSE stream** |
| POST | /:id/regenerate | | **SSE stream** (deletes last assistant reply first) |
| POST | /:id/stop | | `{ok}` (aborts in-flight generation) |
| POST | /:id/summary | | `{ summary }` |
| POST | /:id/continue | | `{ conversation }` new chat seeded with summary |

### SSE events (use `streamPost`)
- `meta`  `{ messageId, paymentSource:'included'|'customer_key', model, depth, promptVersion }`
- `delta` `{ text }` - append to the assistant message
- `title` `{ title }` - auto title assigned after first exchange
- `done`  `{ messageId, status:'complete'|'stopped'|'failed', error, content, sources:[{fileId,title,module,section}], memorySuggestions:[{id,category,content}], usage: UsageStatus }`
- `error` `{ error, code, status, ... }` - sent mid-stream only if generation fails after headers were flushed.

Up-front rejections (`usage_exhausted` 402 with `resetDate`, `model_requires_key` 402, `companion_unavailable` 503, `busy` 400) are returned as a normal JSON error **before** the student's message is saved, so `streamPost` throws an `ApiError` and the draft can simply be kept in the composer.

Message statuses: `failed` replies show `error`; they do not count toward usage.

## Memories  (`/api/memories`)
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /?status= | | `{ memories: Memory[], memoryEnabledDefault }` (pending first) |
| POST | / | `{category, content}` | `{ memory }` (approved) |
| PATCH | /:id | `{content?,category?,status?:'approved'|'rejected'|'disabled'}` | `{ memory }` |
| DELETE | /:id | | `{ok}` |
| DELETE | / | | `{ok}` clear all |
| PATCH | /settings/default | `{enabled}` | `{ok}` |

Categories: value, goal, commitment, preference, theme, practice, other.

## Journal  (`/api/journal`)
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /?month=YYYY-MM | | `{ entries: JournalEntry[] (no contentHtml), dates: string[] }` (dates = all YYYY-MM-DD with entries) |
| POST | / | `{entryDate?, title?}` | `{ entry }` |
| GET | /:id | | `{ entry }` (with contentHtml) |
| PATCH | /:id | `{title?, entryDate?, contentHtml?}` | `{ entry }` (autosave; server sanitizes to p/br/b/strong/i/em/u/s/h1-3/ul/ol/li/blockquote/hr/div) |
| DELETE | /:id | | `{ok}` |
| GET | /:id/download | | Markdown file download (use `downloadUrl`) |

## Usage & API key  (`/api/usage`)
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | / | | `{ usage: UsageStatus, history:[{period_start,period_end,payment_source,replies,cost}] }` |
| POST | /api-key | `{apiKey}` | `{ usage }` validates with OpenAI + stores encrypted (does NOT activate) |
| POST | /api-key/test | | `{ ok, error, usage }` |
| POST | /api-key/activate | `{keepUsing?}` | `{ usage }` explicit confirmation to use key for rest of period |
| POST | /api-key/deactivate | | `{ usage }` |
| DELETE | /api-key | | `{ usage }` |

`UsageStatus` = `{ periodStart, periodEnd (next reset), repliesUsed, repliesLimit, repliesRemaining, costUsed, costLimit, costRemaining, includedExhausted, warning:'none'|'low'|'very_low'|'critical'|'cost', paymentSource, customerKey:{last4,valid,activeUntil,keepUsing}|null }`

## Privacy & data  (`/api/privacy`)
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | / | | `{ settings:{memoryEnabledDefault,journalShareAllowed}, consent:{termsVersion,privacyVersion,consentAt,currentTerms,currentPrivacy}, requests:[...] }` |
| PATCH | /settings | `{memoryEnabledDefault?, journalShareAllowed?}` | `{ok}` |
| POST | /requests | `{kind:'access'|'correction'|'portability'|'deletion'|'consent'|'other', message?}` | `{ request }` |
| GET | /export/account.json | | file download |
| GET | /export/conversations.md | | file download |
| GET | /export/conversation/:id.md | | file download |
| GET | /export/journal.md | | file download |
| POST | /delete-all | `{what:'conversations'|'memories'|'journal'}` | `{ok}` |
| POST | /delete-account | `{password, confirm:'DELETE'}` | `{ok}` (signs out) |

## Admin - Owner  (`/api/admin`, role owner or superadmin)
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /overview | | `{ overview:{activeStudents,companionActive,suspended,conversations,replies30d,includedCost30d,indexedFiles,openPrivacyRequests} }` |
| GET | /companion | | `{ published: CompanionConfig, draft: CompanionConfig\|null, versions:[{id,version_number,status,name,published_at,published_by,created_at,updated_at}] }` |
| POST | /companion/draft | | `{ draft }` create draft from published (or return existing) |
| PUT | /companion/draft | partial CompanionConfig fields (`name,description,instructions,safetyRules,starters,models,depth,fileIds`) | `{ draft }` (creates draft if none) |
| DELETE | /companion/draft | | `{ok}` discard |
| POST | /companion/publish | | `{ published, versions }` |
| GET | /companion/versions/:id | | `{ version }` |
| POST | /companion/versions/:id/restore | | `{ draft }` copies old version into a new draft |
| POST | /companion/preview | `{messages:[{role,content}], modelId?, depth?}` | **SSE stream** same events as chat (not metered, not saved) |
| GET | /openai/key | | `{ configured, source:'settings'|'env'|null, last4, validatedAt, setBy }` platform key status (never the key) |
| PUT | /openai/key | `{apiKey}` | Super Admin + MFA. Verifies with OpenAI, stores encrypted |
| POST | /openai/key/test | | `{ ok, error }` |
| DELETE | /openai/key | | Super Admin + MFA |
| GET | /openai/models | | `{ models:[{id,created,reasoning}] }` live chat-capable models from the OpenAI API (platform key) |
| GET | /files | | `{ files: CourseFile[] }` |
| POST | /files | multipart `file`, `title?`, `moduleLabel?` | `{ file }` (auto-added to draft, indexed in background) |
| PATCH | /files/:id | `{title?, moduleLabel?, sortOrder?}` | `{ file }` |
| POST | /files/:id/reindex | | `{ file }` |
| POST | /files/:id/replace | multipart `file` | `{ file }` |
| DELETE | /files/:id | | `{ok}` |
| GET | /settings/usage | | `{ usage: UsageSettings, defaults }` |
| PUT | /settings/usage | UsageSettings | `{ usage }` |

## Admin - Super Admin  (`/api/admin/users`, role superadmin + MFA verified on session; 403 with message otherwise)
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /?q=&status=&planId=&page= | | `{ users: AdminUser[] (with planId, planName, repliesTotal, lastActivityAt), total, page, pageSize, plans:[{id,name}] }` |
| POST | / | `{email,name,role?,planId?,grantCompanionMonths?,password?,sendWelcomeEmail?(true),sendResetEmail?(false),requirePasswordChange?(true)}` | `{ user, credentials:{email,password,loginUrl}, emailed:'welcome'\|'reset'\|null, emailError }` - the password is returned once so the admin can copy it |
| GET | /:id | | `{ user, usage, history, counts:{conversations,memories,journalEntries,repliesAllTime,costAllTime,lastMessageAt}, plan, plans, payments, apiKey:{last4,valid,activeUntil,keepUsing,validatedAt}\|null, sessions, audit }` |
| PATCH | /:id | `{name?,email?,role?,courseAccess?,companionStart?,companionEnd?,replyLimitOverride?,costLimitOverride?,planId?,notes?}` | `{ user }` |
| POST | /:id/access | `{action:'grant'|'renew'|'suspend'|'revoke'|'reactivate', months?}` | `{ user }` |
| POST | /:id/reset-email | | `{ok}` |
| POST | /:id/temp-password | | `{ temporaryPassword }` (shown once) |
| POST | /:id/one-time-link | `{minutes?(30)}` | `{ link, expiresInMinutes }` |
| POST | /:id/sign-out-everywhere | | `{ok}` |
| DELETE | /:id | | `{ok}` permanent |

Other Super Admin:
| GET | /api/admin/audit?page=&q= | | `{ entries:[{id,actor_email,action,target_type,target_id,details,ip,created_at}] }` |
| GET | /api/admin/privacy-requests | | `{ requests:[{id,user_id,user_email,user_name,kind,message,status,due_at,admin_note,created_at}] }` |
| PATCH | /api/admin/privacy-requests/:id | `{status?, adminNote?}` | `{ request }` |

## Plans  (`/api/admin/plans`)
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | / | | `{ plans: Plan[] }` (each with `userCount`); owner or Super Admin |
| POST | / | Plan fields | `{ plan }` Super Admin |
| PUT | /:id | Plan fields | `{ plan }` Super Admin |
| DELETE | /:id | | `{ok}` - 400 while users are still on the plan |
| POST | /:id/assign | `{userId, mode:'start'|'extend'}` | `{ companionStart, companionEnd, planId }` |

`Plan` = `{ id, name, description, priceCents, currency, durationMonths (0 = never expires), grantsCourse, repliesPerPeriod: number|null, costCeilingUsd: number|null, isDefault, active, sortOrder }`.
A plan's `repliesPerPeriod` / `costCeilingUsd` override the global usage settings; a per-user override still wins over both.

## Settings  (`/api/admin/settings`, Super Admin for every write)
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /email | | `{ configured, source:'settings'|'env'|null, settings:{host,port,secure,user,from,replyTo,hasPassword}, env, templates, defaults }` |
| PUT | /email | `{host,port,secure,user,password?,from,replyTo}` | `{ok}` (omit `password` to keep the stored one) |
| POST | /email/test | `{to}` | `{ ok, error? }` verifies the connection and sends a test message |
| PUT | /email/templates | `{welcome,renewal,passwordReset,loginCode,emailChange,invite}` each `{subject,body}` | `{ templates }` |
| GET | /auth | | `{ auth: AuthSettings }` |
| PUT | /auth | AuthSettings | `{ auth }` |
| GET | /support | | `{ support }` |
| PUT | /support | `{email, responseTime, helpUrl, crisisNote}` | `{ support }` |
| GET | /jvzoo | | `{ settings:{enabled,hasSecret,productMap,sendWelcomeEmail,revokeOnRefund}, ipnUrl, plans, stats }` |
| PUT | /jvzoo | `{enabled,secret?,productMap,sendWelcomeEmail,revokeOnRefund}` | `{ok}` |
| GET | /payments?limit= | | `{ payments: [...] }` the IPN log |
| POST | /payments/:id/replay | | `{ok, note}` allows one repeated notification to be processed again |

`AuthSettings` = `{ allowSelfRegistration, selfRegistrationMonths, requireEmailCodeForAll, requireMfaForAdmins, emailCodeMinutes }`.

`requireMfaForAdmins` controls whether Super Admin sections demand a second step. `PUT /auth`
refuses to set it to `false` on a deployed instance (`NODE_ENV=production` or an `https` `APP_URL`),
so it can only be turned off for local development. Turning it off never disables a factor an
individual account has enrolled: that is still enforced for everyone by `requireAuth`.
Email template placeholders: `{{name}} {{email}} {{password}} {{loginUrl}} {{link}} {{code}} {{planName}} {{companionEnd}} {{appName}} {{minutes}}`.

## Payments webhook  (`POST /api/webhooks/jvzoo`)
Public, unauthenticated, `application/x-www-form-urlencoded`, signed by JVZoo's `cverify`
(first 8 uppercase characters of the SHA-1 of every posted value except `cverify`, sorted by field
name, joined with `|`, then the secret key appended).

Always answers `200 ok` so JVZoo does not retry forever; the outcome of every notification is stored
in `payments` and shown in the admin area. Repeated notifications for the same receipt and
transaction type are ignored, and a notification with no receipt is refused because it cannot be
de-duplicated.

| Transaction | What happens |
|---|---|
| `SALE` | Find or create the student, apply the plan mapped from `cproditem` (or the default plan), email the welcome or renewal message. Upsells are ordinary SALEs with their own product code, so they map to their own plan. |
| `BILL` | A rebill. Extends access from the existing end date, so nothing is lost. |
| `RFND`, `CGBK` | Reverse **exactly the purchase being refunded**: take back the months that purchase granted, take back course access only if that purchase granted it and no other purchase did, and move the student off the refunded plan. Their other purchases keep their time. If no matching purchase is on record, Companion access simply ends. |
| `CANCEL-REBILL` | Recorded only. Time already paid for is never taken back; access lapses on its own date and does not renew. |
| `UNCANCEL-REBILL` | Recorded only. The next `BILL` extends access. |
| `INSF` | Recorded only. JVZoo retries the payment. |

Each granting notification stores what it gave (`months_granted`, `granted_course`,
`granted_unlimited`), which is what makes a partial refund exact. A reversed purchase is marked
`reversed_at` / `reversed_by`, is excluded from the revenue figure, and shows as "Reversed" in the
payments log.
