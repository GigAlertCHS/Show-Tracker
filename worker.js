// Lowcountry Show Tracker — backend Worker
// Handles: passwordless email-link sign-in, and per-user My Shows/Favorite Artists
// storage in KV.
//
// KV binding expected: SHOW_TRACKER_KV  (already set up in your Worker's Settings > Bindings)
//
// Environment variables/secrets this code looks for (set later, in Worker Settings > Variables):
//   RESEND_API_KEY       - your Resend API key (once you've created a Resend account)
//   RESEND_FROM_ADDRESS  - the "from" address Resend sends as, e.g. "tracker@yourdomain.com"
//   WORKER_BASE_URL       - optional override; defaults to this Worker's custom domain below
//
// Until RESEND_API_KEY is set, /api/auth/request-link runs in "test mode": instead of emailing the
// link, it returns the link directly in the JSON response so we can test the whole flow end-to-end
// before Resend is wired up. Once the key is set, it switches automatically to actually sending email.

const DEFAULT_WORKER_BASE_URL = 'https://api.chs.shownotice.com';
const DEFAULT_SITE_URL = 'https://chs.shownotice.com/';
const ALLOWED_ORIGIN = 'https://chs.shownotice.com';

// Real show ids (`showId()` below) are `venue|date|band-slug` — comfortably under 150
// chars even for the longest real band/event names currently in shows.json (~85 chars).
// Bounding both the length of an id and how many a user can accumulate keeps
// /api/star-show (which takes the id straight from an unauthenticated-by-anything-but-
// a-token query string) from being usable to grow one user's KV record without bound.
const MAX_SHOW_ID_LENGTH = 150;
const MAX_MY_SHOWS = 300;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const headers = corsHeaders();

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers });
    }

    try {
      if (path === '/api/auth/request-link' && request.method === 'POST') {
        return await handleRequestLink(request, env, headers);
      }
      if (path === '/api/auth/verify' && request.method === 'GET') {
        return await handleVerify(request, env, headers);
      }
      if (path === '/api/user/data' && request.method === 'GET') {
        return await handleGetUserData(request, env, headers);
      }
      if (path === '/api/user/data' && request.method === 'POST') {
        return await handleSaveUserData(request, env, headers);
      }
      if (path === '/api/unsubscribe' && request.method === 'GET') {
        return await handleUnsubscribe(request, env, headers);
      }
      if (path === '/api/star-show' && request.method === 'GET') {
        return await handleStarShow(request, env, headers);
      }
      if (path === '/api/digest-preview' && request.method === 'GET') {
        return await handleDigestPreview(request, env, headers);
      }
      if (path === '/api/test-send-digest-now' && request.method === 'GET') {
        return await handleTestSendDigestNow(request, env, headers);
      }
      if (path === '/api/report-conflicts' && request.method === 'POST') {
        return await handleReportConflicts(request, env, headers);
      }
      if (path === '/api/suggest-venue' && request.method === 'POST') {
        return await handleSuggestVenue(request, env, headers);
      }
      if (path === '/api/admin/stats' && request.method === 'GET') {
        return await handleAdminStats(request, env, headers);
      }
      if (path === '/api/subscribe' && request.method === 'POST') {
        return await handleSubscribe(request, env, headers);
      }
      // Called by Resend's servers directly, not a browser -- no CORS headers needed,
      // and the response body/shape doesn't matter to Resend beyond the status code.
      if (path === '/api/webhooks/resend' && request.method === 'POST') {
        return await handleResendWebhook(request, env);
      }
      return json({ error: 'Not found' }, 404, headers);
    } catch (err) {
      // Logged in full for our own debugging via Cloudflare's logs, but this catch-all
      // is reachable from any route by anyone — don't hand internal exception details
      // to an arbitrary caller.
      console.error('Unhandled error in fetch handler:', err);
      return json({ error: 'Server error' }, 500, headers);
    }
  },

  // Entry point the Cron Trigger calls once it's set up (not yet configured as of this
  // version — this just makes the code ready for when it is).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendDigestToAllSubscribers(env));
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json'
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status: status || 200, headers });
}

function isValidEmail(email) {
  // The shape check alone (something@something.something) is too permissive — it
  // technically allows <, >, and quote characters in the local part, which is part
  // of what made the stored-XSS issue reachable via the sign-in flow itself. Reject
  // those explicitly, on top of the shape check.
  if (typeof email !== 'string') return false;
  if (/[<>"'`]/.test(email)) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ---- Turnstile (bot protection on public forms) ----
// Fails open (skips the check) if TURNSTILE_SECRET_KEY isn't configured yet, so
// deploying the frontend and backend halves slightly out of order doesn't
// accidentally lock out sign-in — once the secret is set, verification is enforced.
async function getTurnstileSecretKey(env) {
  if (!env.TURNSTILE_SECRET_KEY) return null;
  if (typeof env.TURNSTILE_SECRET_KEY.get === 'function') {
    return await env.TURNSTILE_SECRET_KEY.get();
  }
  return env.TURNSTILE_SECRET_KEY;
}

async function verifyTurnstileToken(token, ip, secretKey) {
  if (!token) return false;
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: secretKey, response: token, remoteip: ip || '' })
    });
    const data = await res.json();
    return data.success === true;
  } catch (err) {
    console.error('Turnstile verification request failed:', err);
    return false;
  }
}

// ---- Sign-in link request ----
async function handleRequestLink(request, env, headers) {
  const body = await request.json().catch(() => null);
  const email = body && body.email ? String(body.email).trim().toLowerCase() : null;
  const turnstileToken = body && body.turnstileToken ? String(body.turnstileToken) : null;
  // Allowlist of exactly one value -- this is what lets handleVerify send an
  // admin.html-initiated sign-in back to admin.html instead of the main site,
  // without opening up an arbitrary-redirect target.
  const returnTo = body && body.returnTo === 'admin' ? 'admin' : null;

  if (!isValidEmail(email)) {
    return json({ error: 'A valid email address is required' }, 400, headers);
  }

  const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';

  const turnstileSecretKey = await getTurnstileSecretKey(env);
  if (turnstileSecretKey) {
    const verified = await verifyTurnstileToken(turnstileToken, clientIp, turnstileSecretKey);
    if (!verified) {
      return json({ error: 'Verification failed — please try again' }, 403, headers);
    }
  }

  // Per-IP volume limit: the per-email limit below stops repeat-spamming ONE address,
  // but doesn't stop someone scripting requests across many different strangers'
  // addresses. Cap total requests per source IP too — 10 per hour is generous for any
  // real person signing up themselves or inviting a few friends, but blocks a script.
  // KNOWN LIMITATION: this read-then-write is not atomic, and KV is eventually
  // consistent, so a burst of simultaneous requests can all read the same count
  // before any write lands and collectively overshoot the cap. KV has no native
  // atomic increment; a hard guarantee would need Durable Objects. The per-email
  // limit below is the tighter control (one address can't be spammed regardless),
  // and Turnstile blocks scripted abuse ahead of this, so this is treated as a
  // best-effort volume brake rather than a strict cap. Revisit with a Durable
  // Object if this endpoint ever gets abused in practice.
  const ipRateLimitKey = `ratelimit-ip:${clientIp}`;
  const ipRequestCountRaw = await env.SHOW_TRACKER_KV.get(ipRateLimitKey);
  const ipRequestCount = ipRequestCountRaw ? parseInt(ipRequestCountRaw, 10) : 0;
  if (ipRequestCount >= 10) {
    return json({ error: 'Too many sign-in requests from this connection — please try again later' }, 429, headers);
  }
  await env.SHOW_TRACKER_KV.put(ipRateLimitKey, String(ipRequestCount + 1), { expirationTtl: 3600 });

  // Rate limit: at most one link request per email per 60 seconds, so a stranger
  // can't spam someone's inbox with sign-in emails.
  const rateLimitKey = `ratelimit:${email}`;
  const alreadyRequested = await env.SHOW_TRACKER_KV.get(rateLimitKey);
  if (alreadyRequested) {
    return json({ error: 'Please wait a bit before requesting another link' }, 429, headers);
  }
  await env.SHOW_TRACKER_KV.put(rateLimitKey, '1', { expirationTtl: 60 });

  const token = crypto.randomUUID();
  await env.SHOW_TRACKER_KV.put(
    `token:${token}`,
    JSON.stringify(returnTo ? { email, returnTo } : { email }),
    { expirationTtl: 900 } // link is valid for 15 minutes
  );

  const baseUrl = env.WORKER_BASE_URL || DEFAULT_WORKER_BASE_URL;
  const magicLink = `${baseUrl}/api/auth/verify?token=${token}`;

  const resendApiKey = await getResendApiKey(env);
  if (resendApiKey) {
    try {
      await sendMagicLinkEmail(email, magicLink, env, resendApiKey);
      return json({ ok: true, message: 'Check your email for a sign-in link' }, 200, headers);
    } catch (err) {
      // Full detail is logged for our own debugging, but not handed to whoever's
      // calling this public, unauthenticated endpoint — they just need to know it
      // failed, not the internals of how the email provider responded.
      console.error('sendMagicLinkEmail failed:', err);
      return json({ ok: false, error: 'Failed to send the email — please try again in a moment' }, 502, headers);
    }
  }

  // Test mode: no Resend key configured yet, so hand back the link directly.
  return json({ ok: true, testMode: true, magicLink }, 200, headers);
}

