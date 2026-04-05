# Changelog

All notable changes to **ClipMark** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [3.4.13] - 2026-04-05

### Fixed
- **Deleted videos returning after page refresh** — Two-part race condition: (1) `handleDeleteVideo` was fire-and-forgetting the `DELETE /bookmarks/:id` request while immediately calling `setVideos()`, causing the debounced save effect (500ms) to fire a POST that raced the DELETE and re-added the video via the server's merge logic. Fixed by making `handleDeleteVideo` `async` and awaiting the server DELETE before updating React state. (2) The POST `/bookmarks` merge on the server was unconditionally re-adding any video present on the server but absent from the incoming payload ("server-only videos"), which defeated a successful DELETE whenever a subsequent sync arrived. Fixed by dropping server-only videos (treating the client payload as authoritative — the client holds the post-delete truth).

### Files Modified
- `app.html` — `handleDeleteVideo` made `async`; server DELETE is now awaited before `setVideos()` so the debounced save cannot race the deletion
- `transcript-server.js` — POST `/bookmarks` merge: server-only videos (not in incoming payload) are now dropped instead of unconditionally re-added

## [3.4.13] - 2026-04-05

### Fixed
- **"Get Context" no longer requires a second manual click for AI-generated transcripts** — On production (Hetzner), YouTube's timedtext and innertube APIs fail due to bot detection, so Gemini is always used as a background job. Previously this showed a "click again in 30-60 seconds" message. Now the button stays in loading state and automatically polls `/api/transcript/status` every 5 seconds until the transcript is ready, then applies it to the note field without any user action. Polling times out after 5 minutes.
- **Gemini "contents is not specified" 400 error** — `fetchUrl()` was not setting `Content-Length` header on POST requests, causing Node.js to use chunked transfer-encoding which the Gemini API cannot parse. Now sets `Content-Length: Buffer.byteLength(body)` for all requests with a body.
- **Gemini model fallback chain** — If `gemini-2.5-flash` returns 404 (deprecated) or fails, automatically tries `gemini-2.0-flash`. Billing/rate-limit errors (429) surface the actual Gemini error message instead of generic "HTTP 429".

### Files Modified
- `app.html` — Replaced manual "click again" UX in `handleLoadContext` with automatic polling loop (`pollUntilReady`); captures timestamp at click time so context is applied at the correct video position when polling completes
- `transcript-server.js` — Added `Content-Length` header in `fetchUrl()` for POST bodies; refactored `getTranscriptViaGemini()` to try multiple models with proper error classification (404 = try next model, 429 = surface billing error, other = continue)

## [3.4.8] - 2026-04-04

### Fixed
- **YouTube transcript "Get Context" regression** — `getTranscript()` in `transcript-server.js` was skipping the fast timedtext and innertube methods and going straight to the slow Gemini background job (30-60s) for every YouTube video, even those with standard captions. Restored the fast path: timedtext API is tried first (5s timeout, no retries), then innertube (8s timeout, no retries), with Gemini as the fallback only when both fail. When Hetzner IPs are blocked by YouTube, the fast methods now fail in under 5s and gracefully fall through to Gemini instead of hanging.

### Files Modified
- `transcript-server.js` — Restored timedtext + innertube as fast-path attempts before Gemini in `getTranscript()`; added short timeouts (5s/8s) and early-abort on 403/429/timeout to prevent long hangs on blocked IPs

## [3.4.7] - 2026-04-04

### Changed
- **App header restructured into 3 clean groups** — Logo | Utility actions | Add Video CTA. Export/Import moved into "..." dropdown. Library toggle, refresh, save status, shares bell, and settings consolidated into a single utility bar with visual dividers. Save status cleaned up (no emoji). User chip logout icon now red on hover.
- **VERA design audit — full UI polish pass** — all 12 VERA-flagged issues resolved:
  - Error messages consistently red (not emerald)
  - Syne font unified across wordmarks
  - Sidebar thumbnails fixed for non-YouTube videos
  - Confirm() dialogs replaced with inline Delete/Cancel UI
  - Sidebar section labels → `text-xs uppercase tracking-wider`
  - Note body text `text-gray-100`, card title `font-semibold`
  - All 8 modals: darker overlay (`bg-black/70`), added border + `shadow-2xl`
  - New note flashes `ring-2 ring-emerald-400` for 1.5s after save
  - Trial banner urgency escalation (green → amber → red by days remaining)
  - Expired modal monthly CTA → `bg-white text-slate-900`
  - Library and notes empty states improved (larger icon, bold title, subtext, CTA)
  - Chrome extension install instructions legibility fixed

