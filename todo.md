# ANIKAI Codebase — Upgrade TODO

> Scanned on: 2026-02-26
> Covers: `server.js`, `services/anime-data.js`, `onlinestream-providers/`, `tatakaiapi/`, `public/app.js`

---

## 🔴 High Priority

### 1. Fix silent bug — Missing `type` field in AniList GraphQL query
- **File:** `services/anime-data.js`
- `getAnimeDetails()` query doesn't fetch the `type` field (TV/MOVIE)
- But `server.js` calls `anime?.type` for subtitle search logic → always `undefined`
- **Fix:** Add `type` to the `Media(...)` GraphQL query fields

### 2. Add input validation (Zod) to tatakaiapi routes
- **File:** `tatakaiapi/src/routes/**`
- Route handlers manually cast params with `Number()` / `String()` — no schema validation
- **Fix:** Add `zod` + `@hono/zod-validator`, define schemas per route
- Gives automatic type inference + proper error messages

### 3. Replace plain `Map` cache with LRU in `server.js`
- **File:** `server.js`
- `allAnimeCache` is a raw `Map` with no max size or eviction policy
- Large catalog fetches can bloat memory indefinitely
- **Fix:** Use `lru-cache` (already used in tatakaiapi) with a max item count

---

## 🟠 Medium Priority

### 4. Add rate limiting to root `server.js`
- **File:** `server.js`
- Zero rate limiting on AniList proxy, subtitle, and episode-source endpoints
- tatakaiapi already uses `hono-rate-limiter`
- **Fix:** Add `express-rate-limit` to root `package.json` and apply to sensitive routes

### ~~5. Cache `getAnimeDetails()` results~~ ✅ Done
- **File:** `services/anime-data.js`
- `getAnimeDetails()` makes a fresh AniList/Jikan call every time
- Same anime ID gets fetched repeatedly (episode-list + episode-source both call it)
- **Fix:** Added `lru-cache` (max 500 entries, 5-min TTL), keyed by `${source}:${animeId}`. Only caches successful results — 404s are never stored.

### 6. Remove debug `console.log` left in production code
- **File:** `tatakaiapi/src/server.ts`
- Raw `console.log("[DEBUG] ...")` calls in the `/docs-content/:section` handler
- **Fix:** Replace with `log.debug()` from pino (already imported), stripped in prod

### 7. Extract massive inline docs HTML out of `server.ts`
- **File:** `tatakaiapi/src/server.ts`
- The `/docs/:section?` route contains 500+ lines of inline HTML/CSS/JS
- Makes `server.ts` unreadable and the HTML uneditable separately
- **Fix:** Move to `public/docs.html` (static) or `src/views/docs.ts` module

### 8. Add structured logging to root `server.js`
- **File:** `server.js`
- Only raw `console.log` — no log levels, no request tracing
- tatakaiapi uses `pino` for structured JSON logging
- **Fix:** Add `pino` + `pino-http` to root `package.json`

### 9. Fix `invalidatePattern` in TatakaCache for in-memory fallback
- **File:** `tatakaiapi/src/config/cache.ts`
- Non-wildcard patterns do nothing on the in-memory LRU cache (only Redis gets cleared)
- **Fix:** Add prefix/glob matching against `memoryCache` keys for non-`"*"` patterns

---

## 🟡 Low Priority

### 10. Migrate root server to TypeScript + ESM
- **File:** `server.js`, `services/anime-data.js`, `onlinestream-providers/*.js`
- Root is CommonJS (`require()`), tatakaiapi is modern TypeScript/ESM — inconsistent
- **Fix:** Rename to `.ts`, convert `require()` → `import`, add `tsconfig.json` to root
- Use `tsx watch` for dev (already available in tatakaiapi)

### 11. Add `.env` support + validated env config to root server
- **File:** `server.js`
- Raw `process.env.XYZ` with no validation, no defaults documented, no `.env.example`
- tatakaiapi uses `dotenv` + `envalid` for type-safe validated env vars
- **Fix:** Add `dotenv` + `envalid`, create `config/env.ts`, create `.env.example`