// Secrets Store bindings expose an async .get() method rather than being a plain
// string like classic Worker secrets — this handles either, so it works regardless
// of which binding type ends up configured.
async function getResendApiKey(env) {
  if (!env.RESEND_API_KEY) return null;
  if (typeof env.RESEND_API_KEY.get === 'function') {
    return await env.RESEND_API_KEY.get();
  }
  return env.RESEND_API_KEY;
}

// ---- Resend webhooks (digest email delivered/opened/clicked -> admin stats) ----
// Fails open (skips verification) if RESEND_WEBHOOK_SECRET isn't configured yet, same
// bootstrapping pattern as Turnstile above -- lets this endpoint exist and be pointed
// at from Resend's dashboard before the signing secret is wired up on this side, without
// silently accepting anything once it IS configured.
async function getResendWebhookSecret(env) {
  if (!env.RESEND_WEBHOOK_SECRET) return null;
  if (typeof env.RESEND_WEBHOOK_SECRET.get === 'function') {
    return await env.RESEND_WEBHOOK_SECRET.get();
  }
  return env.RESEND_WEBHOOK_SECRET;
}

async function getCloudflareAnalyticsToken(env) {
  if (!env.CLOUDFLARE_ANALYTICS_TOKEN) return null;
  if (typeof env.CLOUDFLARE_ANALYTICS_TOKEN.get === 'function') {
    return await env.CLOUDFLARE_ANALYTICS_TOKEN.get();
  }
  return env.CLOUDFLARE_ANALYTICS_TOKEN;
}

// Requests and page views are plain daily counts, safe to sum across days into a
// window. Unique visitors deliberately isn't included here: Cloudflare's uniq counts
// are HyperLogLog-estimated per day, and summing per-day estimates across a window
// overcounts (the same visitor on two days would count twice) -- there's no accurate
// way to turn daily uniques into a weekly/monthly one without querying that whole
// range as its own single bucket, which httpRequests1dGroups (daily-grouped, as the
// name says) doesn't support. Cloudflare's own Web Analytics dashboard remains the
// place to look for an accurate unique-visitor figure.
async function fetchCloudflareZoneAnalytics(env) {
  const token = await getCloudflareAnalyticsToken(env);
  const zoneTag = env.CLOUDFLARE_ZONE_ID;
  if (!token || !zoneTag) return { error: 'Not configured yet' };

  // Cloudflare caps a single query's time range at 52w1d1h. A naive 365-day span trips
  // that (confirmed against a live error: "...spans 52w1d18h56m..." for exactly this
  // calculation) once date-truncating `since` down to midnight is factored in -- 358
  // days leaves a safe multi-day margin under the cap without meaningfully changing
  // what "the last year" shows.
  const until = new Date().toISOString().slice(0, 10);
  const since = new Date(Date.now() - 358 * 86400000).toISOString().slice(0, 10);

  const query = `
    query ZoneAnalytics($zoneTag: String!, $since: String!, $until: String!) {
      viewer {
        zones(filter: { zoneTag: $zoneTag }) {
          httpRequests1dGroups(
            limit: 400
            filter: { date_geq: $since, date_leq: $until }
            orderBy: [date_ASC]
          ) {
            dimensions { date }
            sum { requests pageViews }
          }
        }
      }
    }
  `;

  let res;
  try {
    res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { zoneTag, since, until } })
    });
  } catch (err) {
    return { error: `Request failed: ${err.message}` };
  }

  const body = await res.json().catch(() => null);
  if (!res.ok || !body) {
    return { error: `Cloudflare API responded ${res.status}` };
  }
  if (body.errors && body.errors.length) {
    return { error: body.errors.map(e => e.message).join('; ') };
  }

  const zones = body.data && body.data.viewer && body.data.viewer.zones;
  const rows = (zones && zones[0] && zones[0].httpRequests1dGroups) || [];

  const now = Date.now();
  const cutoffs = { week: now - 7 * 86400000, month: now - 30 * 86400000, year: now - 365 * 86400000 };
  const requests = { week: 0, month: 0, year: 0, all: 0 };
  const pageViews = { week: 0, month: 0, year: 0, all: 0 };
  rows.forEach(row => {
    const ts = new Date(row.dimensions.date + 'T12:00:00').getTime();
    const r = (row.sum && row.sum.requests) || 0;
    const p = (row.sum && row.sum.pageViews) || 0;
    requests.all += r; pageViews.all += p;
    if (ts >= cutoffs.year) { requests.year += r; pageViews.year += p; }
    if (ts >= cutoffs.month) { requests.month += r; pageViews.month += p; }
    if (ts >= cutoffs.week) { requests.week += r; pageViews.week += p; }
  });

  return { requests, pageViews };
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// timingSafeEqual() is defined once, further down this file (shared with
// handleReportConflicts' token check).

// Resend delivers webhooks via Svix, signed the same way Svix signs for every one of
// its customers: HMAC-SHA256 over "{svix-id}.{svix-timestamp}.{raw body}", keyed by the
// base64 portion of the whsec_... signing secret Resend's dashboard shows when you
// create the webhook endpoint. svix-signature can carry several space-separated
// "v1,<sig>" candidates (e.g. during secret rotation) -- valid if any match.
async function verifyResendWebhookSignature(rawBody, headers, secret) {
  const svixId = headers.get('svix-id');
  const svixTimestamp = headers.get('svix-timestamp');
  const svixSignature = headers.get('svix-signature');
  if (!svixId || !svixTimestamp || !svixSignature) return false;

  const secretBytes = base64ToBytes(secret.replace(/^whsec_/, ''));
  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const key = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedContent));
  const expectedSig = bytesToBase64(new Uint8Array(sigBuffer));

  const candidates = svixSignature.split(' ').map(part => part.split(',')[1]).filter(Boolean);
  return candidates.some(sig => timingSafeEqual(sig, expectedSig));
}

// Same read-then-write caveat as the IP rate limiter elsewhere in this file: KV has no
// atomic increment, so concurrent webhook deliveries can race and undercount slightly.
// Treated as a best-effort approximate counter, not an exact one -- fine for "roughly
// how many opens/clicks," not something billing or alerting should depend on.
async function incrementCounter(env, key) {
  const current = await env.SHOW_TRACKER_KV.get(key);
  const next = (current ? parseInt(current, 10) : 0) + 1;
  await env.SHOW_TRACKER_KV.put(key, String(next));
}

async function handleResendWebhook(request, env) {
  const rawBody = await request.text();

  const secret = await getResendWebhookSecret(env);
  if (secret) {
    const valid = await verifyResendWebhookSignature(rawBody, request.headers, secret);
    if (!valid) return new Response('Invalid signature', { status: 401 });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (err) {
    return new Response('Bad payload', { status: 400 });
  }

  const tags = (payload.data && payload.data.tags) || [];
  const isDigest = tags.some(t => t.name === 'type' && t.value === 'digest');
  if (isDigest) {
    // Bucketed by day (not one running total) so handleAdminStats can sum a
    // week/month/year/all window over these, the same as it does for subscribers/
    // suggestions/unsubscribes -- see windowCounts()/digestStatsWindow().
    const today = new Date().toISOString().slice(0, 10);
    if (payload.type === 'email.delivered') await incrementCounter(env, `digest-stats:delivered:${today}`);
    else if (payload.type === 'email.opened') await incrementCounter(env, `digest-stats:opened:${today}`);
    else if (payload.type === 'email.clicked') await incrementCounter(env, `digest-stats:clicked:${today}`);
  }

  return new Response('ok', { status: 200 });
}

async function sendMagicLinkEmail(email, link, env, resendApiKey) {
  const from = env.RESEND_FROM_ADDRESS || 'Lowcountry Show Tracker <shows@gigalertchs.com>';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from,
      to: email,
      subject: 'Your Lowcountry Show Tracker sign-in link',
      html: `<p>Click below to sign in to your Show Tracker account:</p>
             <p><a href="${link}">${link}</a></p>
             <p>This link expires in 15 minutes. If you didn't request this, you can ignore it.</p>`
    })
  });

  if (!res.ok) {
    // Previously this failure was silently swallowed and the caller always got told
    // "check your email" regardless of what actually happened. Surface the real
    // reason instead, so a bad from-address, invalid key, etc. is actually visible.
    const errBody = await res.text().catch(() => '');
    throw new Error(`Resend API responded ${res.status}: ${errBody}`);
  }
}