### Files Modified
- `app.html` — Header restructure, all VERA fixes applied
- `index.html` — Chrome extension install text contrast fixed

## [3.4.6] - 2026-04-04

### Changed
- **Updated docs to reflect Hetzner migration** — CLAUDE.md and CHANGELOG.md updated to document current infrastructure
- Fixed `deploy.sh` to remove `su - clipmark` (webhook already runs as clipmark user; self-su was hanging indefinitely and accumulating stuck processes)
- Updated `webhook.js` deploy timeout from 60s → 120s

### Files Modified
- `CLAUDE.md` — Updated Deployment section, env vars table, Known Issues
- `deploy.sh` — Removed chown + su, runs pm2 restart directly
- `webhook.js` — Increased timeout to 120s

## [3.4.5] - 2026-04-04

### Fixed
- **Blank screen when clicking videos** — Added React ErrorBoundary to catch rendering crashes and show a recovery UI instead of a blank screen. Added guard to reset to library view if active video is not found in the videos array. Fixed unsafe references to `activeVideo` (which can be undefined) in share, delete, and import buttons — now uses `displayVideo` or `activeVideoId` instead.
- **Transcript generation stuck in infinite retry loop** — When the Gemini AI transcript job failed, the server would silently retry on every subsequent "Get Context" click, forever showing "being generated" without progress. Added a failed jobs tracker: after 2 failed attempts, shows a clear error message with the failure reason and a 10-minute cooldown before allowing retry. Also added better Gemini error logging (HTTP status, safety blocks, empty responses).

### Files Modified
- `app.html` — Added ErrorBoundary class component wrapping the App; added activeVideoId/videos guard useEffect; replaced `activeVideo` references with `displayVideo`/`activeVideoId` in video info panel buttons. Improved "No captions" error message to show failure details and suggest SRT/VTT upload.
- `transcript-server.js` — Added `failedGeminiJobs` tracker with MAX_GEMINI_RETRIES (2) and 10-minute cooldown; improved Gemini API error handling (throw instead of return null, check for safety blocks and empty candidates).

## [3.4.4] - 2026-04-04

### Fixed
- **Transcript "being generated" status swallowed** — When the server starts generating a transcript via Gemini AI, the client-side `fetchTranscript()` was catching and swallowing the "being generated" error, causing the unhelpful message "[No transcript available for this video]" instead of "[⏳ Transcript is being generated by AI. Click Get Context again in 30-60 seconds...]". Now properly propagates server errors ("being generated", "No captions", "rate limit") through the call chain so `handleLoadContext` can display the correct status messages.

### Files Modified
- `app.html` — Fixed error propagation in `fetchTranscript()`: `tryLocalServer()` now throws for "No captions" and "rate limit" server errors in addition to "being generated"; the non-200 response parser propagates all meaningful server errors; the outer catch re-throws actionable errors instead of returning null.

## [3.4.3] - 2026-04-02

### Fixed
- **Transcript fetch broken on production** — Gemini `gemini-2.0-flash` model rejects `video/youtube` fileData with "Requires valid user credentials". Upgraded all Gemini calls to `gemini-2.5-flash` which properly supports YouTube video processing. Also increased Gemini timeout to 120s for the thinking model.
- **Get Context button fallback** — Now falls back to `sourceId` when `videoId` is missing, and supports stored transcripts for non-YouTube videos.

### Files Modified
- `transcript-server.js` — Upgraded Gemini model from 2.0-flash to 2.5-flash (3 occurrences), increased timeout
- `app.html` — Improved handleLoadContext with sourceId fallback and debug logging

## [3.4.2] - 2026-04-02

