# AnimaCut launch support playbook

## First response checklist

Ask for the account email, project ID, approximate failure time, browser/device, and a screenshot. Never ask for a password, full Stripe card number, source-video URL, or customer media by email.

## Failed or stuck processing

1. Open `/dashboard/admin/health` and check queued, processing, failed, and stale counts.
2. Open the project from the stale-project list and inspect its current stage.
3. Ask the customer to use **Retry processing** once. The retry reuses the saved project and does not consume minutes again.
4. If it remains stale for ten minutes, verify both PM2 workers are online and inspect worker logs before retrying again.
5. Escalate repeatable failures with the project ID and Sentry event; do not request the customer’s video unless they explicitly consent.

## Upload failures

Confirm the source duration is within the plan limit, the format is supported, and the browser remained open until multipart upload completed. Retry from a current Safari or Chrome release. Check R2 CORS and storage availability if several users fail simultaneously.

## Missing minutes

Compare `profiles.processing_minutes_*` with `usage_ledger`. Never manually add minutes without recording a compensating ledger entry and the support reason.

## Billing

Use Stripe’s event log and `/dashboard/admin/health`. For upgrades, confirm the previewed proration, invoice, and current subscription price. Never create a second subscription to fix an upgrade. Refunds and charge disputes require owner approval and must be performed in Stripe.

## Account deletion

Confirm the account route canceled any active subscription, removed project artifacts, unlinked retained financial events, and deleted the Supabase Auth user. Do not restore deleted media from backups without explicit customer consent.

## Launch verification matrix

- Safari on iPhone: sign up, reset password, upload, background/foreground, playback, caption drag, download.
- Chrome on Android: same flow.
- Desktop Safari and Chrome: YouTube import and local upload.
- Stripe test mode: new subscription, prorated upgrade, payment requiring authentication, failed renewal, successful renewal, cancel at period end, account deletion.
- Plan limits: upload a synthetic file at each configured maximum and one file just above it for Starter, Creator, and Pro.
- Notifications: verify exactly one success email and one failure email per project state.
- Retention: verify active queued/processing project IDs are excluded from temporary cleanup.

Record date, environment, tester, device/browser version, project ID, Stripe test customer, expected result, actual result, and evidence for each run.