### 12. Add TypeScript types to provider files
- **File:** `onlinestream-providers/*.js`
- No JSDoc or TS interfaces — return shapes of `getEpisodeSources` / `getEpisodeList` are implicit
- **Fix:** Add shared interfaces (`VideoSource`, `Episode`, `Provider`) in a `types.ts`

### 13. Fix proxy stream backpressure in `server.js`
- **File:** `server.js` (`/api/onlinestream/proxy`)
- Manually reads stream with `getReader()` loop — bypasses Node.js backpressure
- **Fix:** Use `pipeline` from `stream/promises`:
  ```js
  import { pipeline } from 'stream/promises';
  await pipeline(Readable.fromWeb(upstream.body), res);
  ```

### 14. Split `public/app.js` into ES modules + add Vite
- **File:** `public/app.js`
- 1600+ line monolith — no bundler, no tree-shaking, no hot reload
- **Fix:** Split into `modules/player.js`, `modules/search.js`, `modules/catalog.js`, `modules/auth.js`
- Add **Vite** for bundling, minification, and dev HMR

### 15. Add hot reload for dev in root `package.json`
- **File:** `package.json`
- `"dev": "node server.js"` — doesn't watch for file changes
- **Fix:** Change to `"dev": "nodemon server.js"` or `tsx watch server.ts` after TS migration

### 16. Add unit test coverage with vitest
- **File:** `tatakaiapi/`
- `vitest` is installed but no test files exist (only ad-hoc `validate_api.ts` scripts)
- **Fix:** Add tests for:
  - Cache `getOrSet` logic
  - `rewriteM3u8ToProxy` utility
  - Route handlers using Hono's `app.request()` test helper

### 17. Add `/health` endpoint and self-ping to root `server.js`
- **File:** `server.js`, `render.yaml`
- tatakaiapi pings its own `/health` to prevent Render from sleeping
- Root server has no `/health` route and no self-ping
- **Fix:** Add `GET /health` returning `200 OK` and a `setInterval` self-ping on Render

---

## 📊 Summary Table

| # | Priority | File | Upgrade |
|---|----------|------|---------|
| 1 | 🔴 High | `services/anime-data.js` | Add `type` field to AniList query (silent bug) |
| 2 | 🔴 High | `tatakaiapi/src/routes/**` | Add Zod input validation |
| 3 | 🔴 High | `server.js` | Replace `Map` cache with LRU |
| 4 | 🟠 Medium | `server.js` | Add rate limiting (`express-rate-limit`) |
| 5 | 🟠 Medium | `services/anime-data.js` | Cache `getAnimeDetails()` with LRU |
| 6 | 🟠 Medium | `tatakaiapi/src/server.ts` | Remove debug `console.log` calls |
| 7 | 🟠 Medium | `tatakaiapi/src/server.ts` | Extract inline docs HTML to separate file |
| 8 | 🟠 Medium | `server.js` | Add `pino` structured logging |
| 9 | 🟠 Medium | `tatakaiapi/src/config/cache.ts` | Fix `invalidatePattern` for in-memory cache |
| 10 | 🟡 Low | `server.js` + providers | Migrate to TypeScript + ESM |
| 11 | 🟡 Low | `server.js` | Add `dotenv` + `envalid` + `.env.example` |
| 12 | 🟡 Low | `onlinestream-providers/*.js` | Add TypeScript interfaces for providers |
| 13 | 🟡 Low | `server.js` | Fix proxy stream backpressure |
| 14 | 🟡 Low | `public/app.js` | Split into modules + add Vite |
| 15 | 🟡 Low | `package.json` | Add `nodemon` / `tsx watch` for dev |
| 16 | 🟡 Low | `tatakaiapi/` | Add vitest unit tests |
| 17 | 🟡 Low | `server.js` | Add `/health` endpoint + Render self-ping |
