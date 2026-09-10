# Lowcountry Show Tracker — Project Notes

Consolidated reference for anyone (human or automated session) picking up work on this repo. Merges the GitHub `main` version (last updated 2026-09-10, after PR #5) with the Claude-project research/operations notes (last updated 2026-09-09), plus a same-day 2026-09-10 session covering two Riverfront Park festival entries and two new standing policy decisions (Pops/jazz exclusion precedent, tiered-festival-pricing fallback). Replace all prior versions with this file.

## What this is

A live-music show tracker for the Charleston, SC area (site: gigalertchs.com). Static frontend + a Cloudflare Worker backend for accounts, subscriptions, and a weekly digest email. Show data is refreshed by a separate automated research routine that pushes `shows.json` updates via PR.

## Files

| File | Role |
|---|---|
| `index.html` | The public site. Static HTML/CSS/vanilla JS, no build step. Fetches `shows.json` client-side and renders it. Served via GitHub Pages (custom domain via `CNAME`). |
| `worker.js` | Cloudflare Worker backend: passwordless sign-in, My Shows/Favorite Artists storage, digest email, admin stats, venue suggestions. Deployed via `.github/workflows/deploy-worker.yml`. |
| `admin.html` | Owner-only stats dashboard. Talks to the Worker's `/api/admin/stats`. Also static, no build step. |
| `shows.json` | The show data itself: `{ dataUpdatedAt, venues, shows }`. Updated by the weekly automated research routine, not hand-edited. |
| `wrangler.toml` | Worker deploy config: KV binding, Secrets Store bindings, cron trigger, custom domain route, plain vars. Source of truth for `wrangler deploy` — see the warning comment at the top of the file about what gets silently stripped if this file is wrong/missing. |
| `CNAME` | GitHub Pages custom domain (`gigalertchs.com`). |
| `.github/workflows/deploy-worker.yml` | Auto-deploys `worker.js` to Cloudflare on every push to `main` that touches `worker.js` or `wrangler.toml`. No test suite, no required review — see "Deploy process" below. |

`index.html`/`admin.html`/`shows.json` need no separate deploy step — GitHub Pages serves them straight from the repo.

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
- `b` — band/event name. `o` — opener(s), comma-separated if a list. A single opener now renders inline on one line ("Band w/ Opener"), wrapping naturally — this replaced an earlier format where the opener sat on its own line below the band name. Multiple comma-separated openers still render as separate pill chips below the band name (that part is unchanged).
- `v` — venue code, must be a key in `venues`. Known codes as of this writing: `PH` (Pour House), `REF` (The Refinery), `CMH` (Music Hall), `WJ` (Windjammer), `C1S` (Credit One Stadium), `NCC` (N. Charleston Coliseum), `MF` (Music Farm), `FD` (Firefly Distillery), `GC` (Gaillard Center), `NRB` (New Realm Brewing), `TR` (Tin Roof), `RA` (The Royal American), plus festival/park entries `RFR` (Riverfront Revival), `CJF` (Charleston Jazz Festival), `RFP` (Riverfront Park).
- `sh`/`dr` — show/doors time as free text (`"7:00 PM"`, `"—"`, `"see ticket link"`, `"TBA"`).
- `s` — stage name, when a venue has multiple stages.
- `p` — advance price (number, `0` = free). Always the advance price when a show has one — stored and shown by default up through the day before the show. Many venues list both an advance and day-of price (e.g. "$25 advance / $30 day of show," or "$13 – $15") — always store the lower/advance figure in `p`, never the day-of figure or an average.
  - **Tiered/multi-day festival pricing fallback (decided 2026-09-10):** some festivals (multi-day passes, GA/GA+/VIP/Stage Access tiers, prices that visibly increase over time via presale windows) don't reduce to one honest "advance price" number — picking any single tier would misrepresent the others. When pricing is this fragmented, omit `p` entirely and rely on `u` (ticket link) alone rather than forcing a single figure. Reserve this for genuine multi-tier/multi-day spreads, not as a shortcut when a single advance price is knowable but just requires an extra fetch.
- `dop` — optional day-of price, only used once the show's actual date has arrived (compares the visitor's local date to `d`). Both the site (`priceOrTicketsHTML()` in `index.html`) and the digest email (`buildDigestEmailHTML` in `worker.js`) apply this rule identically — if one changes, the other needs the same change.
- `u` — ticket URL. Validated as `http(s)://` before ever being put in an `href`, both client-side (`safeUrl()` in `index.html`) and server-side (`worker.js`), since `shows.json` is written by an automated scraping agent and its URLs aren't implicitly trusted.
- `added` — date this show was first added to the data. Drives the site's "Added This Week" section and the digest email's equivalent (cutoff: added within the last 7–10 days depending on which surface).
- `flag` — a one-line human-readable note for genuinely ambiguous cases (e.g. hybrid non-music/music events — see exclusion rules below). Shown as-is in the data, but **not rendered anywhere on the live site** (confirmed by checking the code — the CSS class exists but nothing ever creates an element with it); it's an internal/editorial note only.
- `soldOut` / `lowTix` — booleans, independent of `flag`, and the only fields that actually drive visible ticket-status UI. `soldOut: true` is set when the venue's own page explicitly shows "Sold Out" — the site shows a muted-red "Sold Out" label (`--sold-out: #c96a6a`) in place of the price/Tickets link, not a link, since there's nothing to click through to. `lowTix: true` is set when the venue shows a low-inventory status (e.g. Music Farm's "LOW TIX") — tickets are still purchasable, so the site shows a gold "Low Tix" label that's still a working link. Both must be respected everywhere a price/ticket link renders — `index.html`'s `priceOrTicketsHTML()` and `worker.js`'s `buildDigestEmailHTML`/`showRowHtml` price block are the two implementations and must stay in sync (this was out of sync until the 2026-09-10 fix — see Incident history).
- `"g": "classical"` should not be used at all going forward (classical/orchestral is excluded entirely — see exclusion rules). As of the last full audit, zero shows in the dataset carry this tag. An earlier design (hide-by-default with a per-venue reveal toggle) was removed from the code entirely, not just left dormant.

`showId(s)` — `[v, d, b].join('|').toLowerCase().replace(/\s+/g, '_')` — must be kept identical between `index.html` and `worker.js`. It's the join key between a subscriber's favorited/starred shows (client-side `MY_SHOWS`, server-side `myShows` in KV) and the actual show list. If one side's version of this function ever changes, the other needs the same change or personalization quietly breaks.

### Cloudflare KV (`SHOW_TRACKER_KV`)

| Key pattern | Value | Notes |
|---|---|---|
| `token:<uuid>` | `{ email }` | Magic-link sign-in token. 15 min TTL, one-time use (deleted on verify). |
| `session:<uuid>` | `{ email }` | Session token, sent as `Authorization: Bearer`. 30-day TTL. |
| `subscriber:<email>` | `{ subscribedAt, unsubscribeToken }` | Presence = actively subscribed to the digest. |
| `unsubtoken:<uuid>` | `<email>` (plain string) | Reverse lookup from a subscriber's unsubscribe token to their email. Reused as the auth credential for `/api/star-show` too — same trust level either way, since whoever holds it can already unsubscribe the person. |
| `unsubscribed:<email>` | `{ unsubscribedAt }` | Permanent marker so a later sign-in doesn't silently re-subscribe someone who opted out. No TTL. |
| `user:<email>` | `{ myShows: [showId...], favorites: [artistName...] }` | Both arrays length/count-capped (`MAX_SHOW_ID_LENGTH` = 150, favorites item cap 100 chars, both arrays capped to `MAX_MY_SHOWS` = 300) since this is written from unauthenticated-by-anything-but-a-token paths (`/api/star-show`) as well as the authenticated `/api/user/data`. |
| `suggestion:<uuid>` | `{ submitterEmail, venueName, notes, submittedAt }` | From "Suggest a Venue." |
| `ratelimit:<email>` | `'1'`, 60s TTL | One sign-in link request per email per minute. |
| `ratelimit-ip:<ip>` | request count string, 1hr TTL | Best-effort per-IP cap (10/hr) on sign-in requests — not atomic; KV has no atomic increment, so a burst of simultaneous requests can overshoot the cap. A hard guarantee would need Durable Objects. Treated as a best-effort volume brake, with the per-email limit and Turnstile as the tighter controls. |
| `suggest-ratelimit:<email>` | `'1'`, 60s TTL | One venue suggestion per person per minute. |

`listAllKeys(env, prefix)` pages through `KV.list()`'s cursor — added 2026-09-10 after noticing every list-all call site was using a single unpaginated `list()`, which silently truncates past 1000 keys. Use it for any new "every key with this prefix" need instead of calling `KV.list()` directly.

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

`/api/unsubscribe` and `/api/star-show` both require an explicit `confirm=1` click past a summary page rather than acting on a bare GET — added so a mail-security scanner or link-prefetcher auto-fetching a link straight out of the email body can't silently unsubscribe someone or star a show on their behalf.

## Secrets & environment variables

Set in Cloudflare (dashboard or Secrets Store), **never** committed:
- `RESEND_API_KEY` — Resend email API key. Until set, `/api/auth/request-link` runs in "test mode" and returns the magic link directly in the JSON response instead of emailing it.
- `TURNSTILE_SECRET_KEY` — Cloudflare Turnstile bot-protection secret. **Fails open** (skips verification) if absent — deliberate, so frontend/backend can be deployed slightly out of order without locking out sign-in, but means bot protection is silently off until this is actually set.
- `COWORK_API_SECRET` — shared secret for the automated research routine's `/api/report-conflicts` calls.

Plain vars (in `wrangler.toml`, safe to commit): `RESEND_FROM_ADDRESS`, `SITE_URL`, `WORKER_BASE_URL`, `OWNER_EMAIL`.

**Secrets Store secret names do not match their binding names** (cost real debugging time): bindings are uppercase (what `worker.js` reads off `env`), but the actual secret names in the store are `RESEND_API_KEY` (uppercase), `turnstile-secret-key` (lowercase, hyphenated), `cowork-api-secret` (lowercase, hyphenated). Store ID is `30c772729ee04e95b2d1ee57b4be87fd`. KV namespace is `SHOW_TRACKER_KV`, id `d6ce7eeb579342ddaab94ae9560ddfc2`.

`wrangler.toml` is the deploy source of truth — anything a deploy needs that isn't declared there gets silently dropped. This has happened twice: once stripping the KV binding (broke sign-in entirely) and once stripping the Secrets Store bindings (broke magic-link email and silently disabled Turnstile). Read the comments at the top of that file before touching it.

## Deploy process

`.github/workflows/deploy-worker.yml` runs on every push to `main` touching `worker.js` or `wrangler.toml` (or manual `workflow_dispatch`). Steps: sanity-check → `wrangler deploy --dry-run` → `wrangler deploy`. **No required review, no test suite** — a push to `main` that touches those files goes live automatically. No branch-protection/required-review rule exists on `main` as of this writing (a GitHub repo setting, not fixable via a commit) — worth turning on if that's not already in place.

The sanity-check step (added 2026-09-10) runs `node --check worker.js` plus a script that fails the build if any top-level `function`/`async function` name is declared more than once — added specifically because `wrangler deploy --dry-run` did **not** catch the corruption incident below (the duplicated file was still syntactically valid, just semantically broken).

Other deploy notes:
- `worker.js` is tracked in git and deploys automatically via this workflow — manual pasting into Cloudflare's Edit Code UI still works as a fallback but is no longer required.
- `cloudflare/wrangler-action` swallows Wrangler's own output and reports only "exit code 1," which made two separate failures impossible to diagnose. The workflow now calls `npx wrangler@4 deploy` directly as a plain `run:` step, plus a `--dry-run` validation step first — keep it that way, since the visible error output is what finally solved those failures.
- The `CLOUDFLARE_API_TOKEN` used by GitHub Actions needs Secrets Store permissions, not just Workers Scripts. A token made from the "Edit Cloudflare Workers" template alone fails with error 10021 on any deploy touching Secrets Store bindings.
- The Cowork automation path (for the weekly data-update routine) was abandoned — its GitHub connector fails OAuth against the official GitHub MCP server. Weekly data updates instead run through a **Claude Code Routine**: cloud-hosted, scheduled, pushes to a `claude/`-prefixed branch and opens a PR for review rather than committing straight to main.
- `test_worker.js` (a 30-test suite referenced in older notes) is not in the repo and has never been located.

## Incident history

### 2026-09-09: worker.js corruption (PRs #3, #4)

Two PRs, both titled *"Update print statement from 'Hello' to 'Goodbye'"* with no description, were merged directly to `main`. Despite the placeholder titles, they replaced the hand-written `worker.js` source with esbuild-bundled output, committed twice (`__name()`/`__defProp()` bundler artifacts, comments stripped, every function declared twice back-to-back). Because JS lets a later top-level `function` declaration silently shadow an earlier one, only the *second* copy of each function actually ran — this included a digest-email header-border fix that looked shipped but was actually dead code the whole time.

No malicious intent was found in the diff (no new external domains, no credential exfiltration, no eval/backdoor patterns) — this reads as an accidental bundle-output-committed-as-source mistake, twice, under a badly mismatched placeholder commit message, not a compromise. But it went straight to `main` and would have auto-deployed live with zero review gate, which is the actual systemic issue (see "Deploy process" — the sanity-check step exists because of this).

**Fixed in PR #5** (merged 2026-09-10): rebuilt `worker.js` from the last known-good commit (`806090f`) and manually ported forward the legitimate feature work that had been buried in the duplicate (the `/api/star-show` My Shows email feature).

If a commit/PR title doesn't match its diff size, or an empty PR body sits on a substantial change, treat it the way this one should have been treated: stop, diff it against the last known-good state, and don't build on top of it until the actual change is understood.

### 2026-09-10: 8 findings from a full project review, all fixed in the same PR

- **High**: digest email didn't respect `soldOut`/`lowTix` (now mirrors `index.html`'s `priceOrTicketsHTML` exactly).
- **High**: `index.html`'s `cardHTML()` had no fallback for an unrecognized venue code and would throw mid-`render()`, breaking the whole page — real risk given `shows.json` is scraped weekly by an automated agent. Now falls back to the raw code, matching a guard `worker.js` already had.
- **Medium**: `KV.list()` calls were unpaginated (silently truncates past 1000 keys) — added `listAllKeys()`.
- **Medium**: `myShows` had no length/count cap, reachable via the token-only `/api/star-show` endpoint — added `MAX_SHOW_ID_LENGTH`/`MAX_MY_SHOWS`.
- **Medium**: weak deploy gate — added the sanity-check CI step described above.
- **Low**: `/api/unsubscribe` had no confirm step (mail scanners auto-GET links) — added, matching `/api/star-show`'s existing pattern.
- **Low**: `/api/report-conflicts`'s `conflicts` array had no length cap, unlike every other caller-supplied input in the file.
- **Low**: the session token briefly sits in the URL after a magic-link redirect (`index.html` already strips it via `history.replaceState`, but a `Referer` leak to third-party loads — Google Fonts, Turnstile — was still possible in that window) — added `<meta name="referrer" content="same-origin">`.

