# Lowcountry Show Tracker — Project Notes

Consolidated reference for anyone (human or automated session) picking up work on this
repo. Last updated 2026-09-10, after PR #5 merged (digest email header fix, worker.js
corruption repair, and 8 code-review fixes).

## What this is

A live-music show tracker for the Charleston, SC area (site: gigalertchs.com). Static
frontend + a Cloudflare Worker backend for accounts, subscriptions, and a weekly digest
email. Show data is refreshed by a separate automated research routine that pushes
`shows.json` updates directly via PR (see "Show data collection" below).

## Files

| File | Role |
|---|---|
| `index.html` | The public site. Static HTML/CSS/vanilla JS, no build step. Fetches `shows.json` client-side and renders it. Served via GitHub Pages (custom domain via `CNAME`). |
| `worker.js` | Cloudflare Worker backend: passwordless sign-in, My Shows/Favorite Artists storage, digest email, admin stats, venue suggestions. Deployed via `.github/workflows/deploy-worker.yml`. |
| `admin.html` | Owner-only stats dashboard. Talks to the Worker's `/api/admin/stats`. Also static, no build step. |
| `shows.json` | The show data itself: `{ dataUpdatedAt, venues, shows }`. Updated by the weekly automated research routine, not hand-edited. |
| `wrangler.toml` | Worker deploy config: KV binding, Secrets Store bindings, cron trigger, custom domain route, plain vars. Source of truth for `wrangler deploy` — see the big warning comment at the top of the file about what gets silently stripped if this file is wrong/missing. |
| `CNAME` | GitHub Pages custom domain (`gigalertchs.com`). |
| `.github/workflows/deploy-worker.yml` | Auto-deploys `worker.js` to Cloudflare on every push to `main` that touches `worker.js` or `wrangler.toml`. **No test suite, no required review** — see "Deploy process" below for what changed here after the corruption incident. |

`index.html`/`admin.html`/`shows.json` need no separate deploy step — GitHub Pages
serves them straight from the repo.

## Data model

### `shows.json`

```
{
  "dataUpdatedAt": "YYYY-MM-DD",
  "venues": { "<CODE>": { "name", "site", "type": "venue"|"festival", "color", "address"? } },
  "shows": [ { "d", "b", "v", "sh", "dr", "o"?, "s"?, "p"?, "dop"?, "u"?, "e"?, "added"?, "flag"?, "soldOut"?, "lowTix"? } ]
}
```

Show fields:
- `d` — date (`YYYY-MM-DD`). `e` — optional end date for multi-day events.
- `b` — band/event name. `o` — opener(s), comma-separated if a list.
- `v` — venue code, must be a key in `venues`.
- `sh`/`dr` — show/doors time as free text (`"7:00 PM"`, `"—"`, `"see ticket link"`, `"TBA"`).
- `s` — stage name, when a venue has multiple stages.
- `p` — advance price (number, `0` = free). `dop` — optional day-of price, only used once the show's actual date has arrived (both the site and the digest email apply this rule identically — see `priceOrTicketsHTML` in `index.html` and the price block in `buildDigestEmailHTML` in `worker.js`).
- `u` — ticket URL. Validated as `http(s)://` before ever being put in an `href`, both client-side (`safeUrl()` in `index.html`) and server-side (`worker.js`), since `shows.json` is written by an automated scraping agent and its URLs aren't implicitly trusted.
- `added` — date this show was first added to the data. Drives the site's "Added This Week" section and the digest email's equivalent (cutoff: added within the last 7–10 days depending on which surface).
- `flag` — a one-line human-readable note for genuinely ambiguous cases (see sourcing rules below). Shown as-is, not acted on programmatically.
- `soldOut` / `lowTix` — booleans. **Both must be respected everywhere a price/ticket link renders** — `index.html`'s `priceOrTicketsHTML()` and `worker.js`'s `buildDigestEmailHTML`/`showRowHtml` price block are the two implementations and must stay in sync (this was out of sync until the 2026-09-10 fix — see "Incident history").

`showId(s)` — `[v, d, b].join('|').toLowerCase().replace(/\s+/g, '_')` — **must be kept
identical between `index.html` and `worker.js`**. It's the join key between a
subscriber's favorited/starred shows (client-side `MY_SHOWS`, server-side `myShows` in
KV) and the actual show list. If one side's version of this function ever changes, the
other needs the same change or personalization quietly breaks.

