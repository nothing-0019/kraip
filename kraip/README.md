# KRAIP
AI employees that talk to customers, research, qualify leads and help businesses act.

## Run (5 minutes)
1. Install Node 18+ and Ollama (ollama.com), then: `ollama pull qwen2.5:3b`
2. `cp .env.example .env`
3. `npm install && npm start`
4. Open http://localhost:3000, sign up, create a business, create an employee, activate it, chat.

If you upgraded from an earlier version, delete `data/kraip.db` once (the schema changed).

## What works without any account or key
Login and tenant isolation, Business Twin with version history, AI employees (draft -> active),
chat, browser voice (Chrome/Edge/Android), lead extraction + scoring + dedupe, human handoff inbox,
summaries, consent records and opt-outs, campaign dry runs, usage metering, invoices, audit log,
CSV export, fine-tune data export, embeddable web chat at `/widget.html?e=<employeeId>`.

## What needs keys (add to .env)
| Feature | Needs |
|---|---|
| Live web research + lead discovery | `TAVILY_API_KEY` (or `BRAVE_API_KEY`) |
| Phone calls, low cost (recommended) | Plivo account + number (`PLIVO_*`), Sarvam key (`SARVAM_API_KEY`), `PUBLIC_URL` (https) |
| Phone calls, simple but pricier | Twilio (`TWILIO_*`, `PHONE_PROVIDER=twilio`) |
| Payment links | `RAZORPAY_*` |
| Gemini fallback | `GEMINI_API_KEY` |

## Phone setup (Plivo + Sarvam)
How a call works: caller -> Plivo -> live audio stream to KRAIP -> Sarvam speech-to-text -> your AI employee -> Sarvam text-to-speech -> caller.
The caller can interrupt the AI, the AI hands over to a human on request, and calls are capped at `MAX_CALL_SECONDS`.

1. Plivo console: create an **Application**. Answer URL (POST) and Hangup URL (POST): paste the exact URLs shown for your employee in the Employees tab (they end in `?k=...`, which authenticates Plivo's requests). Attach your number to it. (Each employee's exact URL is shown in the Employees tab.)
2. Locally: `ngrok http 3000` and put the https address in `PUBLIC_URL`.
3. Put the Plivo and Sarvam keys in `.env`, restart, call your number.
4. Outbound campaigns need nothing extra: KRAIP sets the call URLs itself.

Webhooks are verified by the `?k=` key or Plivo's V3 signature. The audio socket is protected by a short-lived per-call signed token. Before going live, run `npm run voice-check` (tests your Sarvam key and the audio format, writes `voice-check.wav`).

### First real call checklist (not testable without live accounts)
Everything below was built from the providers' docs and tested only against mock servers, so check these on your first calls:
- You hear the greeting, and your replies are understood (if speech is not recognised, try `SARVAM_STT_MODEL=saaras:v3`, or tell me what the Sarvam error says in the server log).
- Interrupting the AI mid-sentence stops it. If its own voice echoes into the mic and cuts it off, set `VOICE_BARGE_IN=0`.
- Asking for a human transfers the call (needs the handoff phone number on the Business Twin tab).
- Outbound calls and ending calls: KRAIP hangs up with Plivo's `DELETE Call` API and, if that is refused, transfers the call to a hang-up URL. Confirm calls really end after an opt-out or goodbye (`services/plivo.js`).
- `npm run voice-check` prints the first-audio delay; if the speaker you chose is unknown, KRAIP falls back to Sarvam's default voice (see the server log).
- Hindi, Tamil and Telugu fixed phrases (`lib/phrases.js`) need a native-speaker review.
- Check the call durations in Billing against Plivo's own call log.

## Security model (what the code enforces)
- Pages are served with a strict Content-Security-Policy (nothing loads from other sites; only the chat widget may be framed). Twilio calls also get a provider-side time limit (`MAX_CALL_SECONDS` + 30 s).
- Passwords: scrypt, 8-200 characters. Sessions: random tokens stored hashed, 30 days, expired ones purged hourly. Wrong-password attempts are limited per address and per account.
- Every `/api` request is scoped to the logged-in owner; another business's ids return 404. Text fields are type-checked and length-capped; protected fields (owner, status, version) cannot be set from a request body.
- Phone webhooks fail closed: with no secret configured every request is refused. Plivo URLs carry a key unique to each employee (a key from one business never works on another), Plivo's own V3 signature is also accepted (with replay protection), and **only a Plivo-signed callback may correct a call's billed duration**. Twilio uses its standard signature. Razorpay requires its signature (503 if the secret is missing).
- Billed call time is measured by this server from the audio stream; a carrier figure may correct it (once, signed) but never a number supplied by a browser.
- One call is billed once: the database enforces a single call-time record per conversation, so duplicate or concurrent hang-up callbacks cannot double-bill.
- Payments are recorded per payment id from the signed Razorpay payload (amount and currency checked), so repeated webhooks never count twice; partial payments keep the invoice open; usage after a paid invoice reopens it for just the new amount.
- `CREDIT_LIMIT_INR` caps unpaid usage. The check runs in the same database transaction that creates the call, and each call in progress reserves its worst-case cost, so a burst of simultaneous calls cannot overshoot.
- Campaign calls are claimed with one atomic statement that re-checks consent, opt-out, attempt limit, retry wait and "already on a call", so duplicate jobs or several workers cannot double-dial. The calling window is checked before each dial.
- Upgrading from the previous version: **the Plivo URLs changed** (per-employee keys). Copy the new Answer/Hangup URLs from the Employees tab into your Plivo Application.

