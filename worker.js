var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var DEFAULT_WORKER_BASE_URL = "https://api.gigalertchs.com";
var DEFAULT_SITE_URL = "https://gigalertchs.com/";
var ALLOWED_ORIGIN = "https://gigalertchs.com";
var worker_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const headers = corsHeaders();
    if (request.method === "OPTIONS") {
      return new Response(null, { headers });
    }
    try {
      if (path === "/api/auth/request-link" && request.method === "POST") {
        return await handleRequestLink(request, env, headers);
      }
      if (path === "/api/auth/verify" && request.method === "GET") {
        return await handleVerify(request, env, headers);
      }
      if (path === "/api/user/data" && request.method === "GET") {
        return await handleGetUserData(request, env, headers);
      }
      if (path === "/api/user/data" && request.method === "POST") {
        return await handleSaveUserData(request, env, headers);
      }
      if (path === "/api/unsubscribe" && request.method === "GET") {
        return await handleUnsubscribe(request, env, headers);
      }
      if (path === "/api/star-show" && request.method === "GET") {
        return await handleStarShow(request, env, headers);
      }
      if (path === "/api/digest-preview" && request.method === "GET") {
        return await handleDigestPreview(request, env, headers);
      }
      if (path === "/api/test-send-digest-now" && request.method === "GET") {
        return await handleTestSendDigestNow(request, env, headers);
      }
      if (path === "/api/report-conflicts" && request.method === "POST") {
        return await handleReportConflicts(request, env, headers);
      }
      if (path === "/api/suggest-venue" && request.method === "POST") {
        return await handleSuggestVenue(request, env, headers);
      }
      if (path === "/api/admin/stats" && request.method === "GET") {
        return await handleAdminStats(request, env, headers);
      }
      if (path === "/api/subscribe" && request.method === "POST") {
        return await handleSubscribe(request, env, headers);
      }
      return json({ error: "Not found" }, 404, headers);
    } catch (err) {
      console.error("Unhandled error in fetch handler:", err);
      return json({ error: "Server error" }, 500, headers);
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
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json"
  };
}
__name(corsHeaders, "corsHeaders");
function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status: status || 200, headers });
}
__name(json, "json");
function isValidEmail(email) {
  if (typeof email !== "string") return false;
  if (/[<>"'`]/.test(email)) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
__name(isValidEmail, "isValidEmail");
async function getTurnstileSecretKey(env) {
  if (!env.TURNSTILE_SECRET_KEY) return null;
  if (typeof env.TURNSTILE_SECRET_KEY.get === "function") {
    return await env.TURNSTILE_SECRET_KEY.get();
  }
  return env.TURNSTILE_SECRET_KEY;
}
__name(getTurnstileSecretKey, "getTurnstileSecretKey");
async function verifyTurnstileToken(token, ip, secretKey) {
  if (!token) return false;
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: secretKey, response: token, remoteip: ip || "" })
    });
    const data = await res.json();
    return data.success === true;
  } catch (err) {
    console.error("Turnstile verification request failed:", err);
    return false;
  }
}
__name(verifyTurnstileToken, "verifyTurnstileToken");
async function handleRequestLink(request, env, headers) {
  const body = await request.json().catch(() => null);
  const email = body && body.email ? String(body.email).trim().toLowerCase() : null;
  const turnstileToken = body && body.turnstileToken ? String(body.turnstileToken) : null;
  if (!isValidEmail(email)) {
    return json({ error: "A valid email address is required" }, 400, headers);
  }
  const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
  const turnstileSecretKey = await getTurnstileSecretKey(env);
  if (turnstileSecretKey) {
    const verified = await verifyTurnstileToken(turnstileToken, clientIp, turnstileSecretKey);
    if (!verified) {
      return json({ error: "Verification failed \u2014 please try again" }, 403, headers);
    }
  }
  const ipRateLimitKey = `ratelimit-ip:${clientIp}`;
  const ipRequestCountRaw = await env.SHOW_TRACKER_KV.get(ipRateLimitKey);
  const ipRequestCount = ipRequestCountRaw ? parseInt(ipRequestCountRaw, 10) : 0;
  if (ipRequestCount >= 10) {
    return json({ error: "Too many sign-in requests from this connection \u2014 please try again later" }, 429, headers);
  }
  await env.SHOW_TRACKER_KV.put(ipRateLimitKey, String(ipRequestCount + 1), { expirationTtl: 3600 });
  const rateLimitKey = `ratelimit:${email}`;
  const alreadyRequested = await env.SHOW_TRACKER_KV.get(rateLimitKey);
  if (alreadyRequested) {
    return json({ error: "Please wait a bit before requesting another link" }, 429, headers);
  }
  await env.SHOW_TRACKER_KV.put(rateLimitKey, "1", { expirationTtl: 60 });
  const token = crypto.randomUUID();
  await env.SHOW_TRACKER_KV.put(
    `token:${token}`,
    JSON.stringify({ email }),
    { expirationTtl: 900 }
    // link is valid for 15 minutes
  );
  const baseUrl = env.WORKER_BASE_URL || DEFAULT_WORKER_BASE_URL;
  const magicLink = `${baseUrl}/api/auth/verify?token=${token}`;
  const resendApiKey = await getResendApiKey(env);
  if (resendApiKey) {
    try {
      await sendMagicLinkEmail(email, magicLink, env, resendApiKey);
      return json({ ok: true, message: "Check your email for a sign-in link" }, 200, headers);
    } catch (err) {
      console.error("sendMagicLinkEmail failed:", err);
      return json({ ok: false, error: "Failed to send the email \u2014 please try again in a moment" }, 502, headers);
    }
  }
  return json({ ok: true, testMode: true, magicLink }, 200, headers);
}
__name(handleRequestLink, "handleRequestLink");
async function getResendApiKey(env) {
  if (!env.RESEND_API_KEY) return null;
  if (typeof env.RESEND_API_KEY.get === "function") {
    return await env.RESEND_API_KEY.get();
  }
  return env.RESEND_API_KEY;
}
__name(getResendApiKey, "getResendApiKey");
async function sendMagicLinkEmail(email, link, env, resendApiKey) {
  const from = env.RESEND_FROM_ADDRESS || "Lowcountry Show Tracker <shows@gigalertchs.com>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${resendApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from,
      to: email,
      subject: "Your Lowcountry Show Tracker sign-in link",
      html: `<p>Click below to sign in to your Show Tracker account:</p>
             <p><a href="${link}">${link}</a></p>
             <p>This link expires in 15 minutes. If you didn't request this, you can ignore it.</p>`
    })
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Resend API responded ${res.status}: ${errBody}`);
  }
}
__name(sendMagicLinkEmail, "sendMagicLinkEmail");
async function handleVerify(request, env, headers) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const siteUrl = env.SITE_URL || DEFAULT_SITE_URL;
  if (!token) {
    return Response.redirect(`${siteUrl}?authError=missing_token`, 302);
  }
  const raw = await env.SHOW_TRACKER_KV.get(`token:${token}`);
  if (!raw) {
    return Response.redirect(`${siteUrl}?authError=invalid_or_expired`, 302);
  }
  const { email } = JSON.parse(raw);
  await env.SHOW_TRACKER_KV.delete(`token:${token}`);
  const sessionToken = crypto.randomUUID();
  await env.SHOW_TRACKER_KV.put(
    `session:${sessionToken}`,
    JSON.stringify({ email }),
    { expirationTtl: 60 * 60 * 24 * 30 }
    // session lasts 30 days
  );
  await ensureSubscribed(email, env);
  const redirectUrl = `${siteUrl}?session=${encodeURIComponent(sessionToken)}&email=${encodeURIComponent(email)}`;
  return Response.redirect(redirectUrl, 302);
}
__name(handleVerify, "handleVerify");
async function ensureSubscribed(email, env) {
  const existing = await env.SHOW_TRACKER_KV.get(`subscriber:${email}`);
  if (existing) return;
  const previouslyUnsubscribed = await env.SHOW_TRACKER_KV.get(`unsubscribed:${email}`);
  if (previouslyUnsubscribed) return;
  const unsubscribeToken = crypto.randomUUID();
  await env.SHOW_TRACKER_KV.put(`subscriber:${email}`, JSON.stringify({ subscribedAt: Date.now(), unsubscribeToken }));
  await env.SHOW_TRACKER_KV.put(`unsubtoken:${unsubscribeToken}`, email);
}
__name(ensureSubscribed, "ensureSubscribed");
async function handleSubscribe(request, env, headers) {
  const email = await getEmailFromSession(request, env);
  if (!email) return json({ error: "Not signed in" }, 401, headers);
  const existing = await env.SHOW_TRACKER_KV.get(`subscriber:${email}`);
  if (existing) {
    return json({ ok: true, message: "You're already subscribed." }, 200, headers);
  }
  const unsubscribeToken = crypto.randomUUID();
  await env.SHOW_TRACKER_KV.put(`subscriber:${email}`, JSON.stringify({ subscribedAt: Date.now(), unsubscribeToken }));
  await env.SHOW_TRACKER_KV.put(`unsubtoken:${unsubscribeToken}`, email);
  await env.SHOW_TRACKER_KV.delete(`unsubscribed:${email}`);
  return json({ ok: true, message: "You're subscribed! You'll get the next digest." }, 200, headers);
}
__name(handleSubscribe, "handleSubscribe");
async function handleUnsubscribe(request, env, headers) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const htmlHeaders = { "Content-Type": "text/html" };
  if (!token) {
    return new Response("<p>Missing unsubscribe token.</p>", { status: 400, headers: htmlHeaders });
  }
  const email = await env.SHOW_TRACKER_KV.get(`unsubtoken:${token}`);
  if (!email) {
    return new Response("<p>This unsubscribe link is invalid or has already been used.</p>", { status: 400, headers: htmlHeaders });
  }
  await env.SHOW_TRACKER_KV.delete(`subscriber:${email}`);
  await env.SHOW_TRACKER_KV.delete(`unsubtoken:${token}`);
  await env.SHOW_TRACKER_KV.put(`unsubscribed:${email}`, JSON.stringify({ unsubscribedAt: Date.now() }));
  return new Response(
    `<p>You've been unsubscribed from the Lowcountry Show Tracker digest. Your My Shows list and Favorite Artists are untouched \u2014 you just won't get the periodic email anymore. You can re-subscribe anytime by signing in again.</p>`,
    { status: 200, headers: htmlHeaders }
  );
}
__name(handleUnsubscribe, "handleUnsubscribe");
function maskEmail(email) {
  const atIndex = email.indexOf("@");
  if (atIndex <= 1) return email;
  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex);
  return local[0] + "*".repeat(Math.max(local.length - 1, 3)) + domain;
}
__name(maskEmail, "maskEmail");
async function handleStarShow(request, env, headers) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const showIdParam = url.searchParams.get("show");
  const confirmed = url.searchParams.get("confirm") === "1";
  const siteUrl = env.SITE_URL || DEFAULT_SITE_URL;
  const baseUrl = env.WORKER_BASE_URL || DEFAULT_WORKER_BASE_URL;
  const htmlHeaders = { "Content-Type": "text/html" };
  if (!token || !showIdParam) {
    return new Response("<p>This link is missing required information.</p>", { status: 400, headers: htmlHeaders });
  }
  const email = await env.SHOW_TRACKER_KV.get(`unsubtoken:${token}`);
  if (!email) {
    return new Response("<p>This link is invalid or has expired. Sign in on the site to manage your My Shows list instead.</p>", { status: 400, headers: htmlHeaders });
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
  const data = raw ? JSON.parse(raw) : { myShows: [], favorites: [] };
  if (!Array.isArray(data.myShows)) data.myShows = [];
  if (!data.myShows.includes(showIdParam)) {
    data.myShows.push(showIdParam);
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
__name(handleStarShow, "handleStarShow");
async function getEmailFromSession(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const sessionToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!sessionToken) return null;
  const raw = await env.SHOW_TRACKER_KV.get(`session:${sessionToken}`);
  if (!raw) return null;
  return JSON.parse(raw).email;
}
__name(getEmailFromSession, "getEmailFromSession");
async function handleGetUserData(request, env, headers) {
  const email = await getEmailFromSession(request, env);
  if (!email) return json({ error: "Not signed in" }, 401, headers);
  const raw = await env.SHOW_TRACKER_KV.get(`user:${email}`);
  const data = raw ? JSON.parse(raw) : { myShows: [], favorites: [] };
  return json({ ok: true, data }, 200, headers);
}
__name(handleGetUserData, "handleGetUserData");
async function handleSaveUserData(request, env, headers) {
  const email = await getEmailFromSession(request, env);
  if (!email) return json({ error: "Not signed in" }, 401, headers);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return json({ error: "Invalid request body" }, 400, headers);
  const isSafeFavorite = /* @__PURE__ */ __name((f) => typeof f === "string" && f.trim().length > 0 && f.length <= 100 && !/[<>]/.test(f), "isSafeFavorite");
  const data = {
    myShows: Array.isArray(body.myShows) ? body.myShows.filter((id) => typeof id === "string") : [],
    favorites: Array.isArray(body.favorites) ? body.favorites.filter(isSafeFavorite) : []
  };
  await env.SHOW_TRACKER_KV.put(`user:${email}`, JSON.stringify(data));
  return json({ ok: true }, 200, headers);
}
__name(handleSaveUserData, "handleSaveUserData");
function showId(s) {
  return [s.v, s.d, s.b].join("|").toLowerCase().replace(/\s+/g, "_");
}
__name(showId, "showId");
function isUnknownTime(t) {
  return !t || /see ticket link|tba|^—$/i.test(t.trim());
}
__name(isUnknownTime, "isUnknownTime");
async function fetchShowData(env) {
  const siteUrl = env.SITE_URL || DEFAULT_SITE_URL;
  const res = await fetch(new URL("shows.json", siteUrl).toString(), { cf: { cacheTtl: 300 } });
  if (!res.ok) throw new Error(`Failed to fetch shows.json: ${res.status}`);
  return await res.json();
}
__name(fetchShowData, "fetchShowData");
function upcomingShows(shows) {
  const cutoff = new Date(Date.now() - 1 * 24 * 60 * 60 * 1e3).toISOString().slice(0, 10);
  return shows.filter((s) => (s.e || s.d) >= cutoff).sort((a, b) => a.d.localeCompare(b.d));
}
__name(upcomingShows, "upcomingShows");
function fmtShortDate(iso) {
  const d = /* @__PURE__ */ new Date(iso + "T12:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}
__name(fmtShortDate, "fmtShortDate");
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
__name(escapeHtml, "escapeHtml");
function buildDigestEmailHTML({ shows, venues, unsubscribeLink, siteUrl, baseUrl, myShowIds = [], starToken = null }) {
  const upcoming = upcomingShows(shows);
  const recentCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1e3).toISOString().slice(0, 10);
  const recentlyAddedShows = upcoming.filter((s) => s.added && s.added >= recentCutoff);
  const recentlyAddedIds = new Set(recentlyAddedShows.map(showId));
  const myShowsUpcoming = upcoming.filter((s) => myShowIds.includes(showId(s)));
  const myShowsIdSet = new Set(myShowsUpcoming.map(showId));
  const otherShows = upcoming.filter((s) => !recentlyAddedIds.has(showId(s)) && !myShowsIdSet.has(showId(s)));
  function starLinkHtml(s) {
    if (!starToken) return "";
    const id = showId(s);
    const already = myShowIds.includes(id);
    const href = `${baseUrl}/api/star-show?show=${encodeURIComponent(id)}&token=${encodeURIComponent(starToken)}`;
    return `<a href="${href}" style="text-decoration:none; font-size:16px; color:${already ? "#e0c46a" : "#4a4e5e"};">${already ? "&#9733;" : "&#9734;"}</a>`;
  }
  __name(starLinkHtml, "starLinkHtml");
  function showRowHtml(s, isFavorite) {
    const venue = venues[s.v] || { name: s.v };
    const showKnown = !isUnknownTime(s.sh);
    const doorsKnown = !isUnknownTime(s.dr);
    let timeBlockInner;
    if (!showKnown && !doorsKnown) {
      timeBlockInner = `<div style="font-family:Georgia, 'Times New Roman', serif; font-size:15px; color:#f0a83c; line-height:1.1;">Time</div><div style="font-size:9px; color:#9599ad; letter-spacing:1px; margin-top:2px;">TBD</div>`;
    } else {
      const showLine = showKnown ? `<div style="font-family:Georgia, 'Times New Roman', serif; font-size:14px; color:#f0a83c; line-height:1.1;">${escapeHtml(s.sh)}</div><div style="font-size:9px; color:#9599ad; letter-spacing:1px; margin-top:2px;">SHOW</div>` : "";
      const doorsLine = doorsKnown ? `<div style="font-family:Georgia, 'Times New Roman', serif; font-size:14px; color:#eee9db; line-height:1.1; margin-top:${showKnown ? "6px" : "0"};">${escapeHtml(s.dr)}</div><div style="font-size:9px; color:#9599ad; letter-spacing:1px; margin-top:2px;">DOORS</div>` : "";
      timeBlockInner = showLine + doorsLine;
    }
    let priceOrTix;
    const rawTicketUrl = String(s.u || venue.site || "").trim();
    const ticketUrl = /^https?:\/\//i.test(rawTicketUrl) ? escapeHtml(rawTicketUrl) : "";
    const todayStr = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    const isShowDay = todayStr === s.d;
    const effectivePrice = isShowDay && typeof s.dop === "number" ? s.dop : s.p;
    if (typeof effectivePrice === "number") {
      const label = effectivePrice === 0 ? "Free" : `$${Math.round(effectivePrice)}`;
      priceOrTix = ticketUrl ? `<a href="${ticketUrl}" style="color:#4fd1b0; text-decoration:none;">${label}</a>` : label;
    } else {
      priceOrTix = ticketUrl ? `<a href="${ticketUrl}" style="color:#4fd1b0; text-decoration:none;">Tickets</a>` : "";
    }
    const openerLine = s.o ? `<div style="font-size:12px; color:#9599ad; margin-top:3px;">w/ ${escapeHtml(s.o)}</div>` : "";
    const leftBorder = isFavorite ? "border-left:3px solid #e0c46a;" : "";
    const venueStageTable = `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:5px;">
        <tr>
          <td width="56" valign="top" style="font-size:12px; color:#c9cddb; white-space:nowrap;">${priceOrTix ? priceOrTix + " &middot;" : ""}</td>
          <td style="font-size:12px; color:#c9cddb;">${escapeHtml(venue.name)}</td>
        </tr>
        ${s.s ? `<tr>
          <td width="56"></td>
          <td style="font-size:11.5px; color:#9599ad; font-style:italic; padding-top:2px;">${escapeHtml(s.s)}</td>
        </tr>` : ""}
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
  __name(showRowHtml, "showRowHtml");
  const myShowsRowsHtml = myShowsUpcoming.map((s) => showRowHtml(s, false)).join("");
  const recentlyAddedRowsHtml = recentlyAddedShows.map((s) => showRowHtml(s, false)).join("");
  const otherRowsHtml = otherShows.map((s) => showRowHtml(s, false)).join("");
  const myShowsSectionHtml = myShowsUpcoming.length ? `
    <tr><td style="padding:16px 24px 10px 24px;">
      <div style="font-size:13px; font-weight:bold; color:#e0c46a; text-transform:uppercase; letter-spacing:1px; border-bottom:2px solid #e0c46a; padding-bottom:6px; margin-bottom:12px;">My Shows</div>
    </td></tr>
    <tr><td style="padding:0 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${myShowsRowsHtml}</table></td></tr>` : "";
  const recentlyAddedSectionHtml = recentlyAddedShows.length ? `
    <tr><td style="padding:16px 24px 10px 24px;">
      <div style="font-size:13px; font-weight:bold; color:#4fd1b0; text-transform:uppercase; letter-spacing:1px; border-bottom:2px solid #4fd1b0; padding-bottom:6px; margin-bottom:12px;">Added This Week</div>
    </td></tr>
    <tr><td style="padding:0 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${recentlyAddedRowsHtml}</table></td></tr>` : "";
  const signInCtaHtml = `
    <tr><td style="padding:20px 24px; text-align:center;">
      <div style="background-color:#1b1e2a; border:1px solid #2c3040; border-radius:8px; padding:16px;">
        <div style="font-size:13px; color:#c9cddb; margin-bottom:10px;">Tap a star above to add a show to My Shows. Sign in on the site to manage your favorited artists.</div>
        <a href="${siteUrl}" target="_blank" style="color:#e0c46a; font-size:13px; font-weight:bold; text-decoration:none;">Sign in to see your favorites \u2192</a>
      </div>
    </td></tr>`;
  const otherSectionHtml = otherShows.length ? `
    <tr><td style="padding:8px 24px 10px 24px;">
      <div style="font-size:13px; font-weight:bold; color:#eee9db; text-transform:uppercase; letter-spacing:1px; border-bottom:2px solid #2c3040; padding-bottom:6px; margin-bottom:12px;">Everything Else Coming Up</div>
    </td></tr>
    <tr><td style="padding:0 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${otherRowsHtml}</table></td></tr>` : "";
  const emptyStateHtml = !recentlyAddedShows.length && !otherShows.length && !myShowsUpcoming.length ? `
    <tr><td style="padding:24px; text-align:center; color:#9599ad; font-size:13px;">Nothing new on the calendar this week.</td></tr>` : "";
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; background-color:#0d0f16; font-family:Arial, Helvetica, sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0d0f16;">
<tr><td align="center" style="padding:24px 12px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; width:100%; background-color:#12141c; border-radius:8px; overflow:hidden; border:1px solid #2c3040;">
    <tr><td style="background-color:#12141c; padding:28px 24px; text-align:center; border-bottom:1px solid #2c3040;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto; border:1px solid #f0a83c;">
        <tr><td style="padding:3px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #8a672a;">
            <tr><td style="padding:14px 24px;">
              <div style="font-family:Georgia, 'Times New Roman', serif; letter-spacing:2px; color:#f0a83c; font-size:22px; font-weight:bold;">LOWCOUNTRY SHOW TRACKER</div>
            </td></tr>
          </table>
        </td></tr>
      </table>
      <div style="color:#9599ad; font-size:13px; margin-top:14px;">Live music across Charleston</div>
    </td></tr>
    <tr><td style="padding:24px 24px 8px 24px; font-size:14px; color:#eee9db; line-height:1.5;">
      Hey there \u2014 here's what's new on the tracker this week.
    </td></tr>
    ${myShowsSectionHtml}
    ${recentlyAddedSectionHtml}
    ${signInCtaHtml}
    ${otherSectionHtml}
    ${emptyStateHtml}
    <tr><td align="center" style="padding:28px 24px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td align="center" bgcolor="#f0a83c" style="border-radius:6px;">
          <a href="${siteUrl}" target="_blank" style="display:inline-block; padding:12px 28px; font-size:14px; font-weight:bold; color:#12141c; text-decoration:none; font-family:Arial, Helvetica, sans-serif;">Manage Your List \u2192</a>
        </td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:20px 24px 28px 24px; text-align:center; border-top:1px solid #2c3040;">
      <div style="font-size:11px; color:#9599ad; line-height:1.6;">
        You're getting this because you signed up for Lowcountry Show Tracker updates.<br>
        <a href="${unsubscribeLink}" style="color:#9599ad; text-decoration:underline;">Unsubscribe</a>
        &nbsp;\xB7&nbsp;
        <a href="${siteUrl}" style="color:#9599ad; text-decoration:underline;">Manage preferences</a>
      </div>
    </td></tr>
    </table>
</td></tr>
</table>
</body></html>`;
}
__name(buildDigestEmailHTML, "buildDigestEmailHTML");
async function sendDigestEmail(email, html, env, resendApiKey) {
  const from = env.RESEND_FROM_ADDRESS || "Lowcountry Show Tracker <shows@gigalertchs.com>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: email, subject: "This Week in Charleston Live Music", html })
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Resend API responded ${res.status}: ${errBody}`);
  }
}
__name(sendDigestEmail, "sendDigestEmail");
async function sendDigestToAllSubscribers(env) {
  const resendApiKey = await getResendApiKey(env);
  if (!resendApiKey) {
    console.error("sendDigestToAllSubscribers: no Resend API key configured, aborting.");
    return;
  }
  const showData = await fetchShowData(env);
  const siteUrl = env.SITE_URL || DEFAULT_SITE_URL;
  const baseUrl = env.WORKER_BASE_URL || DEFAULT_WORKER_BASE_URL;
  const list = await env.SHOW_TRACKER_KV.list({ prefix: "subscriber:" });
  for (const key of list.keys) {
    const email = key.name.slice("subscriber:".length);
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
__name(sendDigestToAllSubscribers, "sendDigestToAllSubscribers");
async function handleDigestPreview(request, env, headers) {
  const email = await getEmailFromSession(request, env);
  if (!email) return json({ error: "Not signed in" }, 401, headers);
  const subRaw = await env.SHOW_TRACKER_KV.get(`subscriber:${email}`);
  const sub = subRaw ? JSON.parse(subRaw) : { unsubscribeToken: "preview" };
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
  return new Response(html, { status: 200, headers: { ...headers, "Content-Type": "text/html" } });
}
__name(handleDigestPreview, "handleDigestPreview");
async function handleTestSendDigestNow(request, env, headers) {
  const email = await getEmailFromSession(request, env);
  if (!email) return json({ error: "Not signed in" }, 401, headers);
  const ownerEmail = env.OWNER_EMAIL || "gigalertchs@gmail.com";
  if (email.toLowerCase() !== ownerEmail.toLowerCase()) {
    return json({ error: "Not authorized" }, 403, headers);
  }
  try {
    await sendDigestToAllSubscribers(env);
    return json({ ok: true, message: "Digest send attempted for all current subscribers \u2014 check inboxes, and Cloudflare's logs if anything looks off." }, 200, headers);
  } catch (err) {
    return json({ error: "Digest send failed", detail: String(err && err.message || err) }, 500, headers);
  }
}
__name(handleTestSendDigestNow, "handleTestSendDigestNow");
async function getCoworkApiSecret(env) {
  if (!env.COWORK_API_SECRET) return null;
  if (typeof env.COWORK_API_SECRET.get === "function") return await env.COWORK_API_SECRET.get();
  return env.COWORK_API_SECRET;
}
__name(getCoworkApiSecret, "getCoworkApiSecret");
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
__name(timingSafeEqual, "timingSafeEqual");
async function handleReportConflicts(request, env, headers) {
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const expected = await getCoworkApiSecret(env);
  if (!expected || !timingSafeEqual(token, expected)) {
    return json({ error: "Unauthorized" }, 401, headers);
  }
  const body = await request.json().catch(() => null);
  const conflicts = body && Array.isArray(body.conflicts) ? body.conflicts.filter((c) => typeof c === "string" && c.trim().length > 0) : [];
  if (conflicts.length === 0) {
    return json({ ok: true, message: "No conflicts reported \u2014 nothing sent." }, 200, headers);
  }
  const resendApiKey = await getResendApiKey(env);
  if (!resendApiKey) {
    return json({ error: "No Resend API key configured \u2014 cannot send conflict report" }, 500, headers);
  }
  const ownerEmail = env.OWNER_EMAIL || "gigalertchs@gmail.com";
  const html = buildConflictReportHTML(conflicts);
  try {
    await sendConflictReportEmail(ownerEmail, html, env, resendApiKey);
    return json({ ok: true, message: `Conflict report sent to ${ownerEmail} (${conflicts.length} item(s)).` }, 200, headers);
  } catch (err) {
    return json({ error: "Failed to send conflict report", detail: String(err && err.message || err) }, 500, headers);
  }
}
__name(handleReportConflicts, "handleReportConflicts");
function buildConflictReportHTML(conflicts) {
  const itemsHtml = conflicts.map(
    (c) => `<li style="margin-bottom:10px; font-size:14px; color:#333333; line-height:1.5;">${escapeHtml(c)}</li>`
  ).join("");
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; background-color:#f4f2ec; font-family:Arial, Helvetica, sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f2ec;">
<tr><td align="center" style="padding:24px 12px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; width:100%; background-color:#ffffff; border-radius:8px; overflow:hidden;">
    <tr><td style="background-color:#12141c; padding:24px; text-align:center;">
      <div style="font-family:Georgia, 'Times New Roman', serif; letter-spacing:1px; color:#f0a83c; font-size:18px; font-weight:bold;">SHOW TRACKER \u2014 RESEARCH REVIEW NEEDED</div>
    </td></tr>
    <tr><td style="padding:20px 24px 8px 24px; font-size:14px; color:#333333; line-height:1.5;">
      The latest automated venue research run pushed its routine update, but flagged ${conflicts.length} item${conflicts.length === 1 ? "" : "s"} it wasn't confident enough to decide on its own:
    </td></tr>
    <tr><td style="padding:0 24px 24px 24px;">
      <ul style="padding-left:20px; margin:0;">${itemsHtml}</ul>
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;
}
__name(buildConflictReportHTML, "buildConflictReportHTML");
async function sendConflictReportEmail(toEmail, html, env, resendApiKey) {
  const from = env.RESEND_FROM_ADDRESS || "Lowcountry Show Tracker <shows@gigalertchs.com>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: toEmail, subject: "Show Tracker: research review needed", html })
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Resend API responded ${res.status}: ${errBody}`);
  }
}
__name(sendConflictReportEmail, "sendConflictReportEmail");
async function handleSuggestVenue(request, env, headers) {
  const submitterEmail = await getEmailFromSession(request, env);
  if (!submitterEmail) return json({ error: "Not signed in" }, 401, headers);
  const body = await request.json().catch(() => null);
  const venueName = body && typeof body.venueName === "string" ? body.venueName.trim() : "";
  const notes = body && typeof body.notes === "string" ? body.notes.trim() : "";
  const turnstileToken = body && body.turnstileToken ? String(body.turnstileToken) : null;
  if (!venueName) {
    return json({ error: "Venue name is required" }, 400, headers);
  }
  if (venueName.length > 200 || notes.length > 2e3) {
    return json({ error: "That input is too long" }, 400, headers);
  }
  if (/[<>]/.test(venueName) || /[<>]/.test(notes)) {
    return json({ error: "Please remove < and > characters from your submission" }, 400, headers);
  }
  const turnstileSecretKey = await getTurnstileSecretKey(env);
  if (turnstileSecretKey) {
    const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
    const verified = await verifyTurnstileToken(turnstileToken, clientIp, turnstileSecretKey);
    if (!verified) {
      return json({ error: "Verification failed \u2014 please try again" }, 403, headers);
    }
  }
  const rateLimitKey = `suggest-ratelimit:${submitterEmail}`;
  const alreadySubmitted = await env.SHOW_TRACKER_KV.get(rateLimitKey);
  if (alreadySubmitted) {
    return json({ error: "Please wait a bit before submitting another suggestion" }, 429, headers);
  }
  await env.SHOW_TRACKER_KV.put(rateLimitKey, "1", { expirationTtl: 60 });
  const id = crypto.randomUUID();
  const record = { submitterEmail, venueName, notes, submittedAt: Date.now() };
  await env.SHOW_TRACKER_KV.put(`suggestion:${id}`, JSON.stringify(record));
  const resendApiKey = await getResendApiKey(env);
  if (resendApiKey) {
    try {
      const html = buildVenueSuggestionEmailHTML(record);
      const ownerEmail = env.OWNER_EMAIL || "gigalertchs@gmail.com";
      await sendVenueSuggestionEmail(ownerEmail, venueName, html, env, resendApiKey);
    } catch (err) {
      console.error("Failed to send venue suggestion notification:", err);
    }
  }
  return json({ ok: true, message: "Thanks \u2014 your suggestion has been sent!" }, 200, headers);
}
__name(handleSuggestVenue, "handleSuggestVenue");
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
      ${notes ? `<p><strong>Notes:</strong> ${escapeHtml(notes)}</p>` : ""}
      <p><strong>Suggested by:</strong> ${escapeHtml(submitterEmail)}</p>
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;
}
__name(buildVenueSuggestionEmailHTML, "buildVenueSuggestionEmailHTML");
async function sendVenueSuggestionEmail(toEmail, venueName, html, env, resendApiKey) {
  const from = env.RESEND_FROM_ADDRESS || "Lowcountry Show Tracker <shows@gigalertchs.com>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: toEmail, subject: `New venue suggestion: ${venueName}`, html })
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Resend API responded ${res.status}: ${errBody}`);
  }
}
__name(sendVenueSuggestionEmail, "sendVenueSuggestionEmail");
async function handleAdminStats(request, env, headers) {
  const email = await getEmailFromSession(request, env);
  if (!email) return json({ error: "Not signed in" }, 401, headers);
  const ownerEmail = env.OWNER_EMAIL || "gigalertchs@gmail.com";
  if (email.toLowerCase() !== ownerEmail.toLowerCase()) {
    return json({ error: "Not authorized" }, 403, headers);
  }
  const [subscriberList, userList, suggestionList] = await Promise.all([
    env.SHOW_TRACKER_KV.list({ prefix: "subscriber:" }),
    env.SHOW_TRACKER_KV.list({ prefix: "user:" }),
    env.SHOW_TRACKER_KV.list({ prefix: "suggestion:" })
  ]);
  const subscribers = [];
  for (const key of subscriberList.keys) {
    const raw = await env.SHOW_TRACKER_KV.get(key.name);
    if (!raw) continue;
    const data = JSON.parse(raw);
    subscribers.push({ email: key.name.slice("subscriber:".length), subscribedAt: data.subscribedAt });
  }
  subscribers.sort((a, b) => (b.subscribedAt || 0) - (a.subscribedAt || 0));
  const artistCounts = {};
  const users = [];
  for (const key of userList.keys) {
    const raw = await env.SHOW_TRACKER_KV.get(key.name);
    if (!raw) continue;
    const data = JSON.parse(raw);
    const myShows = Array.isArray(data.myShows) ? data.myShows : [];
    const favorites = Array.isArray(data.favorites) ? data.favorites : [];
    users.push({ email: key.name.slice("user:".length), myShowsCount: myShows.length, favoritesCount: favorites.length });
    favorites.forEach((artist) => {
      const norm = artist.trim();
      if (!norm) return;
      artistCounts[norm] = (artistCounts[norm] || 0) + 1;
    });
  }
  const topFavoriteArtists = Object.entries(artistCounts).map(([artist, count]) => ({ artist, count })).sort((a, b) => b.count - a.count).slice(0, 20);
  const suggestions = [];
  for (const key of suggestionList.keys) {
    const raw = await env.SHOW_TRACKER_KV.get(key.name);
    if (!raw) continue;
    suggestions.push(JSON.parse(raw));
  }
  suggestions.sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));
  return json({
    ok: true,
    subscribers: { count: subscribers.length, list: subscribers },
    users: { count: users.length, list: users },
    topFavoriteArtists,
    suggestions: { count: suggestions.length, list: suggestions }
  }, 200, headers);
}
__name(handleAdminStats, "handleAdminStats");
export {
  worker_default as default
};  }
};
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json"
  };
}
__name(corsHeaders, "corsHeaders");
function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status: status || 200, headers });
}
__name(json, "json");
function isValidEmail(email) {
  if (typeof email !== "string") return false;
  if (/[<>"'`]/.test(email)) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
__name(isValidEmail, "isValidEmail");
async function getTurnstileSecretKey(env) {
  if (!env.TURNSTILE_SECRET_KEY) return null;
  if (typeof env.TURNSTILE_SECRET_KEY.get === "function") {
    return await env.TURNSTILE_SECRET_KEY.get();
  }
  return env.TURNSTILE_SECRET_KEY;
}
__name(getTurnstileSecretKey, "getTurnstileSecretKey");
async function verifyTurnstileToken(token, ip, secretKey) {
  if (!token) return false;
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: secretKey, response: token, remoteip: ip || "" })
    });
    const data = await res.json();
    return data.success === true;
  } catch (err) {
    console.error("Turnstile verification request failed:", err);
    return false;
  }
}
__name(verifyTurnstileToken, "verifyTurnstileToken");
async function handleRequestLink(request, env, headers) {
  const body = await request.json().catch(() => null);
  const email = body && body.email ? String(body.email).trim().toLowerCase() : null;
  const turnstileToken = body && body.turnstileToken ? String(body.turnstileToken) : null;
  if (!isValidEmail(email)) {
    return json({ error: "A valid email address is required" }, 400, headers);
  }
  const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
  const turnstileSecretKey = await getTurnstileSecretKey(env);
  if (turnstileSecretKey) {
    const verified = await verifyTurnstileToken(turnstileToken, clientIp, turnstileSecretKey);
    if (!verified) {
      return json({ error: "Verification failed \u2014 please try again" }, 403, headers);
    }
  }
  const ipRateLimitKey = `ratelimit-ip:${clientIp}`;
  const ipRequestCountRaw = await env.SHOW_TRACKER_KV.get(ipRateLimitKey);
  const ipRequestCount = ipRequestCountRaw ? parseInt(ipRequestCountRaw, 10) : 0;
  if (ipRequestCount >= 10) {
    return json({ error: "Too many sign-in requests from this connection \u2014 please try again later" }, 429, headers);
  }
  await env.SHOW_TRACKER_KV.put(ipRateLimitKey, String(ipRequestCount + 1), { expirationTtl: 3600 });
  const rateLimitKey = `ratelimit:${email}`;
  const alreadyRequested = await env.SHOW_TRACKER_KV.get(rateLimitKey);
  if (alreadyRequested) {
    return json({ error: "Please wait a bit before requesting another link" }, 429, headers);
  }
  await env.SHOW_TRACKER_KV.put(rateLimitKey, "1", { expirationTtl: 60 });
  const token = crypto.randomUUID();
  await env.SHOW_TRACKER_KV.put(
    `token:${token}`,
    JSON.stringify({ email }),
    { expirationTtl: 900 }
    // link is valid for 15 minutes
  );
  const baseUrl = env.WORKER_BASE_URL || DEFAULT_WORKER_BASE_URL;
  const magicLink = `${baseUrl}/api/auth/verify?token=${token}`;
  const resendApiKey = await getResendApiKey(env);
  if (resendApiKey) {
    try {
      await sendMagicLinkEmail(email, magicLink, env, resendApiKey);
      return json({ ok: true, message: "Check your email for a sign-in link" }, 200, headers);
    } catch (err) {
      console.error("sendMagicLinkEmail failed:", err);
      return json({ ok: false, error: "Failed to send the email \u2014 please try again in a moment" }, 502, headers);
    }
  }
  return json({ ok: true, testMode: true, magicLink }, 200, headers);
}
__name(handleRequestLink, "handleRequestLink");
async function getResendApiKey(env) {
  if (!env.RESEND_API_KEY) return null;
  if (typeof env.RESEND_API_KEY.get === "function") {
    return await env.RESEND_API_KEY.get();
  }
  return env.RESEND_API_KEY;
}
__name(getResendApiKey, "getResendApiKey");
async function sendMagicLinkEmail(email, link, env, resendApiKey) {
  const from = env.RESEND_FROM_ADDRESS || "Lowcountry Show Tracker <shows@gigalertchs.com>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${resendApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from,
      to: email,
      subject: "Your Lowcountry Show Tracker sign-in link",
      html: `<p>Click below to sign in to your Show Tracker account:</p>
             <p><a href="${link}">${link}</a></p>
             <p>This link expires in 15 minutes. If you didn't request this, you can ignore it.</p>`
    })
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Resend API responded ${res.status}: ${errBody}`);
  }
}
__name(sendMagicLinkEmail, "sendMagicLinkEmail");
async function handleVerify(request, env, headers) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const siteUrl = env.SITE_URL || DEFAULT_SITE_URL;
  if (!token) {
    return Response.redirect(`${siteUrl}?authError=missing_token`, 302);
  }
  const raw = await env.SHOW_TRACKER_KV.get(`token:${token}`);
  if (!raw) {
    return Response.redirect(`${siteUrl}?authError=invalid_or_expired`, 302);
  }
  const { email } = JSON.parse(raw);
  await env.SHOW_TRACKER_KV.delete(`token:${token}`);
  const sessionToken = crypto.randomUUID();
  await env.SHOW_TRACKER_KV.put(
    `session:${sessionToken}`,
    JSON.stringify({ email }),
    { expirationTtl: 60 * 60 * 24 * 30 }
    // session lasts 30 days
  );
  await ensureSubscribed(email, env);
  const redirectUrl = `${siteUrl}?session=${encodeURIComponent(sessionToken)}&email=${encodeURIComponent(email)}`;
  return Response.redirect(redirectUrl, 302);
}
__name(handleVerify, "handleVerify");
async function ensureSubscribed(email, env) {
  const existing = await env.SHOW_TRACKER_KV.get(`subscriber:${email}`);
  if (existing) return;
  const previouslyUnsubscribed = await env.SHOW_TRACKER_KV.get(`unsubscribed:${email}`);
  if (previouslyUnsubscribed) return;
  const unsubscribeToken = crypto.randomUUID();
  await env.SHOW_TRACKER_KV.put(`subscriber:${email}`, JSON.stringify({ subscribedAt: Date.now(), unsubscribeToken }));
  await env.SHOW_TRACKER_KV.put(`unsubtoken:${unsubscribeToken}`, email);
}
__name(ensureSubscribed, "ensureSubscribed");
async function handleSubscribe(request, env, headers) {
  const email = await getEmailFromSession(request, env);
  if (!email) return json({ error: "Not signed in" }, 401, headers);
  const existing = await env.SHOW_TRACKER_KV.get(`subscriber:${email}`);
  if (existing) {
    return json({ ok: true, message: "You're already subscribed." }, 200, headers);
  }
  const unsubscribeToken = crypto.randomUUID();
  await env.SHOW_TRACKER_KV.put(`subscriber:${email}`, JSON.stringify({ subscribedAt: Date.now(), unsubscribeToken }));
  await env.SHOW_TRACKER_KV.put(`unsubtoken:${unsubscribeToken}`, email);
  await env.SHOW_TRACKER_KV.delete(`unsubscribed:${email}`);
  return json({ ok: true, message: "You're subscribed! You'll get the next digest." }, 200, headers);
}
__name(handleSubscribe, "handleSubscribe");
async function handleUnsubscribe(request, env, headers) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const htmlHeaders = { "Content-Type": "text/html" };
  if (!token) {
    return new Response("<p>Missing unsubscribe token.</p>", { status: 400, headers: htmlHeaders });
  }
  const email = await env.SHOW_TRACKER_KV.get(`unsubtoken:${token}`);
  if (!email) {
    return new Response("<p>This unsubscribe link is invalid or has already been used.</p>", { status: 400, headers: htmlHeaders });
  }
  await env.SHOW_TRACKER_KV.delete(`subscriber:${email}`);
  await env.SHOW_TRACKER_KV.delete(`unsubtoken:${token}`);
  await env.SHOW_TRACKER_KV.put(`unsubscribed:${email}`, JSON.stringify({ unsubscribedAt: Date.now() }));
  return new Response(
    `<p>You've been unsubscribed from the Lowcountry Show Tracker digest. Your My Shows list and Favorite Artists are untouched \u2014 you just won't get the periodic email anymore. You can re-subscribe anytime by signing in again.</p>`,
    { status: 200, headers: htmlHeaders }
  );
}
__name(handleUnsubscribe, "handleUnsubscribe");
function maskEmail(email) {
  const atIndex = email.indexOf("@");
  if (atIndex <= 1) return email;
  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex);
  return local[0] + "*".repeat(Math.max(local.length - 1, 3)) + domain;
}
__name(maskEmail, "maskEmail");
async function handleStarShow(request, env, headers) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const showIdParam = url.searchParams.get("show");
  const confirmed = url.searchParams.get("confirm") === "1";
  const siteUrl = env.SITE_URL || DEFAULT_SITE_URL;
  const baseUrl = env.WORKER_BASE_URL || DEFAULT_WORKER_BASE_URL;
  const htmlHeaders = { "Content-Type": "text/html" };
  if (!token || !showIdParam) {
    return new Response("<p>This link is missing required information.</p>", { status: 400, headers: htmlHeaders });
  }
  const email = await env.SHOW_TRACKER_KV.get(`unsubtoken:${token}`);
  if (!email) {
    return new Response("<p>This link is invalid or has expired. Sign in on the site to manage your My Shows list instead.</p>", { status: 400, headers: htmlHeaders });
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
  const data = raw ? JSON.parse(raw) : { myShows: [], favorites: [] };
  if (!Array.isArray(data.myShows)) data.myShows = [];
  if (!data.myShows.includes(showIdParam)) {
    data.myShows.push(showIdParam);
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
__name(handleStarShow, "handleStarShow");
async function getEmailFromSession(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const sessionToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!sessionToken) return null;
  const raw = await env.SHOW_TRACKER_KV.get(`session:${sessionToken}`);
  if (!raw) return null;
  return JSON.parse(raw).email;
}
__name(getEmailFromSession, "getEmailFromSession");
async function handleGetUserData(request, env, headers) {
  const email = await getEmailFromSession(request, env);
  if (!email) return json({ error: "Not signed in" }, 401, headers);
  const raw = await env.SHOW_TRACKER_KV.get(`user:${email}`);
  const data = raw ? JSON.parse(raw) : { myShows: [], favorites: [] };
  return json({ ok: true, data }, 200, headers);
}
__name(handleGetUserData, "handleGetUserData");
async function handleSaveUserData(request, env, headers) {
  const email = await getEmailFromSession(request, env);
  if (!email) return json({ error: "Not signed in" }, 401, headers);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return json({ error: "Invalid request body" }, 400, headers);
  const isSafeFavorite = /* @__PURE__ */ __name((f) => typeof f === "string" && f.trim().length > 0 && f.length <= 100 && !/[<>]/.test(f), "isSafeFavorite");
  const data = {
    myShows: Array.isArray(body.myShows) ? body.myShows.filter((id) => typeof id === "string") : [],
    favorites: Array.isArray(body.favorites) ? body.favorites.filter(isSafeFavorite) : []
  };
  await env.SHOW_TRACKER_KV.put(`user:${email}`, JSON.stringify(data));
  return json({ ok: true }, 200, headers);
}
__name(handleSaveUserData, "handleSaveUserData");
function showId(s) {
  return [s.v, s.d, s.b].join("|").toLowerCase().replace(/\s+/g, "_");
}
__name(showId, "showId");
function isUnknownTime(t) {
  return !t || /see ticket link|tba|^—$/i.test(t.trim());
}
__name(isUnknownTime, "isUnknownTime");
async function fetchShowData(env) {
  const siteUrl = env.SITE_URL || DEFAULT_SITE_URL;
  const res = await fetch(new URL("shows.json", siteUrl).toString(), { cf: { cacheTtl: 300 } });
  if (!res.ok) throw new Error(`Failed to fetch shows.json: ${res.status}`);
  return await res.json();
}
__name(fetchShowData, "fetchShowData");
function upcomingShows(shows) {
  const cutoff = new Date(Date.now() - 1 * 24 * 60 * 60 * 1e3).toISOString().slice(0, 10);
  return shows.filter((s) => (s.e || s.d) >= cutoff).sort((a, b) => a.d.localeCompare(b.d));
}
__name(upcomingShows, "upcomingShows");
function fmtShortDate(iso) {
  const d = /* @__PURE__ */ new Date(iso + "T12:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}
__name(fmtShortDate, "fmtShortDate");
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
__name(escapeHtml, "escapeHtml");
function buildDigestEmailHTML({ shows, venues, unsubscribeLink, siteUrl, baseUrl, myShowIds = [], starToken = null }) {
  const upcoming = upcomingShows(shows);
  const recentCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1e3).toISOString().slice(0, 10);
  const recentlyAddedShows = upcoming.filter((s) => s.added && s.added >= recentCutoff);
  const recentlyAddedIds = new Set(recentlyAddedShows.map(showId));
  const myShowsUpcoming = upcoming.filter((s) => myShowIds.includes(showId(s)));
  const myShowsIdSet = new Set(myShowsUpcoming.map(showId));
  const otherShows = upcoming.filter((s) => !recentlyAddedIds.has(showId(s)) && !myShowsIdSet.has(showId(s)));
  function starLinkHtml(s) {
    if (!starToken) return "";
    const id = showId(s);
    const already = myShowIds.includes(id);
    const href = `${baseUrl}/api/star-show?show=${encodeURIComponent(id)}&token=${encodeURIComponent(starToken)}`;
    return `<a href="${href}" style="text-decoration:none; font-size:16px; color:${already ? "#e0c46a" : "#4a4e5e"};">${already ? "&#9733;" : "&#9734;"}</a>`;
  }
  __name(starLinkHtml, "starLinkHtml");
  function showRowHtml(s, isFavorite) {
    const venue = venues[s.v] || { name: s.v };
    const showKnown = !isUnknownTime(s.sh);
    const doorsKnown = !isUnknownTime(s.dr);
    let timeBlockInner;
    if (!showKnown && !doorsKnown) {
      timeBlockInner = `<div style="font-family:Georgia, 'Times New Roman', serif; font-size:15px; color:#f0a83c; line-height:1.1;">Time</div><div style="font-size:9px; color:#9599ad; letter-spacing:1px; margin-top:2px;">TBD</div>`;
    } else {
      const showLine = showKnown ? `<div style="font-family:Georgia, 'Times New Roman', serif; font-size:14px; color:#f0a83c; line-height:1.1;">${escapeHtml(s.sh)}</div><div style="font-size:9px; color:#9599ad; letter-spacing:1px; margin-top:2px;">SHOW</div>` : "";
      const doorsLine = doorsKnown ? `<div style="font-family:Georgia, 'Times New Roman', serif; font-size:14px; color:#eee9db; line-height:1.1; margin-top:${showKnown ? "6px" : "0"};">${escapeHtml(s.dr)}</div><div style="font-size:9px; color:#9599ad; letter-spacing:1px; margin-top:2px;">DOORS</div>` : "";
      timeBlockInner = showLine + doorsLine;
    }
    let priceOrTix;
    const rawTicketUrl = String(s.u || venue.site || "").trim();
    const ticketUrl = /^https?:\/\//i.test(rawTicketUrl) ? escapeHtml(rawTicketUrl) : "";
    const todayStr = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    const isShowDay = todayStr === s.d;
    const effectivePrice = isShowDay && typeof s.dop === "number" ? s.dop : s.p;
    if (typeof effectivePrice === "number") {
      const label = effectivePrice === 0 ? "Free" : `$${Math.round(effectivePrice)}`;
      priceOrTix = ticketUrl ? `<a href="${ticketUrl}" style="color:#4fd1b0; text-decoration:none;">${label}</a>` : label;
    } else {
      priceOrTix = ticketUrl ? `<a href="${ticketUrl}" style="color:#4fd1b0; text-decoration:none;">Tickets</a>` : "";
    }
    const openerLine = s.o ? `<div style="font-size:12px; color:#9599ad; margin-top:3px;">w/ ${escapeHtml(s.o)}</div>` : "";
    const leftBorder = isFavorite ? "border-left:3px solid #e0c46a;" : "";
    const venueStageTable = `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:5px;">
        <tr>
          <td width="56" valign="top" style="font-size:12px; color:#c9cddb; white-space:nowrap;">${priceOrTix ? priceOrTix + " &middot;" : ""}</td>
          <td style="font-size:12px; color:#c9cddb;">${escapeHtml(venue.name)}</td>
        </tr>
        ${s.s ? `<tr>
          <td width="56"></td>
          <td style="font-size:11.5px; color:#9599ad; font-style:italic; padding-top:2px;">${escapeHtml(s.s)}</td>
        </tr>` : ""}
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
  __name(showRowHtml, "showRowHtml");
  const myShowsRowsHtml = myShowsUpcoming.map((s) => showRowHtml(s, false)).join("");
  const recentlyAddedRowsHtml = recentlyAddedShows.map((s) => showRowHtml(s, false)).join("");
  const otherRowsHtml = otherShows.map((s) => showRowHtml(s, false)).join("");
  const myShowsSectionHtml = myShowsUpcoming.length ? `
    <tr><td style="padding:16px 24px 10px 24px;">
      <div style="font-size:13px; font-weight:bold; color:#e0c46a; text-transform:uppercase; letter-spacing:1px; border-bottom:2px solid #e0c46a; padding-bottom:6px; margin-bottom:12px;">My Shows</div>
    </td></tr>
    <tr><td style="padding:0 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${myShowsRowsHtml}</table></td></tr>` : "";
  const recentlyAddedSectionHtml = recentlyAddedShows.length ? `
    <tr><td style="padding:16px 24px 10px 24px;">
      <div style="font-size:13px; font-weight:bold; color:#4fd1b0; text-transform:uppercase; letter-spacing:1px; border-bottom:2px solid #4fd1b0; padding-bottom:6px; margin-bottom:12px;">Added This Week</div>
    </td></tr>
    <tr><td style="padding:0 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${recentlyAddedRowsHtml}</table></td></tr>` : "";
  const signInCtaHtml = `
    <tr><td style="padding:20px 24px; text-align:center;">
      <div style="background-color:#1b1e2a; border:1px solid #2c3040; border-radius:8px; padding:16px;">
        <div style="font-size:13px; color:#c9cddb; margin-bottom:10px;">Tap a star above to add a show to My Shows. Sign in on the site to manage your favorited artists.</div>
        <a href="${siteUrl}" target="_blank" style="color:#e0c46a; font-size:13px; font-weight:bold; text-decoration:none;">Sign in to see your favorites \u2192</a>
      </div>
    </td></tr>`;
  const otherSectionHtml = otherShows.length ? `
    <tr><td style="padding:8px 24px 10px 24px;">
      <div style="font-size:13px; font-weight:bold; color:#eee9db; text-transform:uppercase; letter-spacing:1px; border-bottom:2px solid #2c3040; padding-bottom:6px; margin-bottom:12px;">Everything Else Coming Up</div>
    </td></tr>
    <tr><td style="padding:0 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${otherRowsHtml}</table></td></tr>` : "";
  const emptyStateHtml = !recentlyAddedShows.length && !otherShows.length && !myShowsUpcoming.length ? `
    <tr><td style="padding:24px; text-align:center; color:#9599ad; font-size:13px;">Nothing new on the calendar this week.</td></tr>` : "";
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; background-color:#0d0f16; font-family:Arial, Helvetica, sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0d0f16;">
<tr><td align="center" style="padding:24px 12px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; width:100%; background-color:#12141c; border-radius:8px; overflow:hidden; border:1px solid #2c3040;">
    <tr><td style="background-color:#12141c; padding:28px 24px; text-align:center; border-bottom:1px solid #2c3040;">
      <div style="font-family:Georgia, 'Times New Roman', serif; letter-spacing:2px; color:#f0a83c; font-size:22px; font-weight:bold;">LOWCOUNTRY SHOW TRACKER</div>
      <div style="color:#9599ad; font-size:13px; margin-top:6px;">Live music across Charleston</div>
    </td></tr>
    <tr><td style="padding:24px 24px 8px 24px; font-size:14px; color:#eee9db; line-height:1.5;">
      Hey there \u2014 here's what's new on the tracker this week.
    </td></tr>
    ${myShowsSectionHtml}
    ${recentlyAddedSectionHtml}
    ${signInCtaHtml}
    ${otherSectionHtml}
    ${emptyStateHtml}
    <tr><td align="center" style="padding:28px 24px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td align="center" bgcolor="#f0a83c" style="border-radius:6px;">
          <a href="${siteUrl}" target="_blank" style="display:inline-block; padding:12px 28px; font-size:14px; font-weight:bold; color:#12141c; text-decoration:none; font-family:Arial, Helvetica, sans-serif;">Manage Your List \u2192</a>
        </td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:20px 24px 28px 24px; text-align:center; border-top:1px solid #2c3040;">
      <div style="font-size:11px; color:#9599ad; line-height:1.6;">
        You're getting this because you signed up for Lowcountry Show Tracker updates.<br>
        <a href="${unsubscribeLink}" style="color:#9599ad; text-decoration:underline;">Unsubscribe</a>
        &nbsp;\xB7&nbsp;
        <a href="${siteUrl}" style="color:#9599ad; text-decoration:underline;">Manage preferences</a>
      </div>
    </td></tr>
    </table>
</td></tr>
</table>
</body></html>`;
}
__name(buildDigestEmailHTML, "buildDigestEmailHTML");
async function sendDigestEmail(email, html, env, resendApiKey) {
  const from = env.RESEND_FROM_ADDRESS || "Lowcountry Show Tracker <shows@gigalertchs.com>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: email, subject: "This Week in Charleston Live Music", html })
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Resend API responded ${res.status}: ${errBody}`);
  }
}
__name(sendDigestEmail, "sendDigestEmail");
async function sendDigestToAllSubscribers(env) {
  const resendApiKey = await getResendApiKey(env);
  if (!resendApiKey) {
    console.error("sendDigestToAllSubscribers: no Resend API key configured, aborting.");
    return;
  }
  const showData = await fetchShowData(env);
  const siteUrl = env.SITE_URL || DEFAULT_SITE_URL;
  const baseUrl = env.WORKER_BASE_URL || DEFAULT_WORKER_BASE_URL;
  const list = await env.SHOW_TRACKER_KV.list({ prefix: "subscriber:" });
  for (const key of list.keys) {
    const email = key.name.slice("subscriber:".length);
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
__name(sendDigestToAllSubscribers, "sendDigestToAllSubscribers");
async function handleDigestPreview(request, env, headers) {
  const email = await getEmailFromSession(request, env);
  if (!email) return json({ error: "Not signed in" }, 401, headers);
  const subRaw = await env.SHOW_TRACKER_KV.get(`subscriber:${email}`);
  const sub = subRaw ? JSON.parse(subRaw) : { unsubscribeToken: "preview" };
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
  return new Response(html, { status: 200, headers: { ...headers, "Content-Type": "text/html" } });
}
__name(handleDigestPreview, "handleDigestPreview");
async function handleTestSendDigestNow(request, env, headers) {
  const email = await getEmailFromSession(request, env);
  if (!email) return json({ error: "Not signed in" }, 401, headers);
  const ownerEmail = env.OWNER_EMAIL || "gigalertchs@gmail.com";
  if (email.toLowerCase() !== ownerEmail.toLowerCase()) {
    return json({ error: "Not authorized" }, 403, headers);
  }
  try {
    await sendDigestToAllSubscribers(env);
    return json({ ok: true, message: "Digest send attempted for all current subscribers \u2014 check inboxes, and Cloudflare's logs if anything looks off." }, 200, headers);
  } catch (err) {
    return json({ error: "Digest send failed", detail: String(err && err.message || err) }, 500, headers);
  }
}
__name(handleTestSendDigestNow, "handleTestSendDigestNow");
async function getCoworkApiSecret(env) {
  if (!env.COWORK_API_SECRET) return null;
  if (typeof env.COWORK_API_SECRET.get === "function") return await env.COWORK_API_SECRET.get();
  return env.COWORK_API_SECRET;
}
__name(getCoworkApiSecret, "getCoworkApiSecret");
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
__name(timingSafeEqual, "timingSafeEqual");
async function handleReportConflicts(request, env, headers) {
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const expected = await getCoworkApiSecret(env);
  if (!expected || !timingSafeEqual(token, expected)) {
    return json({ error: "Unauthorized" }, 401, headers);
  }
  const body = await request.json().catch(() => null);
  const conflicts = body && Array.isArray(body.conflicts) ? body.conflicts.filter((c) => typeof c === "string" && c.trim().length > 0) : [];
  if (conflicts.length === 0) {
    return json({ ok: true, message: "No conflicts reported \u2014 nothing sent." }, 200, headers);
  }
  const resendApiKey = await getResendApiKey(env);
  if (!resendApiKey) {
    return json({ error: "No Resend API key configured \u2014 cannot send conflict report" }, 500, headers);
  }
  const ownerEmail = env.OWNER_EMAIL || "gigalertchs@gmail.com";
  const html = buildConflictReportHTML(conflicts);
  try {
    await sendConflictReportEmail(ownerEmail, html, env, resendApiKey);
    return json({ ok: true, message: `Conflict report sent to ${ownerEmail} (${conflicts.length} item(s)).` }, 200, headers);
  } catch (err) {
    return json({ error: "Failed to send conflict report", detail: String(err && err.message || err) }, 500, headers);
  }
}
__name(handleReportConflicts, "handleReportConflicts");
function buildConflictReportHTML(conflicts) {
  const itemsHtml = conflicts.map(
    (c) => `<li style="margin-bottom:10px; font-size:14px; color:#333333; line-height:1.5;">${escapeHtml(c)}</li>`
  ).join("");
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; background-color:#f4f2ec; font-family:Arial, Helvetica, sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f2ec;">
<tr><td align="center" style="padding:24px 12px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; width:100%; background-color:#ffffff; border-radius:8px; overflow:hidden;">
    <tr><td style="background-color:#12141c; padding:24px; text-align:center;">
      <div style="font-family:Georgia, 'Times New Roman', serif; letter-spacing:1px; color:#f0a83c; font-size:18px; font-weight:bold;">SHOW TRACKER \u2014 RESEARCH REVIEW NEEDED</div>
    </td></tr>
    <tr><td style="padding:20px 24px 8px 24px; font-size:14px; color:#333333; line-height:1.5;">
      The latest automated venue research run pushed its routine update, but flagged ${conflicts.length} item${conflicts.length === 1 ? "" : "s"} it wasn't confident enough to decide on its own:
    </td></tr>
    <tr><td style="padding:0 24px 24px 24px;">
      <ul style="padding-left:20px; margin:0;">${itemsHtml}</ul>
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;
}
__name(buildConflictReportHTML, "buildConflictReportHTML");
async function sendConflictReportEmail(toEmail, html, env, resendApiKey) {
  const from = env.RESEND_FROM_ADDRESS || "Lowcountry Show Tracker <shows@gigalertchs.com>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: toEmail, subject: "Show Tracker: research review needed", html })
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Resend API responded ${res.status}: ${errBody}`);
  }
}
__name(sendConflictReportEmail, "sendConflictReportEmail");
async function handleSuggestVenue(request, env, headers) {
  const submitterEmail = await getEmailFromSession(request, env);
  if (!submitterEmail) return json({ error: "Not signed in" }, 401, headers);
  const body = await request.json().catch(() => null);
  const venueName = body && typeof body.venueName === "string" ? body.venueName.trim() : "";
  const notes = body && typeof body.notes === "string" ? body.notes.trim() : "";
  const turnstileToken = body && body.turnstileToken ? String(body.turnstileToken) : null;
  if (!venueName) {
    return json({ error: "Venue name is required" }, 400, headers);
  }
  if (venueName.length > 200 || notes.length > 2e3) {
    return json({ error: "That input is too long" }, 400, headers);
  }
  if (/[<>]/.test(venueName) || /[<>]/.test(notes)) {
    return json({ error: "Please remove < and > characters from your submission" }, 400, headers);
  }
  const turnstileSecretKey = await getTurnstileSecretKey(env);
  if (turnstileSecretKey) {
    const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
    const verified = await verifyTurnstileToken(turnstileToken, clientIp, turnstileSecretKey);
    if (!verified) {
      return json({ error: "Verification failed \u2014 please try again" }, 403, headers);
    }
  }
  const rateLimitKey = `suggest-ratelimit:${submitterEmail}`;
  const alreadySubmitted = await env.SHOW_TRACKER_KV.get(rateLimitKey);
  if (alreadySubmitted) {
    return json({ error: "Please wait a bit before submitting another suggestion" }, 429, headers);
  }
  await env.SHOW_TRACKER_KV.put(rateLimitKey, "1", { expirationTtl: 60 });
  const id = crypto.randomUUID();
  const record = { submitterEmail, venueName, notes, submittedAt: Date.now() };
  await env.SHOW_TRACKER_KV.put(`suggestion:${id}`, JSON.stringify(record));
  const resendApiKey = await getResendApiKey(env);
  if (resendApiKey) {
    try {
      const html = buildVenueSuggestionEmailHTML(record);
      const ownerEmail = env.OWNER_EMAIL || "gigalertchs@gmail.com";
      await sendVenueSuggestionEmail(ownerEmail, venueName, html, env, resendApiKey);
    } catch (err) {
      console.error("Failed to send venue suggestion notification:", err);
    }
  }
  return json({ ok: true, message: "Thanks \u2014 your suggestion has been sent!" }, 200, headers);
}
__name(handleSuggestVenue, "handleSuggestVenue");
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
      ${notes ? `<p><strong>Notes:</strong> ${escapeHtml(notes)}</p>` : ""}
      <p><strong>Suggested by:</strong> ${escapeHtml(submitterEmail)}</p>
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;
}
__name(buildVenueSuggestionEmailHTML, "buildVenueSuggestionEmailHTML");
async function sendVenueSuggestionEmail(toEmail, venueName, html, env, resendApiKey) {
  const from = env.RESEND_FROM_ADDRESS || "Lowcountry Show Tracker <shows@gigalertchs.com>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: toEmail, subject: `New venue suggestion: ${venueName}`, html })
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Resend API responded ${res.status}: ${errBody}`);
  }
}
__name(sendVenueSuggestionEmail, "sendVenueSuggestionEmail");
async function handleAdminStats(request, env, headers) {
  const email = await getEmailFromSession(request, env);
  if (!email) return json({ error: "Not signed in" }, 401, headers);
  const ownerEmail = env.OWNER_EMAIL || "gigalertchs@gmail.com";
  if (email.toLowerCase() !== ownerEmail.toLowerCase()) {
    return json({ error: "Not authorized" }, 403, headers);
  }
  const [subscriberList, userList, suggestionList] = await Promise.all([
    env.SHOW_TRACKER_KV.list({ prefix: "subscriber:" }),
    env.SHOW_TRACKER_KV.list({ prefix: "user:" }),
    env.SHOW_TRACKER_KV.list({ prefix: "suggestion:" })
  ]);
  const subscribers = [];
  for (const key of subscriberList.keys) {
    const raw = await env.SHOW_TRACKER_KV.get(key.name);
    if (!raw) continue;
    const data = JSON.parse(raw);
    subscribers.push({ email: key.name.slice("subscriber:".length), subscribedAt: data.subscribedAt });
  }
  subscribers.sort((a, b) => (b.subscribedAt || 0) - (a.subscribedAt || 0));
  const artistCounts = {};
  const users = [];
  for (const key of userList.keys) {
    const raw = await env.SHOW_TRACKER_KV.get(key.name);
    if (!raw) continue;
    const data = JSON.parse(raw);
    const myShows = Array.isArray(data.myShows) ? data.myShows : [];
    const favorites = Array.isArray(data.favorites) ? data.favorites : [];
    users.push({ email: key.name.slice("user:".length), myShowsCount: myShows.length, favoritesCount: favorites.length });
    favorites.forEach((artist) => {
      const norm = artist.trim();
      if (!norm) return;
      artistCounts[norm] = (artistCounts[norm] || 0) + 1;
    });
  }
  const topFavoriteArtists = Object.entries(artistCounts).map(([artist, count]) => ({ artist, count })).sort((a, b) => b.count - a.count).slice(0, 20);
  const suggestions = [];
  for (const key of suggestionList.keys) {
    const raw = await env.SHOW_TRACKER_KV.get(key.name);
    if (!raw) continue;
    suggestions.push(JSON.parse(raw));
  }
  suggestions.sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));
  return json({
    ok: true,
    subscribers: { count: subscribers.length, list: subscribers },
    users: { count: users.length, list: users },
    topFavoriteArtists,
    suggestions: { count: suggestions.length, list: suggestions }
  }, 200, headers);
}
__name(handleAdminStats, "handleAdminStats");
export {
  worker_default as default
};