### Fixed
- **Transcript fetch failing on production** — YouTube rate-limiting Railway's shared IP caused 429 errors. Added Gemini API as primary transcript method (bypasses YouTube scraping entirely). Also added:
  - `CONSENT=YES+1` cookie to all YouTube requests
  - Direct timedtext API method as fallback
  - User-agent rotation across 5 browser profiles
  - Retry with exponential backoff for 429 responses
  - Moved transcript cache to persistent Railway volume (was ephemeral, lost on every deploy)
  - Extended cache duration from 7 to 30 days

### Files Modified
- `transcript-server.js` — Gemini transcript extraction, consent cookie, cache persistence

## [3.4.1] - 2026-04-02

### Fixed
- **Data loss race condition on refresh** — Loading categories and bookmarks sequentially caused the save effect to sync an empty videos array to the server if the bookmarks fetch was slow. Now both are fetched in parallel with `Promise.all` and state is set together.
- Added `initialLoadCompleteRef` guard to prevent the save effect from syncing to the server before initial data load finishes.
- Applied same parallel-fetch fix to the in-app refresh button handler.

### Files Modified
- `app.html` — `loadUserData()`: parallel fetch + batched state updates; save effect: `initialLoadCompleteRef` guard; `handleRefresh()`: parallel fetch + batched state updates

## [3.3.0] - 2026-03-06

### Added
- **Admin Dashboard: Last Login column** — shows the date/time of each user's most recent session login
- **Admin Dashboard: Videos & Notes panel** — each user row has an expand button (chevron) that reveals all their bookmarked videos with thumbnails and full note list (including timestamps and favorite stars)
  - Backend `getAdminStats()` now includes `lastLogin` (derived from sessions) and a `videos` array with notes per user
  - Frontend adds `formatDateTime` and `formatTimestamp` helpers
  - Expand/collapse state tracked per user with `expandedUser` state

### Changed
- Suspended user status badge color corrected to red (was showing emerald/green)
- Delete button now uses red color scheme for clarity

### Files Modified
- `transcript-server.js` — `getAdminStats()` updated to return `lastLogin` and `videos`
- `app.html` — `AdminDashboard` component updated with new column, helpers, and expand panel
## [3.4.0] - 2026-03-14

### Added
- **Quick-Add API** (`POST /api/clips/quick-add`): External endpoint for adding videos to your library
  - Bearer token auth (same as existing session system)
  - Accepts `{ url, note?, timestamp?, tags? }` — auto-detects source type (YouTube, Vimeo, Loom, Wistia, Google Drive, X/Twitter, direct)
  - Auto-fetches metadata (title, thumbnail, description) via YouTube API / oEmbed
  - Duplicate detection (409 if URL already bookmarked)
  - Rate limited: 30 requests/hour per user
  - Response codes: 201, 400, 401, 409, 429
- **Chrome Extension** (`chrome-extension/`): "ClipMark - Save to Library" (Manifest V3)
  - Injects 📌 "Clip" button into YouTube's action bar (below video, next to Like/Share)
  - One-click save with optional note and automatic timestamp capture
  - Floating modal for adding notes with Ctrl/Cmd+Enter shortcut
  - Toast notifications for success/error feedback
  - Popup settings: login with username/password or manual token entry
  - Connection status indicator (green/red dot)
  - Handles YouTube SPA navigation (`yt-navigate-finish` event)
  - MutationObserver fallback for button re-injection
  - Emerald brand colors matching ClipMark design
- **URL parsing utility** (`parseVideoUrl`): Server-side function to parse video URLs into sourceType/sourceId
- **Metadata fetching utility** (`fetchVideoMetadata`): Server-side function supporting YouTube API, Vimeo/Wistia/Loom/Twitter oEmbed

### Files Modified
- `transcript-server.js`: Added quick-add endpoint, rate limiter, URL parser, metadata fetcher
- `chrome-extension/manifest.json`: Extension manifest (Manifest V3)
- `chrome-extension/popup.html` / `popup.js`: Settings/login popup
- `chrome-extension/content.js` / `content.css`: YouTube content script + styles
- `chrome-extension/generate-icons.js`: Icon generator script
- `chrome-extension/icons/`: Generated PNG icons (16x16, 48x48, 128x128)

