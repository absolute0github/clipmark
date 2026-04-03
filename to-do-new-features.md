# ClipMark — Feature Roadmap

## ✅ Completed (as of April 2026)

1. ~~Make the default sidebar view sort from newest to oldest~~ ✅ Default is `date-desc`
2. ~~When adding new notes, add them to the top of the note list~~ ✅ Notes sort `b.timestamp - a.timestamp`
3. ~~In the notes section header, add an "Export Notes" feature~~ ✅ Export TXT + Export Markdown buttons in notes header
4. ~~In the settings, add the ability to change the default number of words pre and post context~~ ✅ Settings modal has context word count slider
5. ~~Make the Get Context button the same size as Add note button~~ ✅ Both use `flex-1` in same container
6. ~~Remove AI Find tips button and functionality~~ ✅ No button in UI (function exists but unused)
7. ~~Share video and notes with other users~~ ✅ Implemented
8. ~~Email notification on signup~~ ✅ Via Resend API
9. ~~Email sharing with invite links for non-users~~ ✅ Implemented (2026-01-30)
10. ~~Chrome Extension for quick-add from YouTube~~ ✅ v1.0.1 (2026-03-14)
11. ~~Migrate from Railway to Hetzner VPS~~ ✅ Dedicated IP, PM2, nginx, Let's Encrypt SSL (2026-04-02)
12. ~~Fix transcript fetching on production~~ ✅ Gemini 2.5 Flash as primary method with background processing (2026-04-02)
13. ~~Collapsible sidebar with keyboard shortcut~~ ✅ Toggle with [ key, content expands (2026-04-02)
14. ~~Keyboard shortcuts for video seeking~~ ✅ Arrow keys ±5s, Shift+Arrow ±10s (2026-04-02)
15. ~~Rewind/fast-forward buttons in toolbar~~ ✅ 5s and 10s seek buttons (2026-04-02)
16. ~~Persistent playback speed control~~ ✅ 0.25x–3x, saved to localStorage (2026-04-02)
17. ~~API usage tracking per user~~ ✅ Tracks calls, tokens, costs in admin dashboard (2026-04-02)
18. ~~Admin dashboard redesign~~ ✅ Mission-control two-panel layout with user drill-down (2026-04-02)
19. ~~Server-side merge strategy for bookmarks~~ ✅ Never loses videos or notes on sync (2026-04-02)
20. ~~Daily automated backups~~ ✅ Cron at 3am UTC, 30-day retention (2026-04-03)
21. ~~Usage graphs in admin~~ ✅ 30-day bar chart with spike detection (2026-04-03)
22. ~~Move description to notes panel~~ ✅ Collapsed by default, scrollable (2026-04-02)
23. ~~Persistent collapse state for Recently Watched / Favorited Notes~~ ✅ (2026-04-02)

## 🚧 In Progress

- **Admin historical data** — Monthly/yearly usage history per user
- **Chrome Extension CSS** — YouTube aggressively overrides button styling

## 📋 Upcoming Features

### Mobile Experience
- [ ] PWA manifest + service worker for offline-capable mobile app
- [ ] Responsive UI improvements for small screens
- [ ] Touch-friendly note editing

### Onboarding & UX
- [ ] First-time user walkthrough/tutorial
- [ ] Sample video pre-loaded for new accounts
- [ ] Better empty state messaging

### Monetization (Priority)
- [ ] Stripe integration for premium tiers
- [ ] Free tier: 5 videos, 3 shares max
- [ ] Premium tier: unlimited videos, unlimited shares, AI summaries
- [ ] Pro tier: team workspaces, API access
- [ ] Grandfathering plan for existing users
- [ ] Usage-based billing tied to API token consumption

### Admin & Analytics
- [ ] Monthly/yearly historical data views with date range picker
- [ ] Per-user activity timeline (when they add videos, take notes, use AI)
- [ ] Export admin data as CSV
- [ ] Real-time usage alerts (cost threshold warnings)
- [ ] User retention metrics (daily/weekly/monthly active users)

### Technical
- [ ] GitHub webhook auto-deploy (webhook server running, needs GitHub setup)
- [ ] Email domain verification for Resend (production sends)
- [ ] X (Twitter) video import improvements
- [ ] Batch note operations (select multiple, delete, export)
- [ ] Database migration (JSON files → SQLite or PostgreSQL for scale)

## 🏗️ Infrastructure

**Current Setup (April 2026):**
- **Server**: Hetzner CX23 (Helsinki), 2 vCPU, 4GB RAM, $4.99/mo
- **DNS/CDN**: Cloudflare (free plan), SSL Full (strict)
- **SSL**: Let's Encrypt via Certbot (auto-renewing)
- **Process Manager**: PM2 with systemd startup
- **Backups**: Daily at 3am UTC, 30-day retention, /opt/clipmark/backups/
- **Data**: JSON files in /opt/clipmark/data/
- **Transcripts**: Gemini 2.5 Flash API (background processing for long videos)
- **Deploy**: `git push` → SSH pull + PM2 restart (webhook server ready for auto-deploy)

## 🐛 Known Issues

1. ~~**Session persistence on Railway**~~ ✅ RESOLVED — Migrated to Hetzner with persistent disk
2. **Email sharing requires domain verification** — Resend sandbox limits sends to own email only.
3. **Chrome extension CSS battles** — YouTube overrides styles aggressively, needs `!important` everywhere.
4. **Long video transcripts** — Gemini 2.5 Flash can take 2-5 minutes for 40+ minute videos. First request shows "generating" message, cached on retry.
5. **YouTube bot detection from datacenter IPs** — yt-dlp and innertube scraping fail from Hetzner. Gemini API bypasses this entirely.
