// Cloudflare Worker: CORS proxy for the BOT (Bank of Thailand) Average Exchange Rate API.
//
// Why this exists: gateway.api.bot.or.th doesn't send an Access-Control-Allow-Origin header,
// so a browser blocks any direct fetch() to it from a static web page (curl/Postman work fine
// because CORS is a browser-only restriction). This worker sits in between: the browser calls
// this worker instead, the worker calls BOT server-to-server (no CORS involved there), and adds
// the CORS headers itself before handing the response back.
//
// Deploy (Cloudflare dashboard, no CLI needed):
//   1. workers.cloudflare.com -> sign in / create a free account
//   2. Create application -> Create Worker -> give it a name (e.g. "bot-rate-proxy") -> Deploy
//   3. Edit code -> replace the default script with everything below -> Save and deploy
//   4. Copy the resulting URL (looks like https://bot-rate-proxy.<your-subdomain>.workers.dev)
//   5. Paste that URL into the "BOT Proxy URL" field in the app's Monthly Report tab
//
// This only ever forwards requests to the one BOT endpoint below and only ever forwards the
// Authorization header it was given -- it isn't an open proxy, and your BOT token never touches
// any third party other than Cloudflare (running your own worker) and BOT itself.

const UPSTREAM_ORIGIN = 'https://gateway.api.bot.or.th';
const ALLOWED_PATH_PREFIX = '/Stat-ExchangeRate/v2/DAILY_AVG_EXG_RATE/';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
    'Access-Control-Max-Age': '86400',
  };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (request.method !== 'GET' || !url.pathname.startsWith(ALLOWED_PATH_PREFIX)) {
      return new Response('Not found', { status: 404, headers: corsHeaders() });
    }

    const upstreamUrl = UPSTREAM_ORIGIN + url.pathname + url.search;

    let upstreamResponse;
    try {
      upstreamResponse = await fetch(upstreamUrl, {
        method: 'GET',
        headers: {
          'Accept': '*/*',
          'Authorization': request.headers.get('Authorization') || '',
        },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'Upstream request failed', message: String(err) }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
    }

    const body = await upstreamResponse.text();
    return new Response(body, {
      status: upstreamResponse.status,
      headers: {
        'Content-Type': upstreamResponse.headers.get('Content-Type') || 'application/json',
        ...corsHeaders(),
      },
    });
  },
};
