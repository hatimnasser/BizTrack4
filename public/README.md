# BizTrack Pro v3.2 — Fixed & Enhanced

Mobile ERP for small businesses. Built for low-end Android phones (Uganda market).

## What's in this release

### ✅ Fixes Applied (v3.1 → v3.2)

| Fix | Details |
|-----|---------|
| **CSS `gap` → `margin` fallback** | JavaScript polyfill detects flex-gap support at startup. If running on Android WebView < Chrome 84 (Android 7–9 devices), injects `margin`-based spacing for all 43+ flex containers. Grid containers use `grid-gap` fallback too. |
| **PIN Lock + Staff Accounts** | 4-digit PIN overlay on app open. Owner can set/change PIN in Settings. Add cashiers/managers/stockkeepers with their own PINs. Recovery code support for forgotten PINs. |
| **Backup Reminder** | Home screen banner appears when last backup was 7+ days ago (or never). Shows exact days since last backup. Dismisses automatically after backing up. |
| **Supabase Cloud Sync** | Settings → Cloud Sync. Enter Supabase project URL + anon key. Pushes the existing `sync_queue` to Supabase on demand or auto-syncs on load. Test Connection button included. |
| **PWA Manifest + Service Worker** | `manifest.json` enables "Add to Home Screen" on Android Chrome. `sw.js` caches app shell for offline use. Cache-first for assets, network-first for navigation. Background sync support. |
| **Cloudflare Pages Deployment** | `_headers` (security headers + cache policies), `_redirects` (SPA fallback), `.github/workflows/deploy.yml` (auto-deploy on push to main). |

---

## Why NOT React Native?

For this specific target market (low-end Android in Uganda), React Native would be **worse**:

- **More RAM**: Hermes JS engine + RN bridge = 50–100 MB baseline overhead. Old devices struggle.
- **Larger APK**: Minimum ~20 MB vs ~4 MB for Capacitor.
- **No meaningful benefit**: The pain points (WebView rendering, gap CSS) are fixed at the HTML/CSS level.
- **Capacitor IS the right architecture**: It's the standard approach for shipping web apps on Android.

The Capacitor/WebView approach is what Ionic (used by millions of apps) recommends for exactly this use case.

---

## Setup & Deployment

### 1. Local Development

```bash
npm install
npm run dev          # Vite dev server
```

### 2. Deploy to Cloudflare Pages (PWA — web access)

**One-time setup:**
1. Create a project at [pages.cloudflare.com](https://pages.cloudflare.com)
2. Add GitHub repo secrets:
   - `CLOUDFLARE_API_TOKEN` — from cloudflare.com/profile/api-tokens (use "Edit Cloudflare Workers" template)
   - `CLOUDFLARE_ACCOUNT_ID` — from cloudflare.com dashboard URL
3. Update `projectName` in `.github/workflows/deploy.yml`

**Deploy:** Push to `main` → GitHub Actions auto-deploys to Cloudflare Pages.

### 3. Build Android APK (Capacitor)

```bash
npm run build          # Build web assets
npx cap sync android   # Sync to Android project
npx cap open android   # Open in Android Studio
# In Android Studio: Build → Generate Signed APK
```

**For APK in GitHub:** See the commented-out `build-apk` job in `.github/workflows/deploy.yml`.
We recommend [Codemagic](https://codemagic.io) (free for open-source) for CI APK builds — it has Android SDK pre-installed.

### 4. App Icons

Add icons to the `icons/` folder. See `icons/README.md` for required sizes.

---

## Supabase Setup (Cloud Sync)

1. Create a free project at [supabase.com](https://supabase.com)
2. In Supabase SQL editor, run:

```sql
-- Create sync_queue table (mirrors local schema)
create table if not exists sync_queue (
  id text primary key,
  "tableName" text not null,
  "recordId" text not null,
  operation text not null,
  data text,
  synced integer default 0,
  "createdAt" text
);

-- Create tables for each data type
create table if not exists inventory (id text primary key, data jsonb);
create table if not exists sales (id text primary key, data jsonb);
create table if not exists expenses (id text primary key, data jsonb);
create table if not exists payables (id text primary key, data jsonb);
create table if not exists customers (id text primary key, data jsonb);
create table if not exists suppliers (id text primary key, data jsonb);

-- Enable Row Level Security
alter table sync_queue enable row level security;
create policy "Allow anon access" on sync_queue for all using (true);
```

3. Copy your **Project URL** and **anon public key** from Settings → API
4. Enter them in BizTrack Pro → Settings → Cloud Sync

---

## Architecture Notes

```
biztrack-pro/
├── index.html              ← Entire app (HTML + CSS + JS, single file)
├── manifest.json           ← PWA manifest
├── sw.js                   ← Service Worker (offline + caching)
├── _headers                ← Cloudflare Pages security/cache headers
├── _redirects              ← Cloudflare Pages SPA routing
├── icons/                  ← PWA/Android icons (add your own)
├── src/
│   └── utils/
│       ├── database.js     ← SQLite via Capacitor (sync_queue, users tables)
│       ├── pdfReceipt.js   ← Receipt/P&L PDF generation
│       ├── excelExport.js  ← Excel export
│       ├── plEngine.js     ← P&L calculation engine
│       └── fileManager.js  ← File save/share via Capacitor
├── android/                ← Capacitor Android project
├── capacitor.config.ts     ← Capacitor config
├── vite.config.js          ← Build config
└── .github/
    └── workflows/
        └── deploy.yml      ← Auto-deploy to Cloudflare Pages
```

## Currency Support

UGX · KES · TZS · RWF · NGN · GHS · USD · EUR
