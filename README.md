# Outreach Agent

Paste recruiter info in any format → Claude extracts the contacts and drafts a personalized email with a specific subject line for each → you review/edit → it sends from your Gmail with your resume attached.

## Setup
1. `cp .env.example .env` and fill in:
   - `ANTHROPIC_API_KEY`
   - `GMAIL_APP_PASSWORD` (https://myaccount.google.com/apppasswords, needs 2-step verification on)
2. `npm start` → open http://localhost:3000
3. Fill in your profile, upload your resume, paste recruiter text, hit the button.

## Safeguards
- Nothing sends until you click Send and confirm; every draft is editable.
- Never emails the same address twice (sent-log in `data/`).
- Daily cap (`DAILY_SEND_LIMIT`, default 40) and 20s+ random delay between sends to keep Gmail from flagging you. Keep the tab open while sending.
- Server binds to localhost only.