// ---- Sign-in link verification ----
// Redirects back to the site with the session attached, rather than showing raw JSON —
// a real visitor clicking this link from their inbox needs to land back in the app.
async function handleVerify(request, env, headers) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  const siteUrl = env.SITE_URL || DEFAULT_SITE_URL;

  if (!token) {
    return Response.redirect(`${siteUrl}?authError=missing_token`, 302);
  }

  const raw = await env.SHOW_TRACKER_KV.get(`token:${token}`);
  if (!raw) {
    return Response.redirect(`${siteUrl}?authError=invalid_or_expired`, 302);
  }

  const { email, returnTo } = JSON.parse(raw);
  await env.SHOW_TRACKER_KV.delete(`token:${token}`); // one-time use

  const sessionToken = crypto.randomUUID();
  await env.SHOW_TRACKER_KV.put(
    `session:${sessionToken}`,
    JSON.stringify({ email }),
    { expirationTtl: 60 * 60 * 24 * 30 } // session lasts 30 days
  );

  // Signing in also subscribes you to the periodic digest, unless you've already
  // unsubscribed before (in which case we leave that choice alone rather than
  // silently re-subscribing someone who opted out).
  await ensureSubscribed(email, env);

  // returnTo === 'admin' sends an admin.html-initiated sign-in back there instead of
  // the main site -- admin.html reads ?session=/&email= off its own URL the same way
  // index.html does. siteUrl always ends in '/' (see DEFAULT_SITE_URL/wrangler.toml).
  const landingUrl = returnTo === 'admin' ? `${siteUrl}admin.html` : siteUrl;
  const redirectUrl = `${landingUrl}?session=${encodeURIComponent(sessionToken)}&email=${encodeURIComponent(email)}`;
  return Response.redirect(redirectUrl, 302);
}

async function ensureSubscribed(email, env) {
  const existing = await env.SHOW_TRACKER_KV.get(`subscriber:${email}`);
  if (existing) return; // already actively subscribed

  // The bug this fixes: unsubscribing used to just delete the subscriber record,
  // leaving no trace of the choice — so the very next sign-in would silently
  // re-subscribe someone who'd deliberately opted out. Checking this separate,
  // permanent marker is what actually makes an unsubscribe stick.
  const previouslyUnsubscribed = await env.SHOW_TRACKER_KV.get(`unsubscribed:${email}`);
  if (previouslyUnsubscribed) return;

  const unsubscribeToken = crypto.randomUUID();
  await env.SHOW_TRACKER_KV.put(`subscriber:${email}`, JSON.stringify({ subscribedAt: Date.now(), unsubscribeToken }));
  await env.SHOW_TRACKER_KV.put(`unsubtoken:${unsubscribeToken}`, email);
}

// Lets someone explicitly (re)subscribe — the only path back in for someone who
// previously unsubscribed, now that sign-in alone deliberately won't re-subscribe them.
async function handleSubscribe(request, env, headers) {
  const email = await getEmailFromSession(request, env);
  if (!email) return json({ error: 'Not signed in' }, 401, headers);

  const existing = await env.SHOW_TRACKER_KV.get(`subscriber:${email}`);
  if (existing) {
    return json({ ok: true, message: "You're already subscribed." }, 200, headers);
  }

  const unsubscribeToken = crypto.randomUUID();
  await env.SHOW_TRACKER_KV.put(`subscriber:${email}`, JSON.stringify({ subscribedAt: Date.now(), unsubscribeToken }));
  await env.SHOW_TRACKER_KV.put(`unsubtoken:${unsubscribeToken}`, email);
  // Explicitly opting back in overrides any prior unsubscribe — clear that marker so
  // it doesn't linger and confuse anything later.
  await env.SHOW_TRACKER_KV.delete(`unsubscribed:${email}`);

  return json({ ok: true, message: "You're subscribed! You'll get the next digest." }, 200, headers);
}

async function handleUnsubscribe(request, env, headers) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  const confirmed = url.searchParams.get('confirm') === '1';
  const htmlHeaders = { 'Content-Type': 'text/html' };

  if (!token) {
    return new Response('<p>Missing unsubscribe token.</p>', { status: 400, headers: htmlHeaders });
  }

  const email = await env.SHOW_TRACKER_KV.get(`unsubtoken:${token}`);
  if (!email) {
    return new Response('<p>This unsubscribe link is invalid or has already been used.</p>', { status: 400, headers: htmlHeaders });
  }

  // Require an explicit click past a summary page rather than unsubscribing on a bare
  // GET — same reasoning as /api/star-show's confirm step: mail-security scanners and
  // link-prefetching clients auto-GET links straight out of an email body, which would
  // otherwise silently unsubscribe someone before they ever open the message.
  if (!confirmed) {
    const confirmUrl = `${url.origin}/api/unsubscribe?token=${encodeURIComponent(token)}&confirm=1`;
    return new Response(
      `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
      <body style="margin:0; padding:0; background-color:#0d0f16; font-family:Arial, Helvetica, sans-serif; color:#eee9db;">
      <div style="max-width:480px; margin:60px auto; text-align:center; padding:24px;">
        <div style="font-size:15px; line-height:1.5; margin-bottom:20px;">Unsubscribe <strong>${escapeHtml(maskEmail(email))}</strong> from the Lowcountry Show Tracker digest?</div>
        <a href="${confirmUrl}" style="display:inline-block; padding:12px 28px; font-size:14px; font-weight:bold; color:#12141c; background-color:#f0a83c; border-radius:6px; text-decoration:none;">Yes, unsubscribe</a>
      </div>
      </body></html>`,
      { status: 200, headers: htmlHeaders }
    );
  }

  await env.SHOW_TRACKER_KV.delete(`subscriber:${email}`);
  await env.SHOW_TRACKER_KV.delete(`unsubtoken:${token}`);
  // This is the actual fix — without this, nothing remembers the unsubscribe ever
  // happened once the record above is deleted, so the next sign-in silently
  // re-subscribes them. No expiry: this should stick until they explicitly resubscribe.
  await env.SHOW_TRACKER_KV.put(`unsubscribed:${email}`, JSON.stringify({ unsubscribedAt: Date.now() }));

  return new Response(
    `<p>You've been unsubscribed from the Lowcountry Show Tracker digest. Your My Shows list and Favorite Artists are untouched — you just won't get the periodic email anymore. You can re-subscribe anytime by signing in again.</p>`,
    { status: 200, headers: htmlHeaders }
  );
}

// Shows only the first character of the local part in confirmation pages, so a shared
// screen or a browser history entry doesn't expose someone else's full email address.
function maskEmail(email) {
  const atIndex = email.indexOf('@');
  if (atIndex <= 1) return email;
  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex);
  return local[0] + '*'.repeat(Math.max(local.length - 1, 3)) + domain;
}