## Billing and margin
Prices are in `.env`: normal call minutes (default 3.5/min), lead call minutes (5/min, for calls that ended with a hot or warm lead),
research reports, optional flat fee per qualified lead. Each call is rounded up to a full minute. The carrier's reported duration is used when available.
The Billing tab also shows an estimated margin: what you billed for calls minus the estimated Plivo + Sarvam + AI cost
(about Rs 2.4/min of talk time at default rates, i.e. roughly 30% margin at Rs 3.5 and 50% at Rs 5; set your real costs in `.env`).
Levers if you want more margin: raise the rates, lower `MAX_CALL_SECONDS`, hang up on voicemail (`PLIVO_MACHINE_DETECTION=hangup`), use a self-hosted model (`COST_LLM_PAISE_PER_TURN=0`).
During calls KRAIP answers first and analyses leads in the background; live web research runs in chat, not mid-call (to avoid silence).
Razorpay webhook: `{PUBLIC_URL}/webhooks/razorpay`, event `payment_link.paid`, same secret as `RAZORPAY_WEBHOOK_SECRET`.

## Wallet, pricing, retention
- `BILLING_MODE=prepaid` makes customers top up a wallet (Razorpay payment link); calls are refused when the balance cannot cover one more call. Payments and refunds are applied once per provider payment id, however often the webhook repeats.
- Admins (`ADMIN_EMAILS`) can set per-business rates and adjust wallets; every change is audit-logged.
- Low-balance and limit notifications are stored per business (one per kind per day) and optionally posted to `ALERT_WEBHOOK_URL`.
- Customers can erase a contact or conversation, export a contact's data, and delete a business (exact-name confirmation; refused while money is owed). Opt-outs are kept when a contact is erased. `RETENTION_DAYS` redacts old conversation text automatically.
- Not yet built: a wallet UI (API only), roles for transcript access, backups, provider monitoring. Nothing has been verified against live Plivo, Sarvam or Razorpay.

## Tests, health checks, CI
- `npm test` runs a syntax check of every file, then the test suites with mock providers (no real calls, no real payments, no secrets needed): `unit`, `migration` (older database upgrades), `security`, `api` (chat, leads, consent, campaigns on Twilio, billing), `voice` (Plivo + Sarvam calls), `voice-failures` (model/TTS/STT outages, refused hang-up, early hang-up, campaign retries and concurrency) and `billing` (spending limit, payment webhooks). It takes about a minute.
- `npm run check` is the syntax check alone. `npm run voice-check` tests your real Sarvam key.
- `GET /healthz` (process up) and `GET /readyz` (database answers) need no login and reveal no secrets: point your uptime monitor or load balancer at them.
- `.github/workflows/ci.yml` runs install, syntax check, tests and `npm audit` on every push.
- What the tests cannot prove: real Plivo/Sarvam/Razorpay behaviour. See the first-call checklist.

## Rules the code enforces
- Outbound calls only to contacts with recorded consent (yes + where it was given), never to opted-out numbers, only inside the call window, consent re-checked when the call is answered, with an AI disclosure and a "say stop" option. Opt-out is detected in conversation and saved.
- Discovered prospects store only contact details the business published itself, with source link and date. They are never auto-called.
- Research cites numbered sources with retrieval dates; confidence is capped when evidence is thin. The crawler respects robots.txt and refuses private network addresses.

## Your responsibility
Check local calling and marketing rules before outbound campaigns (in India: TRAI DND scrubbing and calling hours, and your provider's business verification).
Tell customers when calls or chats may be recorded and saved. Only train on data you are allowed to use.

## Scaling
SQLite + one server is fine for pilots. Before big volume: move to Postgres, put rate limits/queues in Redis,
run several workers behind a load balancer, and load-test before promising any number of calls.

## Layout
```
server.js            app entry (HTTP + live audio WebSocket)
db.js                schema
lib/                 auth, security (rate limit, safe fetch, robots), usage + audit, phone
llm/                 gemini.js, ollama.js, index.js (provider switch + queue)
services/            employee (chat engine), research, discovery, campaigns, billing,
                     phone (provider switch), plivo, sarvam, voiceStream (live calls), calls, telephony (Twilio)
routes/              api.js (logged-in), public.js (customer chat), plivo.js, voice.js (Twilio)
public/              index.html (dashboard), widget.html (customer chat)
```
