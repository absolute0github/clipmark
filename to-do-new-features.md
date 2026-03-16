# ClipMark — Feature Roadmap

## ✅ Completed (as of March 2026)

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

## 🚧 In Progress

- **PWA Support** — Make ClipMark installable on mobile devices
- **Chrome Extension CSS** — YouTube aggressively overrides button styling (PR #6 pending)

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

### Technical
- [ ] Session persistence fix (Railway ephemeral filesystem → Redis or PostgreSQL)
- [ ] Email domain verification for Resend (production sends)
- [ ] X (Twitter) video import improvements
- [ ] Batch note operations (select multiple, delete, export)

## 🐛 Known Issues

1. **Session persistence on Railway** — Sessions lost on redeploy. Need persistent volume or external session store.
2. **Email sharing requires domain verification** — Resend sandbox limits sends to own email only.
3. **Chrome extension CSS battles** — YouTube overrides styles aggressively, needs `!important` everywhere.