// One-click "add to My Shows" link from the digest email. Reuses the subscriber's
// existing unsubscribe token as the auth credential (same trust level: whoever holds
// that token controls this subscriber's My Shows list already, via unsubscribe), so no
// new token type is needed. Requires an explicit confirm=1 click after a summary page —
// email clients and link scanners sometimes GET links automatically, which would
// otherwise star shows without the recipient ever clicking anything.
async function handleStarShow(request, env, headers) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  const showIdParam = url.searchParams.get('show');
  const confirmed = url.searchParams.get('confirm') === '1';
  const siteUrl = env.SITE_URL || DEFAULT_SITE_URL;
  const baseUrl = env.WORKER_BASE_URL || DEFAULT_WORKER_BASE_URL;
  const htmlHeaders = { 'Content-Type': 'text/html' };

  if (!token || !showIdParam) {
    return new Response('<p>This link is missing required information.</p>', { status: 400, headers: htmlHeaders });
  }
  if (showIdParam.length > MAX_SHOW_ID_LENGTH) {
    return new Response('<p>That link is malformed.</p>', { status: 400, headers: htmlHeaders });
  }

  const email = await env.SHOW_TRACKER_KV.get(`unsubtoken:${token}`);
  if (!email) {
    return new Response('<p>This link is invalid or has expired. Sign in on the site to manage your My Shows list instead.</p>', { status: 400, headers: htmlHeaders });
  }

  if (!confirmed) {
    const confirmUrl = `${baseUrl}/api/star-show?show=${encodeURIComponent(showIdParam)}&token=${encodeURIComponent(token)}&confirm=1`;
    return new Response(
      `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
      <body style="margin:0; padding:0; background-color:#0d0f16; font-family:Arial, Helvetica, sans-serif; color:#eee9db;">
      <div style="max-width:480px; margin:60px auto; text-align:center; padding:24px;">
        <div style="font-size:15px; line-height:1.5; margin-bottom:20px;">Add this show to My Shows for <strong>${escapeHtml(maskEmail(email))}</strong>?</div>
        <a href="${confirmUrl}" style="display:inline-block; padding:12px 28px; font-size:14px; font-weight:bold; color:#12141c; background-color:#f0a83c; border-radius:6px; text-decoration:none;">Yes, add it</a>
        <div style="margin-top:20px;"><a href="${siteUrl}" style="color:#9599ad; font-size:13px; text-decoration:underline;">Not you? Go to the site instead</a></div>
      </div>
      </body></html>`,
      { status: 200, headers: htmlHeaders }
    );
  }

  const raw = await env.SHOW_TRACKER_KV.get(`user:${email}`);
  const data = raw ? JSON.parse(raw) : { myShows: [], favorites: [], createdAt: Date.now() };
  if (!Array.isArray(data.myShows)) data.myShows = [];
  if (!data.myShowsAddedAt || typeof data.myShowsAddedAt !== 'object') data.myShowsAddedAt = {};
  if (!data.myShows.includes(showIdParam) && data.myShows.length < MAX_MY_SHOWS) {
    data.myShows.push(showIdParam);
    data.myShowsAddedAt[showIdParam] = Date.now();
    await env.SHOW_TRACKER_KV.put(`user:${email}`, JSON.stringify(data));
  }
  return new Response(
    `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
    <body style="margin:0; padding:0; background-color:#0d0f16; font-family:Arial, Helvetica, sans-serif; color:#eee9db;">
    <div style="max-width:480px; margin:60px auto; text-align:center; padding:24px;">
      <div style="font-size:32px; color:#e0c46a; margin-bottom:12px;">&#9733;</div>
      <p style="font-size:15px; line-height:1.5;">Added to your My Shows list.</p>
      <a href="${siteUrl}" style="color:#f0a83c; font-size:14px; text-decoration:none; font-weight:bold;">View My Shows &rarr;</a>
    </div>
    </body></html>`,
    { status: 200, headers: htmlHeaders }
  );
}

async function getEmailFromSession(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const sessionToken = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!sessionToken) return null;

  const raw = await env.SHOW_TRACKER_KV.get(`session:${sessionToken}`);
  if (!raw) return null;
  return JSON.parse(raw).email;
}

// ---- User data (My Shows / Favorite Artists) ----
// Wire format and KV-stored shape were renamed from the old {watchlist, favorites}
// to {myShows, favorites} alongside the site's own rename, while usage was still low
// enough that there was no meaningful existing data to migrate.
async function handleGetUserData(request, env, headers) {
  const email = await getEmailFromSession(request, env);
  if (!email) return json({ error: 'Not signed in' }, 401, headers);

  const raw = await env.SHOW_TRACKER_KV.get(`user:${email}`);
  const data = raw ? JSON.parse(raw) : { myShows: [], favorites: [] };
  return json({ ok: true, data }, 200, headers);
}

async function handleSaveUserData(request, env, headers) {
  const email = await getEmailFromSession(request, env);
  if (!email) return json({ error: 'Not signed in' }, 401, headers);

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return json({ error: 'Invalid request body' }, 400, headers);

  // Only persist the fields we expect, in the shape we expect. Favorites specifically
  // had no per-item validation before — any string of any length was accepted, which
  // is part of what made the stored-XSS issue in admin.html exploitable via this
  // endpoint. Cap length and reject HTML-unsafe characters as defense in depth,
  // even though the real fix is escaping on display (already done in admin.html).
  // myShows gets the same length cap (real ids are well under it, see MAX_SHOW_ID_LENGTH)
  // plus an array-size cap, so a client can't grow one user's KV record without bound.
  const isSafeFavorite = (f) => typeof f === 'string' && f.trim().length > 0 && f.length <= 100 && !/[<>]/.test(f);
  const isSafeShowId = (id) => typeof id === 'string' && id.length > 0 && id.length <= MAX_SHOW_ID_LENGTH;
  const myShows = Array.isArray(body.myShows) ? body.myShows.filter(isSafeShowId).slice(0, MAX_MY_SHOWS) : [];
  const favorites = Array.isArray(body.favorites) ? body.favorites.filter(isSafeFavorite).slice(0, MAX_MY_SHOWS) : [];

  // This endpoint replaces the whole record on every save (the client always sends its
  // full current list, not a diff) -- myShows/favorites themselves stay plain string
  // arrays exactly as index.html has always read/written them, so none of that code
  // needed to change. What's new here is a *separate* per-item "when was this added"
  // map, used only for the admin panel's week/month/year/all breakdowns: an id/name
  // already in the previous save keeps its original timestamp, anything new gets one
  // now, and anything dropped from the array just falls out of the map on its own.
  const raw = await env.SHOW_TRACKER_KV.get(`user:${email}`);
  const existing = raw ? JSON.parse(raw) : null;
  const prevShowsAt = (existing && existing.myShowsAddedAt) || {};
  const prevFavsAt = (existing && existing.favoritesAddedAt) || {};
  const now = Date.now();
  const myShowsAddedAt = {};
  myShows.forEach(id => { myShowsAddedAt[id] = prevShowsAt[id] || now; });
  const favoritesAddedAt = {};
  favorites.forEach(name => { favoritesAddedAt[name] = prevFavsAt[name] || now; });

  const data = {
    createdAt: (existing && existing.createdAt) || now,
    myShows,
    favorites,
    myShowsAddedAt,
    favoritesAddedAt
  };
  await env.SHOW_TRACKER_KV.put(`user:${email}`, JSON.stringify(data));
  return json({ ok: true }, 200, headers);
}

// ---- Digest email: pulling real data, personalizing, and sending ----

// Mirrors the equivalent function in the site's own index.html exactly (same field
// order). Keeping them identical is what makes a show's id match consistently between
// the site and this Worker — the digest email's My Shows/Added-This-Week personalization
// and the star-show link both depend on ids computed here lining up with ids the site
// itself generated when the subscriber favorited/starred a show — if one side's version
// of this function ever changes, the other needs the same change, or matching will
// quietly diverge.
function showId(s) {
  return [s.v, s.d, s.b].join('|').toLowerCase().replace(/\s+/g, '_');
}
function isUnknownTime(t) {
  return !t || /see ticket link|tba|^—$/i.test(t.trim());
}

async function fetchShowData(env) {
  const siteUrl = env.SITE_URL || DEFAULT_SITE_URL;
  const res = await fetch(new URL('shows.json', siteUrl).toString(), { cf: { cacheTtl: 300 } });
  if (!res.ok) throw new Error(`Failed to fetch shows.json: ${res.status}`);
  return await res.json(); // { dataUpdatedAt, venues, shows }
}

// Every upcoming show goes in the digest — no cutoff on how far out. The only
// filtering is dropping shows more than 1 day in the past, same rule the site itself
// uses, so the email never lists something that's already happened.
function upcomingShows(shows) {
  const cutoff = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return shows
    .filter(s => (s.e || s.d) >= cutoff)
    .sort((a, b) => a.d.localeCompare(b.d));
}