## [3.3.0] - 2026-03-04

### Added
- **X (Twitter) Video Support**: Users can now bookmark and annotate tweets containing videos
  - URL pattern recognition for Twitter/X URLs (`twitter.com` and `x.com` domains)
  - Tweet metadata fetching via Twitter oEmbed API (author name, etc.)
  - iframe-based embed player with platform.twitter.com
  - X badge with Twitter X logo icon in library and video cards
  - Warning banner about limited playback controls (no seeking, no timestamp support)
  - Full integration with existing features: notes, categories, tags, sharing, markdown export
- **TwitterPlayerAdapter component**: iframe-based player adapter for X/Twitter embeds

### Files Modified
- `app.html`: Added Twitter URL pattern parsing, TwitterPlayerAdapter component, metadata fetching, player switching, and badge support

## [3.2.1] - 2026-02-22

### Changed
- **Custom domain**: Migrated from `videonote-snatch-production.up.railway.app` to `clipmark.top`
  - DNS managed via Cloudflare (CNAME flattening for root domain)
  - `www.clipmark.top` redirects to `clipmark.top` via Cloudflare redirect rule (301)
  - SSL handled by Cloudflare + Railway
  - Set `APP_URL=https://clipmark.top` environment variable in Railway for email share links

### No Code Changes
- All URLs in the codebase use relative paths or dynamic detection — no code modifications required

## [3.2.0] - 2026-02-22

### Changed
- **Marketing page redesign**: Complete overhaul of `index.html` with cinematic editorial aesthetic
  - New typography: Syne (display) + Outfit (body) replacing Inter
  - Film grain texture overlays and film strip dividers
  - Scroll-triggered reveal animations with staggered timing
  - New "Multi-Platform" section showcasing all 6 supported video platforms
  - Added feature cards for: Favorite Notes, Recently Watched, Video Sharing, Backup & Restore
  - Updated hero mockup showing multi-platform badges and favorite star icons
  - Updated "How It Works" steps for multi-platform workflow
  - Updated benefits section with team collaboration focus
  - Copyright updated to 2026

### Added
- **Favorite Notes**: Star button on each note to mark it as a favorite (yellow when active, gray when not). Favorites persist via existing `/bookmarks` sync.
- **Favorites First Toggle**: Toggle button in the notes panel to sort favorited notes to the top while preserving timestamp order within groups.
- **Recently Watched Section**: Expandable section on the library page showing the last 5 watched videos with thumbnails, titles, and note counts. Tracks `lastWatchedAt` timestamp when videos are opened.
- **Favorited Notes Section**: Expandable section on the library page listing all favorited notes across all videos. Clicking a note navigates to the video and seeks to the timestamp.
- **Star/StarFilled/ChevronDown icons**: New SVG icons added to the Icons object.

### Files Modified
- `app.html` — Added icons, state variables, handlers (`handleToggleFavorite`, `handleNavigateToNote`), updated `NoteItem` component, added library sections, updated `incrementViewCount` to track `lastWatchedAt`

## [3.1.2] - 2026-02-22

### Changed
- **Get Details for existing videos**: The "Get Publish Date" button is now "Get Details" and fetches description, publish date, and high-res thumbnail from the YouTube API in one call
- Button appears on both grid and list views for YouTube videos missing a description or publish date
- Descriptions persist to server and display in the collapsible description panel when viewing the video

### Files Modified
- `app.html` — Updated `handleFetchPublishDate` to store description and thumbnail; updated VideoCard and VideoListItem buttons

## [3.1.1] - 2026-02-21

### Added
- **Video Description Panel**: Collapsible description section below the note input area for YouTube videos. Shows first two lines with "Show more/less" toggle and chevron indicator. Only visible when the video has a description.

### Changed
- **Get Context button**: Background changed from gray to red (`bg-red-600`) for visual distinction
- **Add Note button**: Confirmed gray (`bg-gray-700`) when note input is empty, turns green (`bg-emerald-500`) when text is entered

### Files Modified
- `app.html` — Added `showFullDescription` state, description panel UI, updated Get Context button color

## [3.1.0] - 2026-02-20

