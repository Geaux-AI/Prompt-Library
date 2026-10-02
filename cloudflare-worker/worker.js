/**
 * Prompt Library — security event relay.
 *
 * Sits between the static site (GitHub Pages) and Slack. The site never
 * talks to Slack directly, and never holds the webhook URL — this Worker
 * does, as an encrypted environment variable (SLACK_WEBHOOK_URL), set in
 * the Cloudflare dashboard under Settings -> Variables.
 *
 * Deploy: paste this whole file into the Worker's "Edit code" editor in
 * the Cloudflare dashboard and click Deploy.
 */

const MAX_TYPE_LEN = 100;
const MAX_DETAIL_LEN = 500;
const MAX_TIME_LEN = 50;

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export default {
  async fetch(request, env) {
    const headers = corsHeaders(env);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers });
    }

    if (!env.SLACK_WEBHOOK_URL) {
      return new Response(JSON.stringify({ ok: false, error: "relay_not_configured" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...headers },
      });
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return new Response(JSON.stringify({ ok: false, error: "invalid_json" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...headers },
      });
    }

    const type = String(payload?.type || "unknown").slice(0, MAX_TYPE_LEN);
    const detail = String(payload?.detail || "").slice(0, MAX_DETAIL_LEN);
    const time = String(payload?.time || new Date().toISOString()).slice(0, MAX_TIME_LEN);

    if (!detail) {
      return new Response(JSON.stringify({ ok: false, error: "missing_detail" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...headers },
      });
    }

    const text =
      `:rotating_light: *Prompt Library security event*\n` +
      `*Type:* ${type}\n*Detail:* ${detail}\n*Time:* ${time}`;

    try {
      const slackResponse = await fetch(env.SLACK_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });

      return new Response(JSON.stringify({ ok: slackResponse.ok }), {
        status: slackResponse.ok ? 200 : 502,
        headers: { "Content-Type": "application/json", ...headers },
      });
    } catch {
      return new Response(JSON.stringify({ ok: false, error: "slack_unreachable" }), {
        status: 502,
        headers: { "Content-Type": "application/json", ...headers },
      });
    }
  },
};