function fmtShortDate(iso) {
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// Builds the actual email-safe HTML (tables, inline styles — no JS/Grid/Flexbox, since
// Outlook strips those) for one subscriber, using real show data and their real
// My Shows/Favorite Artists. Visual structure matches the previously-approved preview.
//
// `baseUrl`/`myShowIds`/`starToken` drive the personalized "My Shows" section and the
// one-click star link on every card: `starToken` is the subscriber's own unsubscribe
// token (reused as auth for /api/star-show, see handleStarShow), and is only passed in
// by real sends/previews that have a real subscriber record — callers without one (e.g.
// a future test path) can omit it and the star link is simply left off each card.
function buildDigestEmailHTML({ shows, venues, unsubscribeLink, siteUrl, baseUrl, myShowIds = [], starToken = null }) {
  const upcoming = upcomingShows(shows);

  // "Added This Week" — genuinely new shows (the "added" field, stamped when a show
  // is first added to the data), not shows-happening-this-week. This is deliberately
  // NOT personalized in the same way My Shows is — every subscriber sees the same
  // new-additions list, just with their own star state on each card.
  const recentCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const recentlyAddedShows = upcoming.filter(s => s.added && s.added >= recentCutoff);
  const recentlyAddedIds = new Set(recentlyAddedShows.map(showId));

  // My Shows gets its own top section pulled out of the normal chronological flow, so
  // a subscriber's starred shows are impossible to miss even in a long digest.
  const myShowsUpcoming = upcoming.filter(s => myShowIds.includes(showId(s)));
  const myShowsIdSet = new Set(myShowsUpcoming.map(showId));
  const otherShows = upcoming.filter(s => !recentlyAddedIds.has(showId(s)) && !myShowsIdSet.has(showId(s)));

  // Empty until a real starToken is provided (see the function doc comment above).
  function starLinkHtml(s) {
    if (!starToken) return '';
    const id = showId(s);
    const already = myShowIds.includes(id);
    const href = `${baseUrl}/api/star-show?show=${encodeURIComponent(id)}&token=${encodeURIComponent(starToken)}`;
    return `<a href="${href}" style="text-decoration:none; font-size:16px; color:${already ? '#e0c46a' : '#4a4e5e'};">${already ? '&#9733;' : '&#9734;'}</a>`;
  }

  // One shared card renderer for both sections — matches the site's actual card
  // layout (dark time-block on the left, amber band name, teal price accent, stage
  // name on its own line) using nested tables, since table-based layout is what
  // actually renders reliably across email clients (Outlook especially doesn't
  // support flexbox/grid the way browsers do).
  function showRowHtml(s, isFavorite) {
    const venue = venues[s.v] || { name: s.v };
    const showKnown = !isUnknownTime(s.sh);
    const doorsKnown = !isUnknownTime(s.dr);

    let timeBlockInner;
    if (!showKnown && !doorsKnown) {
      timeBlockInner = `<div style="font-family:Georgia, 'Times New Roman', serif; font-size:15px; color:#f0a83c; line-height:1.1;">Time</div><div style="font-size:9px; color:#9599ad; letter-spacing:1px; margin-top:2px;">TBD</div>`;
    } else {
      const showLine = showKnown ? `<div style="font-family:Georgia, 'Times New Roman', serif; font-size:17px; color:#f0a83c; line-height:1.1;">${escapeHtml(s.sh)}</div><div style="font-size:9px; color:#9599ad; letter-spacing:1px; margin-top:2px;">SHOW</div>` : '';
      const doorsLine = doorsKnown ? `<div style="font-family:Georgia, 'Times New Roman', serif; font-size:14px; color:#eee9db; line-height:1.1; margin-top:${showKnown ? '6px' : '0'};">${escapeHtml(s.dr)}</div><div style="font-size:9px; color:#9599ad; letter-spacing:1px; margin-top:2px;">DOORS</div>` : '';
      timeBlockInner = showLine + doorsLine;
    }

    let priceOrTix;
    // shows.json is now written by an automated agent scraping venue sites, so URLs
    // from it are no longer fully trusted: restrict to http(s) and escape before
    // putting them in an href, same as the site itself does.
    const rawTicketUrl = String(s.u || venue.site || '').trim();
    const ticketUrl = /^https?:\/\//i.test(rawTicketUrl) ? escapeHtml(rawTicketUrl) : '';
    // Mirrors the site's own logic in index.html's priceOrTicketsHTML: Sold Out always
    // wins over price/tickets (nothing to buy, so a link would be misleading — and,
    // like the site, not a link since none of the venues' platforms have waitlist
    // support); Low Tix stays a working link since it's still purchasable.
    if (s.soldOut) {
      priceOrTix = '<span style="color:#c96a6a; font-weight:bold;">Sold Out</span>';
    } else if (s.lowTix) {
      priceOrTix = ticketUrl ? `<a href="${ticketUrl}" style="color:#e0c46a; font-weight:bold; text-decoration:none;">Low Tix</a>` : '<span style="color:#e0c46a; font-weight:bold;">Low Tix</span>';
    } else {
      // `p` is the advance price, `dop` is the optional day-of price, and day-of only
      // applies once the show's actual date has arrived (relevant if a digest happens
      // to send on the same day as a show).
      const todayStr = new Date().toISOString().slice(0, 10);
      const isShowDay = todayStr === s.d;
      const effectivePrice = (isShowDay && typeof s.dop === 'number') ? s.dop : s.p;
      if (typeof effectivePrice === 'number') {
        const label = effectivePrice === 0 ? 'Free' : `$${Math.round(effectivePrice)}`;
        priceOrTix = ticketUrl ? `<a href="${ticketUrl}" style="color:#4fd1b0; text-decoration:none;">${label}</a>` : label;
      } else {
        priceOrTix = ticketUrl ? `<a href="${ticketUrl}" style="color:#4fd1b0; text-decoration:none;">Tickets</a>` : '';
      }
    }

    const openerLine = s.o ? `<div style="font-size:12px; color:#9599ad; margin-top:3px;">w/ ${escapeHtml(s.o)}</div>` : '';
    const leftBorder = isFavorite ? 'border-left:3px solid #e0c46a;' : '';

    // Table-based two-column layout (not flexbox, which doesn't render reliably in
    // email clients like Outlook) — a fixed-width first column makes the venue name
    // and stage name line up at the same horizontal position, matching the site.
    const venueStageTable = `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:5px;">
        <tr>
          <td width="56" valign="top" style="font-size:12px; color:#c9cddb; white-space:nowrap;">${priceOrTix ? priceOrTix + ' &middot;' : ''}</td>
          <td style="font-size:12px; color:#c9cddb;">${escapeHtml(venue.name)}</td>
        </tr>
        ${s.s ? `<tr>
          <td width="56"></td>
          <td style="font-size:11.5px; color:#9599ad; font-style:italic; padding-top:2px;">${escapeHtml(s.s)}</td>
        </tr>` : ''}
      </table>`;

    return `
      <tr><td style="padding-bottom:8px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#1b1e2a; border:1px solid #2c3040; border-radius:8px; ${leftBorder}">
          <tr>
            <td width="64" valign="middle" align="center" style="background-color:#12141c; padding:10px 6px; border-radius:8px 0 0 8px;">
              ${timeBlockInner}
            </td>
            <td style="padding:10px 14px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
                <td style="font-size:11px; color:#9599ad; letter-spacing:0.5px;">${fmtShortDate(s.d)}</td>
                <td align="right">${starLinkHtml(s)}</td>
              </tr></table>
              <div style="font-size:15px; font-weight:bold; color:#f0a83c; margin-top:2px;">${escapeHtml(s.b)}</div>
              ${openerLine}
              ${venueStageTable}
            </td>
          </tr>
        </table>
      </td></tr>`;
  }

  const myShowsRowsHtml = myShowsUpcoming.map(s => showRowHtml(s, false)).join('');
  const recentlyAddedRowsHtml = recentlyAddedShows.map(s => showRowHtml(s, false)).join('');
  const otherRowsHtml = otherShows.map(s => showRowHtml(s, false)).join('');

  const myShowsSectionHtml = myShowsUpcoming.length ? `
    <tr><td style="padding:16px 24px 10px 24px;">
      <div style="font-size:13px; font-weight:bold; color:#e0c46a; text-transform:uppercase; letter-spacing:1px; border-bottom:2px solid #e0c46a; padding-bottom:6px; margin-bottom:12px;">My Shows</div>
    </td></tr>
    <tr><td style="padding:0 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${myShowsRowsHtml}</table></td></tr>` : '';

  const recentlyAddedSectionHtml = recentlyAddedShows.length ? `
    <tr><td style="padding:16px 24px 10px 24px;">
      <div style="font-size:13px; font-weight:bold; color:#4fd1b0; text-transform:uppercase; letter-spacing:1px; border-bottom:2px solid #4fd1b0; padding-bottom:6px; margin-bottom:12px;">Added This Week</div>
    </td></tr>
    <tr><td style="padding:0 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${recentlyAddedRowsHtml}</table></td></tr>` : '';

  const signInCtaHtml = `
    <tr><td style="padding:20px 24px; text-align:center;">
      <div style="background-color:#1b1e2a; border:1px solid #2c3040; border-radius:8px; padding:16px;">
        <div style="font-size:13px; color:#c9cddb; margin-bottom:10px;">Tap a star above to add a show to My Shows. Sign in on the site to manage your favorited artists.</div>
        <a href="${siteUrl}" target="_blank" style="color:#e0c46a; font-size:13px; font-weight:bold; text-decoration:none;">Sign in to see your favorites →</a>
      </div>
    </td></tr>`;

  const otherSectionHtml = otherShows.length ? `
    <tr><td style="padding:8px 24px 10px 24px;">
      <div style="font-size:13px; font-weight:bold; color:#eee9db; text-transform:uppercase; letter-spacing:1px; border-bottom:2px solid #2c3040; padding-bottom:6px; margin-bottom:12px;">Everything Else Coming Up</div>
    </td></tr>
    <tr><td style="padding:0 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${otherRowsHtml}</table></td></tr>` : '';

  const emptyStateHtml = (!recentlyAddedShows.length && !otherShows.length && !myShowsUpcoming.length) ? `
    <tr><td style="padding:24px; text-align:center; color:#9599ad; font-size:13px;">Nothing new on the calendar this week.</td></tr>` : '';

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; background-color:#0d0f16; font-family:Arial, Helvetica, sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0d0f16;">
<tr><td align="center" style="padding:24px 12px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; width:100%; background-color:#12141c; border-radius:8px; overflow:hidden; border:1px solid #2c3040;">
    <tr><td style="background-color:#12141c; padding:28px 24px; text-align:center; border-bottom:1px solid #2c3040;">
      <!-- Double-border "b2-frame" treatment from the site header, reproduced with nested
           tables: email clients don't support clip-path (so the site's cut corners become
           square) and old Outlook doesn't reliably render rgba() borders (so the site's
           translucent inner border becomes the solid --amber-dim color instead). -->
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto; border:1px solid #f0a83c;">
        <tr><td style="padding:4px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #8a672a;">
            <tr><td style="padding:12px 22px; text-align:center;">
              <div style="font-family:Georgia, 'Times New Roman', serif; letter-spacing:2px; color:#f0a83c; font-size:22px; font-weight:bold;">LOWCOUNTRY SHOW TRACKER</div>
            </td></tr>
          </table>
        </td></tr>
      </table>
      <div style="color:#9599ad; font-size:13px; margin-top:10px;">Live music across Charleston</div>
    </td></tr>
    <tr><td style="padding:24px 24px 8px 24px; font-size:14px; color:#eee9db; line-height:1.5;">
      Hey there — here's what's new on the tracker this week.
    </td></tr>
    ${myShowsSectionHtml}
    ${recentlyAddedSectionHtml}
    ${signInCtaHtml}
    ${otherSectionHtml}
    ${emptyStateHtml}
    <tr><td align="center" style="padding:28px 24px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td align="center" bgcolor="#f0a83c" style="border-radius:6px;">
          <a href="${siteUrl}" target="_blank" style="display:inline-block; padding:12px 28px; font-size:14px; font-weight:bold; color:#12141c; text-decoration:none; font-family:Arial, Helvetica, sans-serif;">Manage Your List →</a>
        </td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:20px 24px 28px 24px; text-align:center; border-top:1px solid #2c3040;">
      <div style="font-size:11px; color:#9599ad; line-height:1.6;">
        You're getting this because you signed up for Lowcountry Show Tracker updates.<br>
        <a href="${unsubscribeLink}" style="color:#9599ad; text-decoration:underline;">Unsubscribe</a>
        &nbsp;·&nbsp;
        <a href="${siteUrl}" style="color:#9599ad; text-decoration:underline;">Manage preferences</a>
      </div>
    </td></tr>
    </table>
