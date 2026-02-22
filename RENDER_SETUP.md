# Render Setup For Global Consumet Streaming

## 1. Deploy stream backend on Render (Web Service)

1. Push this repo to GitHub.
2. In Render, click `New +` -> `Web Service`.
3. Connect your GitHub repo and select this project.
4. Use these settings:
   - Runtime: `Node`
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Plan: `Free` (or higher)
5. After first deploy, copy the service URL, for example:
   - `https://anikai-stream.onrender.com`

## 2. Set required env vars on Render

Set these in Render service Environment:

- `ANILIST_CLIENT_ID` (optional if you use AniList OAuth)
- `ANILIST_CLIENT_SECRET` (optional if you use AniList OAuth)
- `ANILIST_REDIRECT_URI` (optional if you use AniList OAuth)
- `ANILIST_TOKEN` (optional shortcut if you already have one)
- `SEANIME_BASE_URL` / `SEANIME_BASE_URLS` (optional fallback bridges)
- `SEANIME_TIMEOUT_MS=12000`

## 3. Point Vercel frontend to Render stream backend

In Vercel project environment variables, set:

- `ONLINESTREAM_API_BASE_URL=https://<your-render-service>.onrender.com`

Then redeploy Vercel.

The watch page now reads `/api/client-config` and routes:

- `/api/onlinestream/*`
- `/api/subtitles/file`

through your Render backend when `ONLINESTREAM_API_BASE_URL` is set.

## 4. Verify

Open these URLs in browser:

- `https://<render-url>/api/onlinestream/providers`
- `https://<render-url>/api/onlinestream/debug` (POST)

Then test on Vercel watch page with provider:

- `Consumet HiAnime`
- `Consumet AnimeKai`
- `Consumet AnimePahe`

If Render free tier sleeps, first request can be slow for 30-60 seconds.
