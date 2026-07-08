# Jarvis — Personal AI Assistant

Telegram + Claude + Google Calendar/Gmail + Canvas LMS + Weather

---

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Fill in your .env
The `.env` file is already pre-filled with your API keys. The one thing you **must** add:

```
TELEGRAM_MY_CHAT_ID=YOUR_TELEGRAM_CHAT_ID
```

Get your Telegram user ID by messaging **@userinfobot** on Telegram. It will reply with your numeric ID.

### 3. Google OAuth setup
Download your `credentials.json` from Google Cloud Console and place it in the project root, then run:

```bash
npm run setup
```

This opens a browser, asks you to authorize Google Calendar + Gmail access, and saves the token. Only needed once.

### 4. Start Jarvis
```bash
npm run dev    # development (auto-restarts on file changes)
npm start      # production
```

Message your bot on Telegram — say anything. Jarvis responds.

---

## What Jarvis does

| Feature | Details |
|---------|---------|
| Natural conversation | Talk to it like a person. It fetches live data when relevant. |
| Morning brief | Sent at 7:00 AM Phoenix time — weather, calendar, assignments, email heads-up |
| Night brief | Sent at 10:00 PM Phoenix time — recap + tomorrow preview |
| Email intelligence | Checks Gmail every 15 min, alerts important emails, drafts replies |
| Draft approval | Reply *approve* / *edit: changes* / *discard* to manage email drafts |
| Smart reminders | 30-min calendar warnings, 24h + 1h assignment deadline alerts |
| Custom reminders | Say "remind me at 3pm to call the dentist" — it works |

---

## Google Cloud setup (if not done yet)

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a project → enable **Google Calendar API** and **Gmail API**
3. Configure OAuth consent screen (External, add your email as test user)
4. Create credentials → OAuth 2.0 Client ID → Desktop app
5. Download JSON → rename to `credentials.json` → put in project root
6. Run `npm run setup`

**Important — avoid the recurring "Google stopped working" outage:** while the
OAuth consent screen is in **Testing** status, Google expires both the access
token *and* the refresh token after **~7 days**, with no automatic recovery —
Jarvis will silently lose Calendar/Gmail access on a weekly cadence until you
manually re-run `npm run setup`. To fix permanently, go to **OAuth consent
screen** in Google Cloud Console and click **Publish App** to move it to
**Production** (for personal-use scopes like Calendar/Gmail this does not
require Google's verification review, just a warning screen on first login).
Once Production, refresh tokens don't expire until you revoke them. Jarvis
will also log a warning on startup and send a Telegram alert if it detects the
refresh token has expired or is about to.

---

## Deploying to GCP Free Tier (always-on, $0)

```bash
# On your GCP e2-micro VM (us-west1, us-central1, or us-east1 only for free tier)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pm2

# Clone your repo and install
git clone https://github.com/yourusername/jarvis.git
cd jarvis && npm install

# Copy your secrets from local machine
scp -i your-key.pem .env ubuntu@YOUR_IP:~/jarvis/
scp -i your-key.pem credentials.json ubuntu@YOUR_IP:~/jarvis/
scp -i your-key.pem data/google-token.json ubuntu@YOUR_IP:~/jarvis/data/

# Start with PM2 — use the npm script, not src/index.js directly,
# so the --experimental-sqlite flag (required by state.js) is applied.
# Starting via `pm2 start src/index.js` omits the flag and crash-loops on boot.
pm2 start npm --name jarvis -- start
pm2 save
pm2 startup   # run the command it prints
```

Useful PM2 commands:
```bash
pm2 logs jarvis      # live logs
pm2 status           # running status
pm2 restart jarvis   # restart after config changes
```

---

## Files at a glance

```
src/
├── index.js              Entry point
├── bot.js                Telegram bot, message routing
├── claude.js             Claude API wrapper + tool use loop
├── router.js             Maps tool names to integration calls
├── scheduler.js          Cron jobs (briefs, email poll, reminders)
├── state.js              SQLite database helpers
├── config.js             Env var loading + validation
├── logger.js             Winston logging
├── integrations/
│   ├── calendar.js       Google Calendar
│   ├── gmail.js          Gmail (read, draft, send)
│   ├── canvas.js         Canvas LMS
│   ├── weather.js        OpenWeatherMap
│   └── teams.js          Teams (disabled stub)
├── features/
│   ├── morning-brief.js  Assembles + generates morning brief
│   ├── night-brief.js    Assembles + generates night brief
│   ├── email-watcher.js  Email polling + importance scoring
│   ├── draft-flow.js     approve/edit/discard draft handling
│   └── reminders.js      Calendar + assignment + custom reminders
└── prompts/
    ├── system.js         Jarvis personality system prompt
    ├── brief.js          Morning/night brief prompt templates
    └── email.js          Email triage + draft prompt templates
```