</td></tr>
</table>
</body></html>`;
}

async function sendDigestEmail(email, html, env, resendApiKey) {
  const from = env.RESEND_FROM_ADDRESS || 'Lowcountry Show Tracker <shows@gigalertchs.com>';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
    // The 'type':'digest' tag is what the Resend webhook handler (handleResendWebhook,
    // below) uses to tell digest opens/clicks apart from sign-in-link email events --
    // both go through this same Resend account.
    body: JSON.stringify({ from, to: email, subject: 'This Week in Charleston Live Music', html, tags: [{ name: 'type', value: 'digest' }] })
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Resend API responded ${res.status}: ${errBody}`);
  }
}

// KV's list() caps at 1000 keys per call and truncates silently past that — no error,
// just a `list_complete: false` and a `cursor` you're expected to page through. Every
// call site in this file wants "every key with this prefix," so that paging lives here
// once instead of being (or, more likely, NOT being) repeated at each call site.
async function listAllKeys(env, prefix) {
  const keys = [];
  let cursor;
  for (;;) {
    const page = await env.SHOW_TRACKER_KV.list({ prefix, cursor });
    keys.push(...page.keys);
    if (page.list_complete) return keys;
    cursor = page.cursor;
  }
}

// Rolling windows (last 7/30/365 days), not calendar week/month/year -- simpler and
// unambiguous (no "which day does the week start on" question) for what's really just
// "recent activity at a glance" in the admin panel. `getTs` pulls a ms timestamp out of
// each item; items with no timestamp only count toward `all`.
function windowCounts(items, getTs) {
  const now = Date.now();
  const cutoffs = { week: now - 7 * 86400000, month: now - 30 * 86400000, year: now - 365 * 86400000 };
  const result = { week: 0, month: 0, year: 0, all: items.length };
  items.forEach(item => {
    const ts = getTs(item);
    if (!ts) return;
    if (ts >= cutoffs.year) result.year++;
    if (ts >= cutoffs.month) result.month++;
    if (ts >= cutoffs.week) result.week++;
  });
  return result;
}

// Same idea as windowCounts(), but tallying separate week/month/year/all counts per
// group (e.g. per artist) instead of one grand total -- what topFavoriteArtists/
// topVenues/topStarredShows use so each row in those tables gets its own breakdown.
function windowGroupedCounts(events, getKey, getTs) {
  const now = Date.now();
  const cutoffs = { week: now - 7 * 86400000, month: now - 30 * 86400000, year: now - 365 * 86400000 };
  const groups = {};
  events.forEach(event => {
    const key = getKey(event);
    if (!groups[key]) groups[key] = { week: 0, month: 0, year: 0, all: 0 };
    groups[key].all++;
    const ts = getTs(event);
    if (!ts) return;
    if (ts >= cutoffs.year) groups[key].year++;
    if (ts >= cutoffs.month) groups[key].month++;
    if (ts >= cutoffs.week) groups[key].week++;
  });
  return groups;
}

// digest-stats:{type}:{YYYY-MM-DD} is one KV key per day per event type (see
// handleResendWebhook) rather than one running total, specifically so this can sum a
// week/month/year/all window the same way windowCounts() does for everything else.
// Digest sends are weekly, so this stays cheap indefinitely -- at most ~52 date-keys
// per type per year.
async function digestStatsWindow(env, type) {
  const keys = await listAllKeys(env, `digest-stats:${type}:`);
  const items = await Promise.all(keys.map(async key => {
    const dateStr = key.name.slice(`digest-stats:${type}:`.length);
    const raw = await env.SHOW_TRACKER_KV.get(key.name);
    const count = raw ? parseInt(raw, 10) : 0;
    return { ts: new Date(dateStr + 'T12:00:00').getTime(), count };
  }));
  const now = Date.now();
  const cutoffs = { week: now - 7 * 86400000, month: now - 30 * 86400000, year: now - 365 * 86400000 };
  const result = { week: 0, month: 0, year: 0, all: 0 };
  items.forEach(({ ts, count }) => {
    result.all += count;
    if (ts >= cutoffs.year) result.year += count;
    if (ts >= cutoffs.month) result.month += count;
    if (ts >= cutoffs.week) result.week += count;
  });
  return result;
}

// Called by the scheduled() Cron handler. Sends one personalized email per subscriber.
// A failure sending to one person doesn't stop the rest of the batch — logged and moved on.
async function sendDigestToAllSubscribers(env) {
  const resendApiKey = await getResendApiKey(env);
  if (!resendApiKey) {
    console.error('sendDigestToAllSubscribers: no Resend API key configured, aborting.');
    return;
  }

  const showData = await fetchShowData(env);
  const siteUrl = env.SITE_URL || DEFAULT_SITE_URL;
  const baseUrl = env.WORKER_BASE_URL || DEFAULT_WORKER_BASE_URL;

  const keys = await listAllKeys(env, 'subscriber:');
  for (const key of keys) {
    const email = key.name.slice('subscriber:'.length);
    try {
      const subRaw = await env.SHOW_TRACKER_KV.get(key.name);
      if (!subRaw) continue;
      const sub = JSON.parse(subRaw);
      const userRaw = await env.SHOW_TRACKER_KV.get(`user:${email}`);
      const userData = userRaw ? JSON.parse(userRaw) : { myShows: [] };
      const myShowIds = Array.isArray(userData.myShows) ? userData.myShows : [];

      const html = buildDigestEmailHTML({
        shows: showData.shows,
        venues: showData.venues,
        unsubscribeLink: `${baseUrl}/api/unsubscribe?token=${sub.unsubscribeToken}`,
        siteUrl,
        baseUrl,
        myShowIds,
        starToken: sub.unsubscribeToken
      });

      await sendDigestEmail(email, html, env, resendApiKey);
    } catch (err) {
      console.error(`Failed to send digest to ${email}:`, err);
    }
  }
}