Known venue codes as of this writing: `PH` (Pour House), `REF` (The Refinery), `CMH`
(Music Hall), `WJ` (Windjammer), `C1S` (Credit One Stadium), `NCC` (N. Charleston
Coliseum), `MF` (Music Farm), `FD` (Firefly Distillery), `GC` (Gaillard Center), `NRB`
(New Realm Brewing), `TR` (Tin Roof), `RA` (The Royal American), plus festival/park
entries `RFR` (Riverfront Revival), `CJF` (Charleston Jazz Festival), `RFP` (Riverfront
Park).

### Cloudflare KV (`SHOW_TRACKER_KV`)

| Key pattern | Value | Notes |
|---|---|---|
| `token:<uuid>` | `{ email }` | Magic-link sign-in token. 15 min TTL, one-time use (deleted on verify). |
| `session:<uuid>` | `{ email }` | Session token, sent as `Authorization: Bearer`. 30-day TTL. |
| `subscriber:<email>` | `{ subscribedAt, unsubscribeToken }` | Presence = actively subscribed to the digest. |
| `unsubtoken:<uuid>` | `<email>` (plain string) | Reverse lookup from a subscriber's unsubscribe token back to their email. Reused as the auth credential for `/api/star-show` too (see below) — same trust level either way, since whoever holds it can already unsubscribe the person. |
| `unsubscribed:<email>` | `{ unsubscribedAt }` | Permanent marker so a later sign-in doesn't silently re-subscribe someone who opted out. No TTL. |
| `user:<email>` | `{ myShows: [showId...], favorites: [artistName...] }` | Both arrays are length- and count-capped (`MAX_SHOW_ID_LENGTH` = 150, favorites item cap 100 chars, both arrays capped to `MAX_MY_SHOWS` = 300 entries) since this is written from unauthenticated-by-anything-but-a-token paths (`/api/star-show`) as well as the authenticated `/api/user/data`. |
| `suggestion:<uuid>` | `{ submitterEmail, venueName, notes, submittedAt }` | From "Suggest a Venue." |
| `ratelimit:<email>` | `'1'`, 60s TTL | One sign-in link request per email per minute. |
| `ratelimit-ip:<ip>` | request count string, 1hr TTL | Best-effort per-IP cap (10/hr) on sign-in requests — not atomic, documented known limitation (KV read-then-write race under burst load; would need a Durable Object for a hard guarantee). |
| `suggest-ratelimit:<email>` | `'1'`, 60s TTL | One venue suggestion per person per minute. |

`listAllKeys(env, prefix)` pages through `KV.list()`'s cursor — added 2026-09-10 after
noticing every list-all call site was using a single unpaginated `list()`, which
silently truncates past 1000 keys. Use it for any new "every key with this prefix" need
instead of calling `KV.list()` directly.

## Worker API routes

| Route | Method | Auth |
|---|---|---|
| `/api/auth/request-link` | POST | none (rate-limited + Turnstile if configured) |
| `/api/auth/verify` | GET | magic-link token (query) |
| `/api/user/data` | GET/POST | session Bearer token |
| `/api/unsubscribe` | GET | unsubscribe token (query) + `confirm=1` |
| `/api/star-show` | GET | unsubscribe token (query, reused) + `confirm=1` |
| `/api/subscribe` | POST | session Bearer token |
| `/api/digest-preview` | GET | session Bearer token (preview your own digest) |
| `/api/test-send-digest-now` | GET | session Bearer token, owner-only |
| `/api/report-conflicts` | POST | `COWORK_API_SECRET` shared secret (Bearer), timing-safe compare |
| `/api/suggest-venue` | POST | session Bearer token |
| `/api/admin/stats` | GET | session Bearer token, owner-only |

`/api/unsubscribe` and `/api/star-show` both require an explicit `confirm=1` click past
a summary page rather than acting on a bare GET — added so a mail-security scanner or
link-prefetcher auto-fetching a link straight out of the email body can't silently
unsubscribe someone or star a show on their behalf.

## Secrets & environment variables

Set in Cloudflare (dashboard or Secrets Store), **never** committed:
- `RESEND_API_KEY` — Resend email API key. Until set, `/api/auth/request-link` runs in
  "test mode" and returns the magic link directly in the JSON response instead of
  emailing it.
- `TURNSTILE_SECRET_KEY` — Cloudflare Turnstile bot-protection secret. **Fails open**
  (skips verification) if absent — deliberate, so frontend/backend can be deployed
  slightly out of order without locking out sign-in, but means bot protection is
  silently off until this is actually set.
