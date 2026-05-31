# Troubleshooting

## Login problems

**Can't log in.** First check: is your account status `active`? If `past_due` or `suspended`, billing is the issue — fix payment, then retry.

**Magic link expired.** Magic links are valid for 1 hour. Request a new one from the login page.

**SSO redirect loop.** Usually a stale browser session. Try incognito mode, or clear cookies for the SSO provider and Acme.

## Performance / connectivity

**Slow dashboard.** Likely your region's nearest edge. Try the region selector at the bottom of the page. Most US users get fastest performance on `us-east`; EU on `eu-west`; APAC on `ap-southeast`.

**API requests timing out.** Check our status page at status.acme.example. If green, retry with backoff. Persistent timeouts: open a ticket with the request ids and timestamps.

**Webhooks not firing.** Webhooks are Pro+. Check the webhook log at **Settings → Webhooks → History**. We retry failed deliveries with exponential backoff for 24 hours.

## Data import / export

**CSV import errors.** Common causes: encoding (use UTF-8), missing required columns, dates not in ISO-8601. The import preview shows row-level errors; fix and re-import.

**Export taking too long.** Exports of >100k rows are processed async; you'll get an email with a download link. Links expire after 7 days.

## Integrations

**Slack integration silent.** Reconnect at **Settings → Integrations → Slack**. The bot needs `channels:read`, `chat:write`, `users:read` scopes. If you migrated workspaces, reauthorize.

**Webhook signing.** Webhooks include an `X-Acme-Signature` header (HMAC-SHA256 of the body). Verify with your webhook secret from **Settings → Webhooks → Signing key**.
