# Cogniva (v0.1.0)
Node >= 22.13, zero dependencies (no npm install).

    ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='strong-pass-123' AI_API_KEY=sk-... node server.mjs

Pages: `/` login (pull-cord lamp) · `/register.html` · `/forgot.html` · `/reset.html?token=…` · `/app` (the learning app).

Env: AI_API_KEY, AI_BASE_URL, AI_MODEL, PORT, DB_PATH, NODE_ENV=production (Secure cookies, needs HTTPS),
SITE_URL (public address used in reset links, e.g. https://cogniva.example.com),
MAIL_WEBHOOK_URL (receives POST {to,subject,text}; without it, emails are printed to the server console = development only).

## Sign in with Google / GitHub (optional)
Buttons are always shown; they work once you add keys to `.env` (restart the server after editing):

    SITE_URL=http://localhost:3000
    GOOGLE_CLIENT_ID=...   GOOGLE_CLIENT_SECRET=...
    GITHUB_CLIENT_ID=...   GITHUB_CLIENT_SECRET=...

Redirect (callback) URLs to register with each provider — they must match SITE_URL exactly:
- Google: `SITE_URL/auth/google/callback`  (Google Cloud Console > APIs & Services > Credentials > OAuth client ID > Web application; configure the consent screen first)
- GitHub: `SITE_URL/auth/github/callback`  (GitHub > Settings > Developer settings > OAuth Apps > New OAuth App)

Rules: only verified provider emails are accepted; new social accounts start as student (or teacher if chosen on the register page);
the first social login into an existing password account switches it to social sign-in (old password and sessions are retired — use "Forgot password" to set one again).


## File uploads (Documents page)
Upload almost any file; Cogniva turns it into text, stores it as a document, and the chat / exams / flashcards use it like any pasted text.

| Type | How it is read |
|---|---|
| Text, code, CSV, JSON, Markdown, subtitles… (UTF-8/16, Arabic cp1256) | decoded directly |
| Word `.docx`, PowerPoint `.pptx` (with notes), Excel `.xlsx`, OpenDocument, EPUB, RTF, HTML | built-in readers, no dependencies |
| PDF | `pdftotext` if installed, else a built-in reader. Scanned PDFs and Arabic PDFs go to the AI (needs `AI_API_KEY`) |
| Images (png, jpg, webp, gif; bmp/tiff/heic need ffmpeg) | AI vision: text + description of diagrams/charts |
| Audio and video | speech-to-text (see below). Video: only the spoken audio is transcribed, not the picture |
| Old `.doc` `.xls` `.ppt` | converted with LibreOffice (`soffice`) if installed, otherwise a clear error |

Images, speech and scanned/Arabic PDFs cost **one AI request** from the user's weekly quota (shown as "File uploads" in admin analytics). Everything else is free.

Optional `.env` settings:

    MAX_UPLOAD_MB=50          # upload size limit
    MAX_MEDIA_MIN=120         # longest audio/video accepted when ffmpeg is installed
    VISION_MODEL=...          # model for images / scanned PDFs (defaults to AI_MODEL; must support images)
    STT_BASE_URL=...  STT_API_KEY=...  STT_MODEL=...   # speech-to-text; default = AI_BASE_URL / AI_API_KEY
    STT_MODE=whisper|chat     # whisper = /audio/transcriptions (OpenAI, Groq: STT_MODEL=whisper-1 / whisper-large-v3-turbo)
                              # chat = audio inside a chat message (Gemini: chosen automatically for generativelanguage.googleapis.com)

Optional programs on the server (none are required): **ffmpeg** (any audio/video format, recordings of any length are split into 10-minute pieces, odd image formats),
**pdftotext** (poppler, best PDF text), **soffice** (LibreOffice, old Office files).
Without ffmpeg the web page converts video / unusual audio to a small WAV *in the browser* before uploading (up to ~150 MB and ~24 minutes); MP3/WAV (and with Whisper also M4A/OGG/FLAC/MP4/WebM up to 24 MB) go straight through.

Very long documents: the chat sends the parts of the document that match your question (up to ~12,000 characters); exams and flashcards use an even spread of the whole document.

## Deploy on Fly.io (persistent SQLite)
    fly launch --no-deploy            # keep the Dockerfile, edit app name in fly.toml
    fly volumes create data --size 1  # holds cogniva.db
    fly secrets set ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='...' AI_API_KEY=sk-... MAIL_WEBHOOK_URL=...
    fly deploy
`TRUST_PROXY=1` (set in the Dockerfile) makes rate limiting use the real client IP behind the proxy. Do not set it when the server is exposed directly.

## Several files at once
- Documents page: choose any number of files in one go (Ctrl/Shift-click); each is read separately and one bad file does not stop the others.
- Chat, Exams and Flashcards: tick any number of documents (up to 10). The ~12,000-character prompt budget is shared between them, and each document is labelled in the prompt. API: `docIds: [1,2,3]` (the old single `docId` still works).

## Payments and Premium (InstaPay)
1. Admin > Settings: set **InstaPay handle**, **Premium price**, **Currency** and **Premium duration (days)**. Until a handle is set, students cannot send requests.
2. Student > Subscription: pays through InstaPay, types the transaction reference, sends the request (one pending request at a time, up to 5 per day). A reference can be used once (case-insensitive); a rejected or cancelled one can be reused. The student can cancel a pending request.
3. Admin > Payments: **Approve** (Premium for the days that were offered when the student paid; renewing adds days on top of the current expiry) or **Reject** with an optional reason the student sees. Both send an email; set `ADMIN_EMAIL` to also get an email for every new request, and `MAIL_WEBHOOK_URL` for real delivery.
4. Premium ends by itself on the expiry date (the weekly limit returns to the free limit). Changing the price later does not change past payments; revenue is the sum of the amounts actually charged.

## Deploy on Vercel + Supabase (free tiers)

The same code runs three ways: `node server.mjs` (SQLite file), Docker/Fly.io, or Vercel with Supabase Postgres.
Setting `DATABASE_URL` switches the database to Postgres; tables are created automatically on the first request.

1. **Supabase**: create a project, then *Connect* → choose **Transaction pooler** (Session/Transaction, port 6543) and copy the URI. Replace `[YOUR-PASSWORD]`. Avoid Direct connection for Vercel because it may require IPv6.
2. **GitHub**: push this folder to a repository (`.env` is git-ignored; never upload it).
3. **Vercel**: *Add New Project* → import the repo → framework "Other", no build command. Keep the project Root Directory at the repository root (the folder containing `vercel.json`). Add the variables from `.env.example`
   (`DATABASE_URL`, `NODE_ENV=production`, `TRUST_PROXY=1`, `SITE_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `AI_*`). Deploy.
4. Set `SITE_URL` to the final address, and use `SITE_URL/auth/google/callback` and `SITE_URL/auth/github/callback` as the OAuth callback URLs.
5. Open the site, sign in with `ADMIN_EMAIL`/`ADMIN_PASSWORD`, set the InstaPay handle and price in Administration.

Limits on Vercel: uploads are capped at about 4 MB (platform request limit); ffmpeg/pdftotext are not installed, so audio/video and
scanned-PDF handling is reduced to what the built-in reader and the AI provider can do; the disk is not persistent (everything lives in Postgres).
Supabase free projects pause after about a week without activity (open the dashboard to resume). Check both providers' current terms
and free-tier limits, including whether your use is allowed on Vercel's free (Hobby) plan.