## Security posture (audited and fixed)

- **All rendered data is escaped.** `index.html` and `admin.html` both have an `escapeHtml()` helper applied to every interpolated value — this matters more than it used to, since `shows.json` is now written by an automated agent scraping venue websites, making a malformed venue listing a plausible injection path, not a hypothetical one.
- **URLs are validated before reaching an `href`.** `safeUrl()` in `index.html` (and an equivalent inline check in `worker.js`'s digest email builder) rejects anything that isn't `http://` or `https://`, blocking `javascript:`/`data:` URLs.
- **Input validation is applied on both sides.** Favorite artist names and venue suggestions reject angle brackets and enforce length limits in both the browser and the Worker. Server-side is the real gate; client-side just prevents the value from rendering locally before any round-trip.
- **Admin authorization is server-enforced** (`handleAdminStats` checks the session email against `OWNER_EMAIL`), not merely hidden in the UI — correct and should stay that way, since that endpoint exposes other users' email addresses.
- The per-IP sign-in rate limit's non-atomic KV race (see KV table above) is a known, accepted limitation, not an oversight.

## Digest email

Sent weekly via Cron Trigger (`sendDigestToAllSubscribers`, called from the Worker's `scheduled()` handler — cron schedule lives in `wrangler.toml`, currently `0 19 * * wed` = 19:00 UTC Wednesdays; an earlier version of `wrangler.toml` said `0 18 * * 3`, which would have silently shifted the send time by an hour on deploy). Personalized per subscriber: pulls their `myShows` from KV, renders a dedicated "My Shows" section above "Added This Week" and "Everything Else Coming Up," with a one-click star/unstar link on every card (`/api/star-show`, reusing their unsubscribe token as auth).

Header uses a double amber-border treatment matching the site's `.b2-frame` CSS, reproduced with nested `<table>`s since HTML email doesn't support `clip-path` (site's cut corners → square) or reliably render `rgba()` in old Outlook (site's translucent inner border → solid `--amber-dim` `#8a672a`). Font is Georgia (web-safe serif), deliberately not the site's Google Font. (Note: an earlier *draft mockup* of the main site's time display had also used Georgia and caused AM/PM to wrap — that was a bug and was fixed in `index.html`'s own card display, which now uses a condensed font for the time number with AM/PM as a smaller inline suffix on the same line. The digest email's use of Georgia for its header is a separate, deliberate, and still-current choice — don't conflate the two.)

`/api/digest-preview` (session-gated, your own digest) and `/api/test-send-digest-now` (session-gated, owner-only, fires a real send to every subscriber) exist for manual testing without waiting on the Cron Trigger.

## Filter bar (browse view)

- Controls: date range (This week / This month / All), a single-venue selector (no "exclude this venue" mode — tried and explicitly removed as unnecessary), and a "Favorite artists only" toggle.
- Default on load: all dates, all venues, favorites off — nothing is pre-filtered; a visitor sees the whole calendar unless they deliberately narrow it.
- Applies only to the browse views (Added This Week + the main day-grouped list) — never to My Shows or Favorite Artists, which are personal curated lists, not the calendar being browsed.
- A show that's in My Shows still appears normally in the main/browse list too — there is no exclusion logic anywhere that removes a show from the full list just because it's also in My Shows (confirmed by reading the code; this was already the behavior, not a change).

## My Shows / Favorite Artists model

- Two independent lists, deliberately decoupled. Favoriting an artist (Favorite Artists) always surfaces their upcoming shows in My Shows automatically. Favoriting a single show does not add the artist to Favorite Artists, and vice versa (this reversed an earlier, coupled behavior that used to exist in production).
- Un-favoriting an artist does not retroactively remove shows already auto-added to My Shows because of that artist — those stay until manually removed. Deliberate, not an oversight.
- Storage keys were renamed from `watchlist` to `my-shows` (client-side key, and the wire/KV field sent to the Worker, now `myShows`) — done deliberately while there were few enough users that no data migration was needed. Any future schema rename needs to touch `index.html`, `worker.js`, AND `admin.html` together (`admin.html` reads a `myShowsCount` field derived from this).

## Show data collection (the weekly research routine)

A scheduled Claude Code Routine ("Show Tracker Weekly Update") fetches each tracked venue's own site, diffs against `shows.json`, and opens a PR with the changes, pushed to a `claude/`-prefixed branch. This repo doesn't contain the routine's prompt/config — the sections below summarize it for context when reviewing its PRs.

### Research conventions

- **Completeness check, every time:** when updating any venue's data — even for a single-field fix — fetch that venue's own full calendar/schedule page and list every date+artist shown. Cross-reference against every existing `shows.json` entry for that venue code; anything on the venue's page not already in the data is a miss, add it. Do this every time, since there's no persistent memory of past sessions to rely on unless it's written down here.
- **Cover all available dates, not just a near-term window.** If a venue's own calendar lists shows two or three months out, reconcile against all of them. (A September-only pass on Music Farm once missed three real shows sitting in October/November on the same already-fetched page.)
- **Source priority — venue's own site first, always.** Prefer the venue's own site over Songkick, Bandsintown, Ticketmaster search snippets, or any other aggregator, for both event completeness and price accuracy. Aggregators are a fallback only when a venue's own site is genuinely unreachable for automated fetching.
- **Price sourcing priority:** venue's own site price > official ticketing platform (Ticketmaster/Afton/WhollyTicket/AXS-where-co-primary/SeatGeek-where-official) direct page > nothing. Never resale/aggregator prices (StubHub, VividSeats, TickPick, SeatGeek-as-resale-elsewhere, Gametime, viagogo, Eventworld, etc.) — these run 2–3x face value and would corrupt the dataset. If only a resale price is reachable, report "no reliable face-value price found" and leave the show unpriced.
- **Advance vs. day-of price: always store the advance price** in `p` (see Data model above).
- **Never leave a show at "discovery-source" data quality.** Confirmed bug, now fixed as a standing rule: 13 Charleston Pour House shows had a Jambase link as their `u` field and `"see ticket link"` placeholders for `dr`/`sh`, with no opener, stage, or price — even though each had a real, fully detailed event page on charlestonpourhouse.com itself. After finding a show exists (by any means, aggregator included), the URL and full detail fields (`dr`, `sh`, `p`, `o`, `s`) must come from the venue's own individual event page if one exists. Known constraint: Pour House's own `/shows/` listing paginates, and pages beyond the first are blocked by robots.txt; when that happens, search for the specific show by name + venue to find its individual event page directly, rather than falling back to an aggregator.
- **Non-music events — exclude confidently, don't include-and-flag.** An earlier "if ambiguous, include and flag" rule let ten non-music events into the data in one session (Retroland Market, Booty Bounce Charleston, Sploinky Rave: Charleston, Off Campus Night, Gasolina Halloween Party, Sexy Unique Podcast, "Let's F*cking Date with Serena Kerrigan," 90s Burlesque, Emo Night Brooklyn: Halloween Edition) before being caught and removed. Revised rule:
  - Treat these as non-music by default, exclude outright, no flag needed: DJ sets/dance parties/raves, themed nightlife/"18+ party" nights with no booked act and no live-music mention, podcast tapings/talk shows/dating-show-style events, markets/vendor events with no music mentioned, burlesque/variety revues with no live band as headliner, comedy/Broadway/pure-sports events with zero music component.
  - **Carve-out** (decided after the "Bulls, Bands, and Barrels" and "Biker Oyster Roast" cases): if an event's own description explicitly mentions live music as one component — even a hybrid event (rodeo, cornhole tournament, biker rally, oyster roast), even with no specific act named — include it, with a `flag` noting the hybrid format. The line is whether music is part of the pitch at all, not whether a specific artist is named. Signal phrases: "live music," "live entertainment," "and bands," etc., anywhere in the venue's own copy.
  - Signal words that still mean exclude (no live-music mention present): "DJ," "Dance Party," "Rave," "Market," "Podcast," a talk/game-show-style title, "Burlesque," "[Something] Night" with no artist name and no live-music mention, sports/rodeo events with no music mention at all.
- **Classical/orchestral music: excluded entirely, current and future, no exceptions.** Gaillard Center's CSO/Masterworks series (10 shows) was removed from `shows.json` in an earlier session; the previous hide-by-default/per-venue-reveal-toggle design was removed from the code entirely.
  - **Resolved precedent — "Jazz in the Park" / Pops series (decided 2026-09-10):** Riverfront Park hosts a recurring "Jazz in the Park" series explicitly billed as "an evening of smooth jazz" and produced by the North Charleston Pops. This created a genuine rule conflict: the hybrid-event carve-out (above) says explicit live-music language should trigger inclusion, but the classical/orchestral exclusion says Pops-produced programming is excluded with no exceptions. **Decision: exclude.** The classical/orchestral exclusion takes precedence over the hybrid carve-out whenever the presenting organization is a Pops/orchestral ensemble, regardless of how the event's own marketing describes the music genre. Treat this as settled going forward — don't re-litigate it per-instance for this or similarly Pops-produced series.
- **Treat single automated research passes as needing spot-check verification, not settled fact.** Concrete case (2026-09-09 session): an Advanced Research pass concluded Firefly Distillery's own page was a dead "dark" source — wrong; a direct fetch the same session found 4 real, current shows. The same pass also admitted its own AXS event counts drifted within the session (Music Farm moved from ~44 to ~37 between an early spot-check and the final report). Any claim sourced only from a research pass — not a direct fetch/curl test in the same session — should be marked unverified until spot-checked, especially before it's written into something that runs unattended.

### Per-venue fetch strategy

| Venue | Best URL to fetch | Status |
|---|---|---|
| Charleston Pour House | `charlestonpourhouse.com/shows/` | Full HTML, all fields inline (price, doors, show, opener, stage). Paginates — page 1 only goes ~6 weeks out; further pages blocked by robots.txt. Beyond page 1, need each show's own `charlestonpourhouse.com/event/...` URL, often not yet search-indexed if new — hardest venue to complete far out. AXS (`axs.com/venues/130583`, 28 events) is useful as a cross-check/gap-catcher but should not outrank the venue's own site. |
| Music Farm | `musicfarm.com/calendar/` | Full HTML, all fields inline including the venue's own "Buy Tickets"/"LOW TIX"/"Sold Out" status labels. No pagination issue found — one fetch covered ~2.5 months. AXS (`axs.com/venues/124602`) count fluctuated ~44→37 within one research session — treat any stored count as stale-prone; cross-check only. |
| The Royal American | `theroyalamerican.com/schedule` | Full HTML, one long page covering many months (May 2026–Jan 2027 in one fetch). All fields inline (doors, price, opener, Instagram links per act). Best-behaved venue site found so far. No AXS page exists for this venue; Bandsintown/Songkick only catch the handful of ticketed touring dates, not the near-nightly local shows — the venue's own site is decisively more complete. |
| The Windjammer | `the-windjammer.com/events/` | Full HTML, all fields inline. Caution: the day-of-week label and trailing date stamp on each card aren't always internally consistent — cross-check against existing data before trusting a new date from this page alone. AXS (`axs.com/venues/130171`, 28 events) is a cross-check; be aware Bandsintown has duplicate venue entries for this venue — don't conflate them. |
| Credit One Stadium | `creditonestadium.com/events/` | Full HTML but only date/time/ticket-link, no price. Confirmed still Ticketmaster/Seated as of 2026-09-09 (an earlier research-pass claim of a May 2026 SeatGeek exclusivity switch was wrong — see below). AXS (`axs.com/venues/120907`) is a secondary cross-check only. |
| Firefly Distillery | `fireflydistillery.com/upcoming-shows/` | Confirmed working as of 2026-09-09 — full HTML with real show names + dates. A dismissable "Firefly is on the move" relocation banner appears but does not replace the listing — an earlier research-pass claim that this page was "dark" was directly disproven; don't trust that claim if it resurfaces. Times/price still need each show's own `/event/...` page. AXS (`axs.com/venues/129043`) and Bandsintown both carry current secondary listings if needed. |
| North Charleston Coliseum & PAC | `northcharlestoncoliseumpac.com/events` | Full HTML list, but no times/price on the list itself. Individual event pages are directly fetchable even without being search-indexed (e.g. `/events/detail/travis-tritt-2` worked on the first try) — the one venue where guessing the individual-page URL pattern from the list page's own links worked. Lists many non-music events (comedy, Broadway, sports, POPS orchestral, Disney on Ice) mixed in — needs filtering every time. AXS is a genuine co-primary here (the venue's own FAQ names AXS alongside Ticketmaster for select events; two AXS pages exist, Coliseum and PAC halls separately). Individual venue event-detail pages sometimes carry a "starting at $X" line even when Ticketmaster is blocked for price — check those before assuming Ticketmaster is the only source. |
| Charleston Music Hall | Ticketmaster only, price-blocked | Ticketmaster's bot detection prevents price capture; the Music Hall's own site doesn't display prices either. AXS tested twice on 2026-09-09 with conflicting results depending on client — see "Secondary-source bot detection is client-dependent" below. Currently a documented limitation, not a usable workaround, for the unattended routine. |
| New Realm Brewing | No working primary | See "New Realm Brewing: dual failure mode" below. Do not use `newrealmbrewing.com/charleston/live-music-events/` as a fetch target. |
| Charleston Tin Roof | `charlestontinroof.com` (robots-blocked) | Bandsintown (`bandsintown.com/v/10003240-tin-roof`) worked via an interactive fetch client (9 current events) but returned a genuine 403 from Bandsintown's own servers via the routine's sandbox client — same dual-client pattern as CMH/AXS. Songkick exists but is thinner (4 events) and untested against this same question. No AXS page and no reliable price source exists for this venue. |

### The core technical constraint (why some venues are hard)

The `web_fetch`-style tool can only open a URL that has already appeared in a search result, a prior fetch, or something the user typed directly — it doesn't matter if the page exists and is publicly reachable; if it hasn't surfaced in search yet (common for recently-published event pages) or robots.txt disallows the path, it's a dead end regardless of how the query is phrased. Reformulating the search rarely helps once this is confirmed. Two reliable ways around it:
1. The user pastes the direct URL — a batch of venue homepage URLs is far more effective than searching for each show individually.
2. A base listing page (Pour House's `/shows/`, Music Farm's `/calendar/`) is usually reachable even when individual event pages or later pagination aren't — always try the venue's main calendar page first, in full, before hunting for anything more specific.

Browser automation would remove this constraint entirely, since it navigates live rather than requiring a prior search hit — but requires Chrome open with the extension connected, which hasn't been set up in past sessions.

### Cloud environment network-egress allowlist (routine-specific, resolved 2026-09-09/10)

Distinct from the `web_fetch` search-index constraint above — this applies specifically to the Claude Code Routine's cloud sandbox, not interactive chat sessions.

**What was wrong:** the routine reported all 7 venue domains as `EGRESS_BLOCKED` on a scheduled run, despite the cloud environment's Custom network allowlist visibly containing them. Direct curl tests inside a manual session on the same environment found the allowlist only contained wildcard-form entries (`*.charlestonpourhouse.com`, `*.musicfarm.com`, etc.) — no bare-apex entries. A wildcard like `*.example.com` conventionally matches subdomains only, not the bare domain. Since venue sites' `www.` versions 301-redirect to the bare apex, and the routine's own fetch strategy targets bare-apex URLs directly, every real request hit exactly the unmatched form.

**Confirmed by direct test:** `charlestonpourhouse.com` and `musicfarm.com` (bare) were blocked at the proxy's CONNECT stage before reaching the real server; their `www.` variants reached the server and returned a 301 back to the bare domain. A control request to `example.com` (never intended to be allowed) was also blocked at the same stage, confirming the allowlist was being enforced at all.

**Fix:** the allowed-domains list needs both the bare-apex and wildcard form for every domain the routine needs, including secondary sources (AXS, Eventbrite, SeatGeek, Bandsintown). Applied and confirmed working: the routine's first real run after the fix fetched 20 pages and produced a PR with real corrections, no `EGRESS_BLOCKED` failures.

**Verification status:** only Pour House and Music Farm domains were curl-tested end-to-end to confirm the original diagnosis. The rest of the venue domains are believed to need (and now have) the same fix by pattern, but individual confirmation across all 11 venues is still an open item beyond what showed up in the first post-fix PR (Pour House, Windjammer, Music Farm, NCC all appear to have worked based on that PR's contents; Royal American, Credit One, Firefly, and Charleston Music Hall's own site weren't individually confirmed one way or the other).

### Secondary-source bot detection is client-dependent (discovered 2026-09-09)

A third, separate pattern from testing AXS, Bandsintown, and Eventbrite directly from inside the routine's sandbox: AXS (for Charleston Music Hall) and Bandsintown (for both New Realm Brewing and Charleston Tin Roof) all returned genuine 403s from those sites' own servers when requested via curl from inside the routine's sandbox — confirmed via the proxy's own status log, which showed the tunnel succeeding and the block originating from the target site, not the proxy. The same URLs, requested via a different, interactive fetch tool used earlier in the project, returned clean, complete data with no block at all.

**What this means:** not a network-access or allowlist problem, and not fixable by editing the domain list. It's the sites' own bot-detection distinguishing between the routine's fetch client (resembling plain curl, presumably lacking browser-like headers/TLS fingerprint) and whatever client the interactive tool uses. Plausible inference, not confirmed against any vendor's documentation: ticketing/event platforms commonly run WAF-style bot protection (Akamai, PerimeterX, Cloudflare, or similar) that fingerprints requests below a "looks like a browser" threshold — consistent with what's observed, but the specific vendor for AXS or Bandsintown hasn't been confirmed.

**Practical implication:** AXS-for-CMH-pricing, Bandsintown-for-New-Realm, and Bandsintown-for-Tin-Roof are downgraded from "usable secondary source" to "confirmed to have real data, but not presently reachable by the routine's actual fetch mechanism." This differs from Firefly's page being genuinely dark, or New Realm's own captcha wall — the data exists and a fetch *can* reach it, just not from this client. Fixing it would need either the routine's fetch tool sending more browser-like headers (unconfirmed whether configurable) or a different fetch approach (e.g. browser automation).

### New Realm Brewing: dual failure mode (captcha AND JS-rendering, depending on client)

- **Via curl inside the routine's sandbox:** the events page returned an HTTP 202 with a SiteGround `sgcaptcha` bot-challenge response — confirmed via full verbose output showing the challenge redirect body and headers (`sg-captcha`, `x-robots-tag: noindex`).
- **Via a different fetch tool, same session:** the identical URL returned a clean 200 with no captcha — but also no actual event data. The page content is navigation, a 6-location switcher, and marketing copy; the calendar is very likely rendered client-side via an embedded widget (`app.teamdexter.com`, visible in a "Book your event!" iframe embed) that a static HTTP fetch won't execute.

**Conclusion:** regardless of which failure mode the routine's environment hits on a given run, no usable show data comes back from this URL either way — don't add it back to the routine's fetch strategy.

**Fallback sources (status as of 2026-09-09, after direct curl testing from inside the sandbox):**
- **Bandsintown** — genuine 403 from Bandsintown's own servers (confirmed via proxy log), matching what the actual scheduled routine run reported the same day — a corroborated finding, not a single test. Not usable inside the unattended routine unless a header/client change resolves the bot-detection block.
- **Eventbrite** — the curl test got a clean 200, no block. This conflicts with the same day's actual routine run, which described Eventbrite as unreachable alongside Bandsintown — an unresolved inconsistency (possibly imprecise routine summary language, possibly a genuine request difference). Before relying on Eventbrite in the routine, verify the actual response body contains real event data and isn't a JS-rendering shell (the research pass flagged this page as JS-rendered separately, which would make a 200 status misleading).
- **Unexplored lead:** the `app.teamdexter.com` embed might expose its own API or embeddable calendar endpoint — nobody has checked this yet.

### Secondary source research (AXS, Eventbrite, Bandsintown, Songkick, Dice, SeatGeek)

An Advanced Research task (2026-09-09) audited secondary event-data sources across all 11 tracked venues; full findings are in the delivered research artifact, summarized here with the caveat that several specific claims from this pass need direct-fetch verification before being trusted unattended (the Firefly "dark page" claim from this same pass was already disproven directly).

**Headline conclusions:**
- **AXS.com** has active, current pages for 8 of 11 venues (Music Farm, Charleston Music Hall, Windjammer, Firefly, Credit One, both NCC halls, Pour House) and is the strongest secondary source for this venue set.
- **Bandsintown** has some coverage for nearly every venue, reliable for existence/dates — never price. Watch for duplicate venue pages (Windjammer and Pour House both have more than one Bandsintown entity) — pin the specific venue ID rather than trusting the first search result.
- **Dice.fm has zero coverage of any tracked venue** — not worth checking going forward.
- **Songkick** is thin and fragments some venues (Pour House especially) across duplicate/stage-specific pages — demote to a tertiary fallback.
- **Eventbrite** only matters for New Realm and Charleston Pour House (organizer pages).

**Sourcing-priority nuance — AXS is not one flat tier:**
- At **Charleston Music Hall and North Charleston Coliseum & PAC**, AXS is a genuine co-primary/official seller (NCC's own FAQ names AXS alongside Ticketmaster) — belongs in the "official ticketing platform" tier for these two venues specifically.
- At **Music Farm, Windjammer, and Pour House**, AXS is a cross-check against an already-complete venue site — should not outrank the venue's own page.
- **Charleston Music Hall specifically:** AXS may show face-value pricing where Ticketmaster is bot-blocked for price capture. This remains the single highest-value *unverified* claim from the research pass — confirm with a direct fetch of a specific AXS/CMH event page before relying on it; as of 2026-09-09 AXS itself returned a 403 from the routine's sandbox client (see "Secondary-source bot detection" above), so this is currently blocked regardless of whether the underlying claim is true.
- **Credit One Stadium:** a research-pass claim that SeatGeek became the venue's exclusive official ticketer (May 2026) was checked directly on 2026-09-09 and found false — the venue was still on Ticketmaster/Seated. SeatGeek remains excluded everywhere for this venue set; no action needed.

**Known limitations of the research pass itself:** event counts are point-in-time and had already visibly drifted within the same session (Music Farm's AXS count moved ~44→37 between an early spot-check and the final report). AXS pages surface a resale "Marketplace" option alongside face-value tickets — capture only the primary/advance price line if AXS is used for pricing. Treat every specific claim in the report as needing a spot-check before being trusted unattended, per the Firefly precedent above.

### Riverfront Park festival sub-sources (added 2026-09-10)

Riverfront Park (`RFP`) hosts several independently-branded festivals with their own official sites, distinct from the general venue page:
- **Low Tide Festival** and **High Tide Festival** both live on the same official site, `hightidefestival.com` (a Shopify storefront) — Low Tide's own event/pass page is `hightidefestival.com/products/low-tide-2026-pass`-style URLs; check the homepage banner link if the exact slug is unknown. Confirmed reliable, venue/organizer-official tier.
- **Riverfront Revival** — official ticketing is Frontgate Tickets (`riverfrontrevival.frontgatetickets.com`). The lineup announcement itself is best-confirmed via corroborating local news coverage (WCIV/ABC News 4, CountryNow, etc. all independently reported the same 2026 lineup) rather than a single self-contained official press page — treat multi-outlet corroboration as a reasonable substitute for a single official source when one isn't readily fetchable, but note it explicitly rather than presenting it as venue-tier-sourced.
- **The Riverfront Park venue's own Instagram, `@theriverfrontpark`**, posts a monthly "What's Happening" flyer graphic with dates/times for its self-run community events (Jazz in the Park, Taco & Margarita Festival, National Night Out, etc.) — useful for the venue's own small/recurring events, though it's an image graphic, not fetchable text, so it requires the user to screenshot/upload it rather than a direct `web_fetch`.
- Full artist-lineup graphics posted on festival sites/socials are often images, not text — `web_fetch` only returns page text/metadata and cannot read text baked into an image. When a lineup is only available as a flyer graphic, ask the user to upload it rather than guessing from secondary text sources.

### Data-extraction techniques that worked

- Many venues print both advance and day-of prices directly in plain text on the listing page itself (e.g. Pour House's "PRICE: $15 – $20," the Windjammer's cornhole event's "$15 in advance | $20 at the door") — more reliable than fetching a separate ticketing platform; check the venue's own descriptive text first.
- Status labels are often already in the venue's own HTML: "LOW TIX," "Sold Out," "On Sale Soon" appear as plain text/link labels on Music Farm and Windjammer listings — no separate lookup needed, just read the label next to "Buy Tickets."
- Individual event pages sometimes work even when list pagination doesn't (NCC is the clean example) — worth trying a constructed/found individual page URL directly even after the list hits a wall.
- AXS venue pages are fetchable directly and expose an "N events" count plus a full list (`axs.com/venues/{id}/{slug}-tickets`) — always trust a direct fetch over an AXS search-result snippet (a CMH search snippet once returned "no events scheduled" while the same page, fetched directly, showed 82 events). AXS pages also surface a resale "Marketplace" option — capture only the primary/advance price line, never Marketplace, per the no-resale rule.

### Non-music exclusion — quick reference of what got filtered out

DJ nights/dance parties/raves, themed party nights with no booked act, podcast tapings, talk shows, dating/game shows, markets/vendor events, burlesque/variety revues, comedy specials, Broadway/theatre productions, sports (hockey, tennis), ice shows, and orchestral "Pops" tribute concerts (same reasoning as the classical exclusion). Signal words: DJ, Dance Party, Rave, Market, Podcast, Burlesque, POPS, or a real person's name with "Comedy"/"Tour" and no band. Applies equally to AXS listings, which mix in the same categories (confirmed at both Music Farm and Charleston Music Hall — e.g. "Kawaii Rave," "I Love RnB Party," "Serial Killers with Dr. Scott Bonn" lecture).

### Standing known issues (don't re-report every run unless something changes)

- **Charleston Music Hall & Music Farm face-value prices:** Ticketmaster blocks automated price capture; only resale prices were reachable for most CMH/MF shows and, per the sourcing rule, were not entered into the data. AXS shows the data via some clients but is bot-blocked via the routine's actual fetch mechanism — documented limitation, not something to re-verify every run (see "Secondary-source bot detection" above). Music Farm's own site + Ticketmaster remain the priority there.
- **The Yacht Club (Windjammer, Sep 12):** only a recurring-series price pattern was found ($15 adv/$20 DOS from a 2025 instance), not confirmed for the 2026 date — deliberately left unpriced.
- **Credit One Stadium ticketing platform:** resolved, false alarm — confirmed still Ticketmaster/Seated on 2026-09-09; no action needed.
- **New Realm Brewing coverage:** primary source unusable (dual failure mode). Bandsintown bot-blocked. Eventbrite tested clean via curl but conflicts with the same-day routine run reporting it unreachable — needs the routine's raw output checked to resolve the discrepancy, plus a check of whether the response body has real content. `teamdexter.com` embed lead still unexplored.
- **Charleston Tin Roof coverage:** Bandsintown fallback (previously treated as reliably working) is now confirmed bot-blocked from inside the routine's sandbox — same open status as CMH/New Realm.
- **Gaillard Center:** out of scope entirely (classical/orchestral programming).
- **Riverfront Revival 2026 Friday/Saturday artist split:** the full 17-act lineup is confirmed (multi-outlet corroboration, 2026-09-10), but the per-day breakdown is only sourced from an AXS listing covering 10 of the 17 acts (Fri: Gavin Adcock, BigXthaPlug, Charles Wesley Godwin; Sat: Darius Rucker, Old Dominion, Nelly, Chase Matthew, Trombone Shorty & Orleans Avenue, Austin Williams, Karley Scott Collins) — the other 7 acts aren't day-assigned anywhere found. `shows.json` stores this as one two-day entry (`d`/`e`) with the full lineup in `o`, flagged as partially-unverified per-day. Worth re-checking once the festival publishes its own daily set-time page (High Water's `daily-lineups` page is the model for what to look for).

**Windjammer date reliability:** this venue's own site has shown real, repeated date/stage mismatches against previously-stored data (10 separate corrections in one 2026-09-09 run) — not a one-off scrape error. Example: Swimming Pool Q's moved from Sep 17 to Sep 13; Winyah's two nights moved from Sep 18/19 to Sep 17/18, both fixed by trusting the venue's own site over existing data. Standing rule: when a venue's own site conflicts with what's already in `shows.json`, the venue's site wins — correct the data rather than flagging it as an open question, unless the conflict is itself ambiguous (e.g., two different venue-run pages disagree with each other). Any future Windjammer date/stage change is worth an independent re-fetch/verification (date badge + day-of-week + URL slug) before trusting it.

## Known open data issues

- **12 more Charleston Pour House shows still have the Jambase-link/placeholder-data problem** (Karina Rykman, the 13th, was fixed directly as the flagged example): LaMP (Oct 22), The Greyboy Allstars (Oct 23), Porch Light (Oct 25), Neal Francis (Oct 30), Tommy Prine (Nov 5), Satsang (Nov 7), SunSquabi (Nov 8), TAUK (Nov 13), The Fretliners (Nov 14), Deer Tick (Nov 15), Magnolia Boulevard (Nov 21), and "moe.phrey's" (Dec 4 and Dec 5 — likely a mistranscribed band name; the matching Jambase slug says "al-schnier," suggesting the actual act may be Al Schnier's solo/duo project rather than a band called "moe.phrey's" — worth double-checking against the venue's own page when this gets fixed). All 12 need the same treatment: find each show's real charlestonpourhouse.com event page and backfill `dr`, `sh`, `p`, `o`, `s`, and `u`.

## Outstanding action items

**Resolved, no further action needed:**
- Network egress allowlist fix — confirmed working by observation (the routine's first real run after the fix fetched 20 pages, produced a PR with real corrections, no `EGRESS_BLOCKED` failures).
- Credit One Stadium ticketing platform — confirmed still Ticketmaster/Seated, not SeatGeek; research-pass claim was wrong, routine doc corrected.
- worker.js corruption (PRs #3/#4) — rebuilt from known-good commit in PR #5; sanity-check CI step added to prevent recurrence.
- The 8 code-review findings from the 2026-09-10 project review (see Incident history above).
- **Low Tide Festival (Sept 12, 2026) and Riverfront Revival (Oct 9–10, 2026)** — both confirmed via official/multi-outlet sources and added to `shows.json` on 2026-09-10 (see "Riverfront Park festival sub-sources" above for how each was sourced).
- **"Jazz in the Park" / Pops-vs-hybrid-carve-out rule conflict** — resolved 2026-09-10; decision (exclude) and reasoning documented in the classical/orchestral exclusion section above.

**Not yet resolved:**
1. **AXS/Bandsintown bot detection** — AXS (for CMH pricing) and Bandsintown (for New Realm and Tin Roof) are confirmed reachable by some clients but bot-blocked by whatever fetch mechanism the routine actually uses. Not fixable via the domain allowlist. Worth investigating whether the routine's fetch tool can send browser-like headers, or whether this needs a different approach (e.g. browser automation).
2. **Eventbrite/New Realm discrepancy** — a direct curl test got a clean 200, but the same-day production routine run reported it unreachable. Needs the routine's raw output (not just its summary) checked, plus a check of whether the response body has real content or is JS-rendered.
3. **Spot-check remaining venue domains** against the corrected allowlist beyond what showed up in the first PR (Pour House, Windjammer, Music Farm, NCC appear to have worked) — Royal American, Credit One, Firefly, and Charleston Music Hall's own site weren't individually confirmed in the first run's summary.
4. **Decide whether to pursue the `teamdexter.com` embed lead** for New Realm — the one lead not yet tested at all.
5. **Confirm whether AXS shows face-value price for Charleston Music Hall** once the bot-detection block is resolved by some means (item 1) — try again from a different network context/client if possible.
6. **Turn on required PR review for `main`**, if not already in place — the CI sanity-check step catches the specific corruption class that happened once (duplicate function declarations) but doesn't replace human review for anything else.
7. **Riverfront Revival Friday/Saturday day-split** — currently sourced from AXS and only covers 10 of 17 acts; re-check once the festival publishes its own daily set-time page (see "Standing known issues" above).

## Repo notes

- `cowork-task-instructions.md` was rewritten from scratch in an earlier session.