### Added
- **Backup & Restore**: Full backup/export and import/restore workflow
  - `GET /api/backup/export` endpoint — downloads structured backup JSON with metadata (video count, note count, category count, username, export date)
  - `POST /api/backup/import` endpoint — imports backup with merge or replace strategy
  - `BackupImportModal` component with file preview, stats display, strategy selection (merge/replace), and success summary
  - Merge strategy deduplicates by `sourceType:sourceId`, remaps category IDs by name
  - Replace strategy overwrites all data with backup contents
  - Backward compatible with legacy export format (`{videos, categories, exportedAt}`)
  - Export uses new `clipmark_backup` v1 format with sentinel field for validation
  - Backup & Restore buttons added to Settings modal
  - Header export/import buttons renamed to "Export Backup" / "Import Backup"

### Changed
- `handleExport` now fetches from server when authenticated, falls back to client-side
- `handleImport` now opens a preview modal instead of silently overwriting data
- Export filename changed from `youtube-bookmarks-*.json` to `clipmark-backup-*.json`

### Files Modified
- `transcript-server.js` — Added `/api/backup/export` and `/api/backup/import` endpoints
- `app.html` — New `BackupImportModal` component, updated export/import handlers, new state variables, Settings modal updates

## [3.0.0] - 2026-02-14

### Added
- **Multi-Source Video Support**: Bookmark videos from multiple platforms beyond YouTube
  - **Vimeo**: Full player support with Vimeo Player SDK
  - **Loom**: Embed support (limited: no programmatic seeking)
  - **Wistia**: Full player support with Wistia JS API
  - **Google Drive**: Embed support (limited: no programmatic seeking)
  - **Direct URLs**: Native HTML5 video player for .mp4, .webm, .ogg, .m3u8 files
- **Video Source Detection**: `parseVideoUrl()` replaces `extractVideoId()` with multi-platform URL parsing
  - Returns `{ sourceType, sourceId, sourceUrl }` for all supported platforms
  - Auto-detects platform from URL patterns
- **Player Adapter Architecture**: Unified `VideoPlayer` wrapper with platform-specific adapters
  - `VimeoPlayerAdapter`: Full Vimeo SDK integration with async time updates
  - `HTML5PlayerAdapter`: Native `<video>` element for direct video URLs
  - `WistiaPlayerAdapter`: Wistia JS API integration with queue system
  - `LoomPlayerAdapter`: Iframe embed with limitations warning (no seekTo/getCurrentTime)
  - `GoogleDrivePlayerAdapter`: Iframe embed with limitations warning (no seekTo/getCurrentTime)
- **VideoSourceBadge Component**: Shows platform icon and name for non-YouTube videos
- **Transcript Upload**: Upload SRT/VTT subtitle files for non-YouTube videos
  - `TranscriptUploadModal` component with file picker and preview
  - `/api/transcript/upload` endpoint parses SRT/VTT to segments
  - `TranscriptStatusBadge` shows transcript source (platform/srt/vtt/ai)
  - `TranscriptHelpModal` with instructions for creating free SRT files (Google Docs, Whisper, online tools)
- **AI Transcription**: Generate transcripts via Gemini for videos without transcripts
  - `/api/transcript/generate` endpoint with rate limiting (5/hour)
  - Works with direct video URLs
- **Data Migration**: Automatic migration of existing YouTube videos to new data structure
  - `migrateVideoData()` adds `sourceType: 'youtube'` and renames `videoId` to `sourceId`
  - Backward compatible: `videoId` field preserved for existing code

### Changed
- **Video Data Structure**: Extended to support multiple sources
  - New fields: `sourceType`, `sourceId`, `sourceUrl`, `transcript`
  - `transcript.segments` stores parsed subtitle/transcription data
  - `transcript.source` indicates origin ('platform', 'srt', 'vtt', 'ai')
- **AddVideoModal**: Detects source type, shows platform badge, fetches oEmbed metadata for Vimeo/Wistia
- **VideoCard/VideoListItem**: Source-aware thumbnails with fallback for unavailable thumbnails
- **Markdown Export**: Now source-aware, exports correct video URLs for all platforms
- **Export Footer**: Updated from "YouTube Bookmarking App" to "ClipMark"