- `COWORK_API_SECRET` — shared secret for the automated research routine's
  `/api/report-conflicts` calls.

Plain vars (in `wrangler.toml`, safe to commit): `RESEND_FROM_ADDRESS`, `SITE_URL`,
`WORKER_BASE_URL`, `OWNER_EMAIL`.

`wrangler.toml` is the deploy source of truth — **anything a deploy needs that isn't
declared there gets silently dropped**. This has actually happened twice: once
stripping the KV binding (broke sign-in entirely) and once stripping the Secrets Store
bindings (broke magic-link email and silently disabled Turnstile). Read the comments at
the top of that file before touching it.

## Deploy process

`.github/workflows/deploy-worker.yml` runs on every push to `main` touching `worker.js`
or `wrangler.toml` (or manual `workflow_dispatch`). Steps: sanity-check → `wrangler
deploy --dry-run` → `wrangler deploy`. **No required review, no test suite** — a push to
`main` that touches those files goes live automatically.

The sanity-check step (added 2026-09-10) runs `node --check worker.js` plus a script
that fails the build if any top-level `function`/`async function` name is declared more
than once. This exists specifically because `wrangler deploy --dry-run` did **not**
catch the corruption incident below — the duplicated file was still syntactically
valid, just semantically broken.

## Incident history

### 2026-09-09: worker.js corruption (PRs #3, #4)

Two PRs, both titled *"Update print statement from 'Hello' to 'Goodbye'"* with no
description, were merged directly to `main`. Despite the placeholder titles, they
replaced the hand-written `worker.js` source with **esbuild-bundled output, committed
twice** (`__name()`/`__defProp()` bundler artifacts, comments stripped, every function
declared twice back-to-back). Because JS lets a later top-level `function` declaration
silently shadow an earlier one, only the *second* copy of each function actually ran —
this included a digest-email header-border fix that looked shipped but was actually
dead code the whole time.

No malicious intent was found in the diff (no new external domains, no credential
exfiltration, no eval/backdoor patterns) — this reads as an accidental
bundle-output-committed-as-source mistake, twice, under a badly mismatched placeholder
commit message, not a compromise. But it went straight to `main` and would have
auto-deployed live with zero review gate, which is the actual systemic issue (see
"Deploy process" — the sanity-check step exists because of this).

**Fixed in PR #5** (merged 2026-09-10): rebuilt `worker.js` from the last known-good
commit (`806090f`) and manually ported forward the legitimate feature work that had
been buried in the duplicate (the `/api/star-show` My Shows email feature).

If you ever see a commit/PR with a title that doesn't match its diff size, or an empty
PR body on a substantial change, treat it the way this one should have been treated:
stop, diff it against the last known-good state, and don't build on top of it until you
understand what actually changed.

### 2026-09-10: 8 findings from a full project review, all fixed in the same PR

- **High**: digest email didn't respect `soldOut`/`lowTix` (now mirrors `index.html`'s
  `priceOrTicketsHTML` exactly).
- **High**: `index.html`'s `cardHTML()` had no fallback for an unrecognized venue code
  and would throw mid-`render()`, breaking the whole page — real risk given
  `shows.json` is scraped weekly by an automated agent. Now falls back to the raw code,
  matching a guard `worker.js` already had.
- **Medium**: `KV.list()` calls were unpaginated (silently truncates past 1000 keys) —
  added `listAllKeys()`.
- **Medium**: `myShows` had no length/count cap, reachable via the token-only
  `/api/star-show` endpoint — added `MAX_SHOW_ID_LENGTH`/`MAX_MY_SHOWS`.
- **Medium**: weak deploy gate — added the sanity-check CI step described above.
- **Low**: `/api/unsubscribe` had no confirm step (mail scanners auto-GET links) —
  added, matching `/api/star-show`'s existing pattern.
- **Low**: `/api/report-conflicts`' `conflicts` array had no length cap, unlike every
  other caller-supplied input in the file.
- **Low**: the session token briefly sits in the URL after a magic-link redirect
  (`index.html` already strips it via `history.replaceState`, but a `Referer` leak to
  third-party loads — Google Fonts, Turnstile — was still possible in that window) —
  added `<meta name="referrer" content="same-origin">`.

## Digest email