// Read-only preview of your own digest, gated behind your own session — lets us look at
// the real, personalized output in a browser before any Cron Trigger exists to send it
// for real. Not linked from the site's UI; meant for us to check directly by URL.
async function handleDigestPreview(request, env, headers) {
  const email = await getEmailFromSession(request, env);
  if (!email) return json({ error: 'Not signed in' }, 401, headers);

  const subRaw = await env.SHOW_TRACKER_KV.get(`subscriber:${email}`);
  const sub = subRaw ? JSON.parse(subRaw) : { unsubscribeToken: 'preview' };
  const userRaw = await env.SHOW_TRACKER_KV.get(`user:${email}`);
  const userData = userRaw ? JSON.parse(userRaw) : { myShows: [] };
  const myShowIds = Array.isArray(userData.myShows) ? userData.myShows : [];

  const showData = await fetchShowData(env);
  const siteUrl = env.SITE_URL || DEFAULT_SITE_URL;
  const baseUrl = env.WORKER_BASE_URL || DEFAULT_WORKER_BASE_URL;

  const html = buildDigestEmailHTML({
    shows: showData.shows,
    venues: showData.venues,
    unsubscribeLink: `${baseUrl}/api/unsubscribe?token=${sub.unsubscribeToken}`,
    siteUrl,
    baseUrl,
    myShowIds,
    starToken: sub.unsubscribeToken
  });

  return new Response(html, { status: 200, headers: { ...headers, 'Content-Type': 'text/html' } });
}

// Manually fires the exact same function the real Cron Trigger calls, so we can verify
// the full real pipeline (subscriber list, real Resend send) works today instead of
// waiting until the schedule fires on its own. Gated behind your own session so this
// isn't a public "spam everyone" button sitting on the internet unauthenticated.
// Consider removing this route once you're confident the schedule itself works.
async function handleTestSendDigestNow(request, env, headers) {
  const email = await getEmailFromSession(request, env);
  if (!email) return json({ error: 'Not signed in' }, 401, headers);

  const ownerEmail = env.OWNER_EMAIL || 'gigalertchs@gmail.com';
  if (email.toLowerCase() !== ownerEmail.toLowerCase()) {
    // This triggers a real send to every subscriber — any signed-in user being able
    // to fire it (not just the owner) would let a friend spam everyone else's inbox.
    return json({ error: 'Not authorized' }, 403, headers);
  }

  try {
    await sendDigestToAllSubscribers(env);
    return json({ ok: true, message: 'Digest send attempted for all current subscribers — check inboxes, and Cloudflare\'s logs if anything looks off.' }, 200, headers);
  } catch (err) {
    return json({ error: 'Digest send failed', detail: String(err && err.message || err) }, 500, headers);
  }
}

// ---- Cowork research-conflict reporting ----
// Called by the Cowork scheduled research task (not a signed-in user), so it uses its
// own shared-secret auth via COWORK_API_SECRET rather than a session token. Cowork
// pushes routine venue-data updates straight to GitHub on its own, and calls this
// endpoint only for the specific judgment calls it wasn't confident enough to make
// silently (e.g. conflicting dates between sources, ambiguous "is this really a music
// show" calls) — so you get a short, targeted email instead of a full diff to review.
async function getCoworkApiSecret(env) {
  if (!env.COWORK_API_SECRET) return null;
  if (typeof env.COWORK_API_SECRET.get === 'function') return await env.COWORK_API_SECRET.get();
  return env.COWORK_API_SECRET;
}

// Plain !== comparison on secrets leaks timing information character-by-character in
// theory, letting an attacker narrow down the correct value faster than brute force
// alone would allow. Constant-time comparison avoids that — low practical risk here
// given how infrequently this endpoint is hit, but cheap to do correctly.
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

async function handleReportConflicts(request, env, headers) {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const expected = await getCoworkApiSecret(env);

  if (!expected || !timingSafeEqual(token, expected)) {
    return json({ error: 'Unauthorized' }, 401, headers);
  }

  const body = await request.json().catch(() => null);
  // Length- and count-capped as defense in depth, same reasoning as the other
  // user/caller-supplied inputs in this file — this endpoint is behind a shared
  // secret, not a signed-in user, but a leaked/compromised secret shouldn't be able to
  // turn one Cowork report into an arbitrarily large outbound email.
  const conflicts = (body && Array.isArray(body.conflicts))
    ? body.conflicts.filter(c => typeof c === 'string' && c.trim().length > 0 && c.length <= 500).slice(0, 200)
    : [];

  if (conflicts.length === 0) {
    return json({ ok: true, message: 'No conflicts reported — nothing sent.' }, 200, headers);
  }

  const resendApiKey = await getResendApiKey(env);
  if (!resendApiKey) {
    return json({ error: 'No Resend API key configured — cannot send conflict report' }, 500, headers);
  }

  const ownerEmail = env.OWNER_EMAIL || 'gigalertchs@gmail.com';
  const html = buildConflictReportHTML(conflicts);

  try {
    await sendConflictReportEmail(ownerEmail, html, env, resendApiKey);
    return json({ ok: true, message: `Conflict report sent to ${ownerEmail} (${conflicts.length} item(s)).` }, 200, headers);
  } catch (err) {
    return json({ error: 'Failed to send conflict report', detail: String(err && err.message || err) }, 500, headers);
  }
}

function buildConflictReportHTML(conflicts) {
  const itemsHtml = conflicts.map(c =>
    `<li style="margin-bottom:10px; font-size:14px; color:#333333; line-height:1.5;">${escapeHtml(c)}</li>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; background-color:#f4f2ec; font-family:Arial, Helvetica, sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f2ec;">
<tr><td align="center" style="padding:24px 12px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; width:100%; background-color:#ffffff; border-radius:8px; overflow:hidden;">
    <tr><td style="background-color:#12141c; padding:24px; text-align:center;">
      <div style="font-family:Georgia, 'Times New Roman', serif; letter-spacing:1px; color:#f0a83c; font-size:18px; font-weight:bold;">SHOW TRACKER — RESEARCH REVIEW NEEDED</div>
    </td></tr>
    <tr><td style="padding:20px 24px 8px 24px; font-size:14px; color:#333333; line-height:1.5;">
      The latest automated venue research run pushed its routine update, but flagged ${conflicts.length} item${conflicts.length === 1 ? '' : 's'} it wasn't confident enough to decide on its own:
    </td></tr>
    <tr><td style="padding:0 24px 24px 24px;">
      <ul style="padding-left:20px; margin:0;">${itemsHtml}</ul>
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;
}

async function sendConflictReportEmail(toEmail, html, env, resendApiKey) {
  const from = env.RESEND_FROM_ADDRESS || 'Lowcountry Show Tracker <shows@gigalertchs.com>';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: toEmail, subject: 'Show Tracker: research review needed', html })
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Resend API responded ${res.status}: ${errBody}`);
  }
}

// ---- Suggest a Venue ----
// Signed-in users can suggest a venue to add. Stored in KV for a durable record, and
// emailed to the owner immediately so it doesn't just sit unnoticed in storage.
async function handleSuggestVenue(request, env, headers) {
  const submitterEmail = await getEmailFromSession(request, env);
  if (!submitterEmail) return json({ error: 'Not signed in' }, 401, headers);

  const body = await request.json().catch(() => null);
  const venueName = body && typeof body.venueName === 'string' ? body.venueName.trim() : '';
  const notes = body && typeof body.notes === 'string' ? body.notes.trim() : '';
  const turnstileToken = body && body.turnstileToken ? String(body.turnstileToken) : null;

  if (!venueName) {
    return json({ error: 'Venue name is required' }, 400, headers);
  }
  if (venueName.length > 200 || notes.length > 2000) {
    return json({ error: 'That input is too long' }, 400, headers);
  }

  // Defense in depth against stored XSS in admin.html, which displays these values.
  // admin.html now escapes on output (the real fix), but rejecting angle brackets at
  // the door too means a future template change there can't silently reintroduce the
  // hole. Mirrors the same restriction already applied to favorite artist names.
  if (/[<>]/.test(venueName) || /[<>]/.test(notes)) {
    return json({ error: 'Please remove < and > characters from your submission' }, 400, headers);
  }

  const turnstileSecretKey = await getTurnstileSecretKey(env);
  if (turnstileSecretKey) {
    const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';
    const verified = await verifyTurnstileToken(turnstileToken, clientIp, turnstileSecretKey);
    if (!verified) {
      return json({ error: 'Verification failed — please try again' }, 403, headers);
    }
  }

  // Rate limit: at most one suggestion per person per 60 seconds. Checked after
  // validation (not before) so a rejected/invalid attempt doesn't consume the limit
  // and block a legitimate follow-up submission.
  const rateLimitKey = `suggest-ratelimit:${submitterEmail}`;
  const alreadySubmitted = await env.SHOW_TRACKER_KV.get(rateLimitKey);
  if (alreadySubmitted) {
    return json({ error: 'Please wait a bit before submitting another suggestion' }, 429, headers);
  }
  await env.SHOW_TRACKER_KV.put(rateLimitKey, '1', { expirationTtl: 60 });

  const id = crypto.randomUUID();
  const record = { submitterEmail, venueName, notes, submittedAt: Date.now() };
  await env.SHOW_TRACKER_KV.put(`suggestion:${id}`, JSON.stringify(record));

  const resendApiKey = await getResendApiKey(env);
  if (resendApiKey) {
    try {
      const html = buildVenueSuggestionEmailHTML(record);
      const ownerEmail = env.OWNER_EMAIL || 'gigalertchs@gmail.com';
      await sendVenueSuggestionEmail(ownerEmail, venueName, html, env, resendApiKey);
    } catch (err) {
      // The suggestion is already safely stored in KV even if the notification email
      // fails — don't fail the whole request just because the "hey, look at this"
      // ping didn't go out.
      console.error('Failed to send venue suggestion notification:', err);
    }
  }

  return json({ ok: true, message: 'Thanks — your suggestion has been sent!' }, 200, headers);
}