### Files Modified
- `app.html` - Added multi-source support, player adapters, transcript UI (~800 lines)
- `transcript-server.js` - Added SRT/VTT parsing, upload and generate endpoints (~200 lines)

### Known Limitations
- **Loom**: No player control API - timestamp notes use estimated times, no programmatic seeking
- **Google Drive**: No player control API - timestamp notes use estimated times, no programmatic seeking
- **AI Transcription**: Rate limited to 5 transcriptions per hour
- **Direct URLs**: Some servers may not support seeking without proper range request headers
- **Private Videos**: Vimeo/Wistia private videos require embed allowlisting

---

## [Docs] - 2026-02-08

### Fixed
- **CLAUDE.md accuracy overhaul**: Corrected multiple outdated/inaccurate sections
  - Clarified that `transcript-server.js` is the unified backend (not a separate transcript-only server)
  - Documented authentication flow (Bearer tokens, bcryptjs, rate limiting, session management)
  - Added auth endpoints table (`/auth/register`, `/auth/login`, `/auth/logout`, `/auth/check`)
  - Added other endpoints table (`/bookmarks`, `/categories`, `/api/youtube/video`, `/api/gemini`, etc.)
  - Fixed server URL: port 3456 with auto-detection, not `http://localhost:3000`
  - Documented `viewCount` tracking mechanism (client-side increment, synced to server)
  - Documented watch time tracking (separate from view count, syncs every 30s)
  - Added `ytBookmarks_authToken` to localStorage keys
  - Expanded `index.html` description (share token redirects, CTA links to `/app`)
  - Added note about no automated tests and `/test` transcript testing UI
  - Updated dev commands to reflect that `transcript-server.js` serves the full app
  - Updated Co-Authored-By to Claude Opus 4.6

### Files Modified
- `CLAUDE.md`
- `CHANGELOG.md`

---

## [2.0.0] - 2025-01-29