Sent weekly via Cron Trigger (`sendDigestToAllSubscribers`, called from the Worker's
`scheduled()` handler — cron schedule lives in `wrangler.toml`, currently `0 19 * * wed`
= 19:00 UTC Wednesdays). Personalized per subscriber: pulls their `myShows` from KV,
renders a dedicated "My Shows" section above "Added This Week" and "Everything Else
Coming Up," with a one-click star/unstar link on every card (`/api/star-show`, reusing
their unsubscribe token as auth).

Header uses a double amber-border treatment matching the site's `.b2-frame` CSS
(`index.html`), reproduced with nested `<table>`s since HTML email doesn't support
`clip-path` (site's cut corners → square) or reliably render `rgba()` in old Outlook
(site's translucent inner border → solid `--amber-dim` `#8a672a`). Font is Georgia
(web-safe serif), deliberately not the site's Google Font.

`/api/digest-preview` (session-gated, your own digest) and `/api/test-send-digest-now`
(session-gated, owner-only, fires a real send to every subscriber) exist for manual
testing without waiting on the Cron Trigger.

## Show data collection (the weekly research routine)

A separate scheduled Cowork routine ("Show Tracker Weekly Update") fetches each tracked
venue's own site, diffs against `shows.json`, and opens a PR with the changes. This repo
doesn't contain that routine's prompt/config — these notes summarize it for context when
reviewing its PRs.

**Source priority**: venue's own site > official ticketing platform direct page >
nothing. Never resale/aggregator prices (StubHub, VividSeats, SeatGeek-as-resale, etc.).
AXS is a co-primary specifically at Charleston Music Hall and North Charleston
Coliseum/PAC, but only a cross-check (must not outrank the venue's own page) at Music
Farm, Windjammer, and Pour House. SeatGeek is excluded everywhere except an unverified
claim that it's become Credit One Stadium's exclusive primary — **as of 2026-09-09 this
was checked directly and found false**: C1S shows were still on Seated/Ticketmaster.
Re-verify before trusting that claim in the future.

**Exclusion rules**: DJ sets/dance parties/raves, podcast tapings/talk shows,
markets/vendor events with no music mentioned, burlesque/variety with no live band,
comedy specials, theatre, classical/orchestral (excluded unconditionally, no
exceptions), sports with zero music component. **Carve-out**: if a hybrid event
(rodeo, cornhole tournament, biker rally, oyster roast) explicitly mentions live music
as part of the pitch, include it with a `flag` noting the hybrid format — the line is
whether music is mentioned at all, not whether a specific act is named.

**Standing known issues** (don't re-report every run unless something changes):
- Charleston Music Hall: price blocked by Ticketmaster bot detection. An unverified
  lead that AXS might show face-value price where Ticketmaster doesn't has not been
  confirmed (AXS returned HTTP 403 from the routine's sandbox as of 2026-09-09).
- New Realm Brewing: venue's own live-music page is either behind a SiteGround captcha
  or an empty JS-rendered shell depending on fetch path. Fallback sources (Eventbrite,
  Bandsintown) were also unreachable/empty as of 2026-09-09.
- Tin Roof: robots-blocked entirely; Bandsintown is the only source, price never
  trusted from it, and Bandsintown itself returned HTTP 403 from the routine's sandbox
  as of 2026-09-09.
- Gaillard Center: out of scope entirely (classical/orchestral programming).

**Windjammer date reliability**: this venue's own site has shown real, repeated
date/stage mismatches against previously-stored data (10 separate corrections in one
run, 2026-09-09) — not just a one-off scrape error. Any Windjammer date/stage change
from a future run is worth an independent re-fetch/verification (date badge + 
day-of-week + URL slug) before trusting it, the same way the 2026-09-09 run did.

## Open items / things worth re-checking

- Confirm whether Credit One Stadium has actually switched to SeatGeek as primary
  ticketer (unverified claim, checked false once — see above).
- Confirm whether AXS shows face-value price for Charleston Music Hall (blocked by
  AXS 403 so far — try again from a different network context if possible).
- New Realm Brewing and Tin Roof have no reliable automated source at all right now;
  worth a manual look if the venues remain active.
- No branch-protection/required-review rule exists on `main` as of this writing (that's
  a GitHub repo setting, not something fixable via a commit) — the CI sanity-check step
  added 2026-09-10 catches the *specific* corruption class that happened once, but
  doesn't replace human review for anything else. Worth turning on required PR review
  for `main` if that's not already in place.