function buildVenueSuggestionEmailHTML({ submitterEmail, venueName, notes }) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; background-color:#f4f2ec; font-family:Arial, Helvetica, sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f2ec;">
<tr><td align="center" style="padding:24px 12px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; width:100%; background-color:#ffffff; border-radius:8px; overflow:hidden;">
    <tr><td style="background-color:#12141c; padding:24px; text-align:center;">
      <div style="font-family:Georgia, 'Times New Roman', serif; letter-spacing:1px; color:#f0a83c; font-size:18px; font-weight:bold;">NEW VENUE SUGGESTION</div>
    </td></tr>
    <tr><td style="padding:20px 24px; font-size:14px; color:#333333; line-height:1.6;">
      <p><strong>Venue:</strong> ${escapeHtml(venueName)}</p>
      ${notes ? `<p><strong>Notes:</strong> ${escapeHtml(notes)}</p>` : ''}
      <p><strong>Suggested by:</strong> ${escapeHtml(submitterEmail)}</p>
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;
}

async function sendVenueSuggestionEmail(toEmail, venueName, html, env, resendApiKey) {
  const from = env.RESEND_FROM_ADDRESS || 'Lowcountry Show Tracker <shows@gigalertchs.com>';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: toEmail, subject: `New venue suggestion: ${venueName}`, html })
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Resend API responded ${res.status}: ${errBody}`);
  }
}

// ---- Admin stats ----
// Gated to the site owner's email specifically, not just "anyone signed in" — this
// exposes other people's email addresses (subscribers, suggestion submitters), which
// is exactly the kind of thing the site's own privacy notice promises not to share.
async function handleAdminStats(request, env, headers) {
  const email = await getEmailFromSession(request, env);
  if (!email) return json({ error: 'Not signed in' }, 401, headers);

  const ownerEmail = env.OWNER_EMAIL || 'gigalertchs@gmail.com';
  if (email.toLowerCase() !== ownerEmail.toLowerCase()) {
    return json({ error: 'Not authorized' }, 403, headers);
  }

  const [subscriberKeys, userKeys, suggestionKeys, unsubscribedKeys] = await Promise.all([
    listAllKeys(env, 'subscriber:'),
    listAllKeys(env, 'user:'),
    listAllKeys(env, 'suggestion:'),
    listAllKeys(env, 'unsubscribed:')
  ]);

  // Best-effort: stats for everything else here come straight from KV, but "which
  // upcoming shows/venues are getting starred" needs the show catalog too, to turn a
  // starred show id back into a real venue/band/date and to know which starred ids are
  // even still upcoming. A hiccup fetching it shouldn't take down the rest of this page.
  let upcomingShowById = new Map();
  let venueNames = {};
  try {
    const showData = await fetchShowData(env);
    venueNames = showData.venues || {};
    upcomingShows(showData.shows || []).forEach(s => upcomingShowById.set(showId(s), s));
  } catch (err) {
    console.error('handleAdminStats: fetchShowData failed:', err);
  }

  const subscribers = [];
  for (const key of subscriberKeys) {
    const raw = await env.SHOW_TRACKER_KV.get(key.name);
    if (!raw) continue;
    const data = JSON.parse(raw);
    subscribers.push({ email: key.name.slice('subscriber:'.length), subscribedAt: data.subscribedAt });
  }
  subscribers.sort((a, b) => (b.subscribedAt || 0) - (a.subscribedAt || 0));

  const unsubscribes = [];
  for (const key of unsubscribedKeys) {
    const raw = await env.SHOW_TRACKER_KV.get(key.name);
    unsubscribes.push({ unsubscribedAt: raw ? JSON.parse(raw).unsubscribedAt : null });
  }

  // One-time self-healing backfill: createdAt/myShowsAddedAt/favoritesAddedAt didn't
  // exist before this change, so an account/favorite/starred-show from before today has
  // no real added date. Per instruction, anything missing one gets stamped with today's
  // date (now) the first time this runs into it, and that gets written back so it's a
  // real, stable value from here on rather than drifting every time stats are viewed.
  const backfillNow = Date.now();
  const favoriteEvents = []; // {artist, addedAt}
  const showEvents = []; // {id, addedAt}
  const users = [];
  for (const key of userKeys) {
    const raw = await env.SHOW_TRACKER_KV.get(key.name);
    if (!raw) continue;
    const data = JSON.parse(raw);
    const myShows = Array.isArray(data.myShows) ? data.myShows : [];
    const favorites = Array.isArray(data.favorites) ? data.favorites : [];
    let touched = false;
    if (!data.createdAt) { data.createdAt = backfillNow; touched = true; }
    if (!data.myShowsAddedAt || typeof data.myShowsAddedAt !== 'object') { data.myShowsAddedAt = {}; touched = true; }
    if (!data.favoritesAddedAt || typeof data.favoritesAddedAt !== 'object') { data.favoritesAddedAt = {}; touched = true; }
    myShows.forEach(id => { if (!data.myShowsAddedAt[id]) { data.myShowsAddedAt[id] = backfillNow; touched = true; } });
    favorites.forEach(artist => { if (!data.favoritesAddedAt[artist]) { data.favoritesAddedAt[artist] = backfillNow; touched = true; } });
    if (touched) await env.SHOW_TRACKER_KV.put(key.name, JSON.stringify(data));

    users.push({ email: key.name.slice('user:'.length), myShowsCount: myShows.length, favoritesCount: favorites.length, createdAt: data.createdAt });
    favorites.forEach(artist => {
      const norm = artist.trim();
      if (!norm) return;
      favoriteEvents.push({ artist: norm, addedAt: data.favoritesAddedAt[artist] });
    });
    myShows.forEach(id => {
      if (!upcomingShowById.has(id)) return; // past show, or one no longer in the catalog
      showEvents.push({ id, addedAt: data.myShowsAddedAt[id] });
    });
  }

  const artistWindows = windowGroupedCounts(favoriteEvents, e => e.artist, e => e.addedAt);
  const topFavoriteArtists = Object.entries(artistWindows)
    .map(([artist, w]) => ({ artist, count: w.all, window: w }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  const venueEvents = showEvents.map(e => ({ venue: upcomingShowById.get(e.id).v, addedAt: e.addedAt }));
  const venueWindows = windowGroupedCounts(venueEvents, e => e.venue, e => e.addedAt);
  const topVenues = Object.entries(venueWindows)
    .map(([code, w]) => ({ venue: (venueNames[code] && venueNames[code].name) || code, count: w.all, window: w }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  const showWindows = windowGroupedCounts(showEvents, e => e.id, e => e.addedAt);
  const topStarredShows = Object.entries(showWindows)
    .map(([id, w]) => {
      const s = upcomingShowById.get(id);
      return { band: s.b, venue: (venueNames[s.v] && venueNames[s.v].name) || s.v, date: s.d, count: w.all, window: w };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  const suggestions = [];
  for (const key of suggestionKeys) {
    const raw = await env.SHOW_TRACKER_KV.get(key.name);
    if (!raw) continue;
    suggestions.push(JSON.parse(raw));
  }
  suggestions.sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));

  const [digestDelivered, digestOpened, digestClicked, cloudflareStats] = await Promise.all([
    digestStatsWindow(env, 'delivered'),
    digestStatsWindow(env, 'opened'),
    digestStatsWindow(env, 'clicked'),
    fetchCloudflareZoneAnalytics(env).catch(err => ({ error: err.message }))
  ]);

  return json({
    ok: true,
    subscribers: {
      count: subscribers.length,
      list: subscribers,
      window: windowCounts(subscribers, s => s.subscribedAt)
    },
    unsubscribed: {
      count: unsubscribedKeys.length,
      window: windowCounts(unsubscribes, u => u.unsubscribedAt)
    },
    users: { count: users.length, list: users, window: windowCounts(users, u => u.createdAt) },
    topFavoriteArtists,
    topVenues,
    topStarredShows,
    digestStats: {
      delivered: digestDelivered,
      opened: digestOpened,
      clicked: digestClicked
    },
    cloudflareStats,
    suggestions: {
      count: suggestions.length,
      list: suggestions,
      window: windowCounts(suggestions, s => s.submittedAt)
    }
  }, 200, headers);
}