### Changed (Rebranding)
- **Renamed app** from "VideoNoteSnatch" to "ClipMark"
- **New tagline**: "Mark the moments that matter"
- **New color scheme**: Emerald (#10b981) primary with gold (#fbbf24) accents (previously red)
- **New logo**: 5 options created in `/logos/` directory (ClipMark selected)
- **Split architecture**: Landing page (`index.html`) separated from main app (`app.html`)

### Added
- **Email signup notifications**: Admin receives email when new users register
  - Uses Resend API (SMTP blocked on Railway)
  - Branded HTML email template
  - Environment variables: `RESEND_API_KEY`, `ADMIN_EMAIL`, `EMAIL_FROM`
- **Logo assets**: SVG logos and favicons for 5 brand options
- **Logo preview page**: `/logos/preview.html` for comparing logo options

### Fixed
- Server routing updated to serve `app.html` for `/app` and `/admin` routes

---

## [Unreleased]

### Fixed
- **YouTube Live URL support**: Added support for `youtube.com/live/VIDEO_ID` URLs (used for past live streams)
  - Updated `extractVideoId()` in `app.html` to recognize live video URL format
  - Updated test page in `transcript-server.js` with same fix

### Added
- **Library View Modes**: Toggle between grid and list views in the video library
  - Grid/list toggle buttons in library header
  - New `VideoListItem` component for compact list view
  - List view shows thumbnail, title, tags, publish date, view count, and notes count
  - State persisted in `libraryViewMode`
- **Video View Count**: Track how many times each video has been opened
  - View count displayed on video thumbnails (grid view: bottom-left, list view: inline)
  - Eye icon indicator for view count
  - `handleSelectVideo` function increments count and opens video
  - `viewCount` field added to Video data structure
- **User Profiles**: Edit profile with first name, last name, email, and interests
  - New ProfileModal accessible from SettingsModal
  - YouTube category interests plus custom interest support
  - GET/PUT `/api/profile` endpoints
- **Video Sharing (User-to-User)**: Share videos with other ClipMark users
  - ShareModal with user search and autocomplete
  - Option to include notes as snapshot copies
  - Accept/decline workflow for recipients
  - PendingSharesDropdown notification in header
  - "Shared with me" tab in sidebar for accepted shares
- **Shared Video Playback**: Click shared videos to view in player with notes
  - Opens in embedded player instead of linking to YouTube
  - Shows "Shared by [username]" badge on shared videos
  - Recipients can add, edit, and delete notes on shared videos
- **Note Author Attribution**: Notes show first 3 letters of author's username
  - Author badge displayed on each note
  - Hover shows full username
- **Shared Notes Persistence**: PUT `/api/shares/library` endpoint saves shared video notes
- **Video Sharing (Email)**: Share videos via email invitation to non-users
  - Branded email invitation sent via Resend API
  - Share landing page with video preview
  - Auto-claim share after signup/login with token
  - 30-day token expiration
- **Share Rate Limiting**: Maximum 10 shares per hour per user
- **Sharing API Endpoints**:
  - `/api/users/search` - Search users by username
  - `/api/shares` - Create, list, accept, decline, revoke shares
  - `/api/shares/preview` - Public share preview for email links
  - `/api/shares/claim` - Claim email share after authentication
- **Data Storage**:
  - `data/shares.json` - Central share records
  - `data/users/{userId}/shared-with-me.json` - Per-user accepted shares

### Changed
- VideoCard now includes share button on hover
- SettingsModal now has "Edit Profile" link
- AuthModal supports embedded mode for share landing pages

### Fixed
- **Shared Video Toolbar**: "Get Context", "Enhance Notes", and "Download .md" now work for shared videos
  - `handleLoadContext` updated to use `displayVideo` instead of `activeVideo`
  - `handleEnhanceAllNotes` and `handleApplyEnhancements` updated to support shared videos
  - Enhancement toolbar now visible for shared videos
- **Shared Video Transcript**: Fixed transcript fetching for shared videos
  - Shared videos use `youtubeVideoId` property, not `videoId`
  - Updated `handleLoadContext` and `handleEnhanceAllNotes` to use correct property
- **Email Share Links**: Fixed share links pointing to wrong page
  - Links now go to `/app?share_token=xxx` instead of `/?share_token=xxx`
  - Landing page (`index.html`) redirects to `/app` if share_token is present
- **Registration Fields**: Added optional email, first name, last name to registration form
  - Fields saved to user profile on signup
  - Supports collecting user info when signing up via share link

### Known Issues
- **Session Persistence on Railway**: Sessions may be lost on redeploy (ephemeral filesystem)
  - Workaround: Log out and log back in after deployment
  - Future fix: Use Railway persistent volume or external session store

### Files Modified
- `transcript-server.js` - Added profile and sharing endpoints (~600 lines)
- `app.html` - Added ProfileModal, ShareModal, PendingSharesDropdown, VideoListItem components; library view toggle; view count tracking (~500 lines)
- `CLAUDE.md` - Updated documentation with new features and components

---

- **AI Note Enhancement**: Batch-process all notes for a video using Gemini AI to summarize and expand notes with transcript context
  - "Enhance Notes" button in toolbar below video player
  - Progress indicator during enhancement processing
  - Review modal for ambiguous notes with radio button selection for alternatives
  - Custom text input option when AI suggestions don't match user intent
- **Markdown Export**: Download notes as formatted Markdown (.md) file
  - Includes video title, publish date, and YouTube link
  - Notes organized by timestamp with bullet point formatting
  - Export watermark with app attribution
- **Extended Context Function**: New `getExtendedTranscriptContext()` for capturing complete thoughts (75 words before/after timestamp)
- **Enhancement Review Modal**: UI for reviewing and selecting AI-suggested note alternatives

### Changed
- Notes now render bullet point formatting (markdown-style `- ` prefixes) properly
- New toolbar section below video player for note enhancement actions

## [1.0.0] - 2026-01-22

### Added
- Initial release
- Bookmark YouTube videos with metadata
- Add timestamped notes during video playback
- Organize videos into custom categories
- Tag videos with keywords
- Optional AI summaries via Gemini API
- YouTube API integration for metadata
- Data persistence via localStorage and optional server backend
- Transcript context loading for notes
- Import/Export notes functionality
