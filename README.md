# Prompt Library

A personal, static prompt library — searchable and filterable by skill (Gmail, Homework,
Studying, Writing, ...) and by which LLM a prompt is tuned for. No backend: everything is
a static site reading from `data/prompts.json`.

## Adding a new prompt

**On the site:** click **Add a prompt** and step through the wizard (skill → LLM → title →
prompt text → review). It saves to your browser (`localStorage`) and shows up immediately.
A basic language guardrail blocks obviously harsh/hostile wording, discriminatory
generalizations, and script-injection attempts before saving — it's a simple keyword/
pattern check, not real moderation, so treat it as a first line of defense, not a
guarantee.

Anything added through the wizard lives only in that browser until you export it. Click
**Export prompts.json** to download the merged file (seed + your additions), then replace
`data/prompts.json` with it and commit — that's what makes a new prompt visible from other
devices or after clearing browser data.

**Directly in the file:** open `data/prompts.json` and add an entry to the array:

```json
{
  "id": "some-unique-id",
  "title": "Short, descriptive title",
  "skill": "Studying",
  "llm": "Claude",
  "prompt": "The full prompt text, with [placeholders] for what you'll paste in."
}
```

- `skill` and `llm` dropdowns on the site are generated automatically from whatever values
  appear in the file — no code changes needed to add a new skill or model.
- Use `"llm": "Any"` for prompts that aren't tied to a specific model. They'll show up
  regardless of which model filter is selected.

Easiest way to edit on the go: open `data/prompts.json` in GitHub's web editor (press `.`
on the repo page, or edit the file directly on github.com) and commit — no local setup
needed.

## Security log (hidden from visitors on purpose)

Every blocked wizard submission (harsh language, bias pattern, script-injection attempt)
is recorded locally in that browser's `localStorage`. There's no visible button for it —
open it yourself with **Ctrl+Shift+L** (or **Cmd+Shift+L** on Mac) while on the site. From
there you can view, export, or clear the log.

### Slack alerts (optional)

A static GitHub Pages site can't safely hold a Slack webhook secret client-side — anyone
viewing source could grab and abuse it. So alerts go through a tiny relay instead:

```
site (GitHub Pages) → Cloudflare Worker (holds the Slack secret) → Slack
```

To turn it on:

1. Create a Slack Incoming Webhook (Slack app settings → **Incoming Webhooks** → **Add New
   Webhook to Workspace**).
2. Deploy `cloudflare-worker/worker.js` as a Cloudflare Worker (free, no card required):
   **Workers & Pages → Create Application → Create Worker**, paste in the file's contents
   via **Edit code**, deploy.
3. In the Worker's **Settings → Variables**, add an environment variable
   `SLACK_WEBHOOK_URL` set to your webhook URL, and check **Encrypt**. The webhook never
   touches this repo or the site's source.
4. Copy the Worker's public URL (`https://<name>.<subdomain>.workers.dev`) into
   `script.js`, as the value of `SECURITY_RELAY_URL` near the top of the file.
5. (Optional, tighter CORS) Add another Worker environment variable `ALLOWED_ORIGIN` set
   to your GitHub Pages URL (e.g. `https://yourname.github.io`) instead of the default `*`.

Without step 4, the site works exactly as before — local log only, nothing sent anywhere.

The site also client-side rate-limits itself to 5 relay notifications per 10 minutes so a
burst of blocked attempts doesn't flood the channel. That's a courtesy limit, not real
abuse-resistance (it's just `localStorage`) — if this ever gets meaningful traffic, add a
Cloudflare rate-limiting rule on the Worker's route for a real backstop.

## Running locally

This is a static site, so it just needs to be served over `http://`, not opened directly
as a `file://` URL (the browser blocks the JSON fetch otherwise):

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

## Deploying to GitHub Pages

1. Push this folder to a GitHub repo.
2. In the repo, go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to "Deploy from a branch", branch
   `main`, folder `/ (root)`.
4. Save — GitHub gives you a `https://<username>.github.io/<repo>/` URL a minute later.
