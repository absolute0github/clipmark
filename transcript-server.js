// YouTube Transcript Server
// Run with: node transcript-server.js
// First time: npm install

// Load environment variables from .env file
require('dotenv').config();

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

// Stripe configuration
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY;
const STRIPE_TRIAL_DAYS = parseInt(process.env.STRIPE_TRIAL_DAYS || '5');
let stripe = null;
let STRIPE_PRICES = { monthly: null, annual: null };

if (STRIPE_SECRET_KEY) {
    stripe = require('stripe')(STRIPE_SECRET_KEY);
    console.log('💳 Stripe payments enabled');

    // Initialize Stripe products and prices on startup
    (async () => {
        try {
            // Find or create the ClipMark Pro product
            const products = await stripe.products.list({ limit: 10 });
            let product = products.data.find(p => p.metadata?.app === 'clipmark');

            if (!product) {
                product = await stripe.products.create({
                    name: 'ClipMark Pro',
                    description: 'Unlimited videos, AI summaries, transcript context, sharing, and more.',
                    metadata: { app: 'clipmark' }
                });
                console.log('💳 Created Stripe product:', product.id);
            }

            // Find or create monthly price ($9/mo)
            const prices = await stripe.prices.list({ product: product.id, active: true, limit: 10 });
            let monthlyPrice = prices.data.find(p => p.recurring?.interval === 'month' && p.unit_amount === 900);
            let annualPrice = prices.data.find(p => p.recurring?.interval === 'year' && p.unit_amount === 9700);

            if (!monthlyPrice) {
                monthlyPrice = await stripe.prices.create({
                    product: product.id,
                    unit_amount: 900,
                    currency: 'usd',
                    recurring: { interval: 'month' },
                    metadata: { plan: 'monthly' }
                });
                console.log('💳 Created monthly price:', monthlyPrice.id);
            }

            if (!annualPrice) {
                annualPrice = await stripe.prices.create({
                    product: product.id,
                    unit_amount: 9700,
                    currency: 'usd',
                    recurring: { interval: 'year' },
                    metadata: { plan: 'annual' }
                });
                console.log('💳 Created annual price:', annualPrice.id);
            }

            STRIPE_PRICES = { monthly: monthlyPrice.id, annual: annualPrice.id };
            console.log('💳 Stripe prices ready — monthly:', monthlyPrice.id, 'annual:', annualPrice.id);
        } catch (e) {
            console.error('💳 Stripe initialization error:', e.message);
        }
    })();
} else {
    console.log('💳 Stripe payments disabled (STRIPE_SECRET_KEY not set)');
}

// API Keys from environment (check that they're not placeholder values)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY && !process.env.GEMINI_API_KEY.includes('your_')
    ? process.env.GEMINI_API_KEY
    : null;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY && !process.env.YOUTUBE_API_KEY.includes('your_')
    ? process.env.YOUTUBE_API_KEY
    : null;

// Use environment port (Railway) or default to 3456
const PORT = process.env.PORT || 3456;

// Email notification configuration
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'jason@absolute0.net';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || 'ClipMark <onboarding@resend.dev>';

// Check if email is configured
if (RESEND_API_KEY) {
    console.log('📧 Email notifications enabled (Resend)');
} else {
    console.log('📧 Email notifications disabled (RESEND_API_KEY not set)');
}

// Send signup notification email via Resend API
async function sendSignupNotification(username, userId) {
    if (!RESEND_API_KEY) {
        console.log('📧 Skipping email notification (Resend not configured)');
        return;
    }

    try {
        const timestamp = new Date().toLocaleString('en-US', {
            timeZone: 'America/New_York',
            dateStyle: 'full',
            timeStyle: 'long'
        });

        const emailHtml = `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                <div style="background: linear-gradient(135deg, #10b981 0%, #34d399 100%); padding: 30px; border-radius: 12px 12px 0 0;">
                    <h1 style="color: white; margin: 0; font-size: 24px;">New User Signup</h1>
                </div>
                <div style="background: #f8fafc; padding: 30px; border-radius: 0 0 12px 12px; border: 1px solid #e2e8f0; border-top: none;">
                    <p style="color: #334155; font-size: 16px; margin: 0 0 20px 0;">
                        A new user has registered for ClipMark:
                    </p>
                    <div style="background: white; padding: 20px; border-radius: 8px; border: 1px solid #e2e8f0;">
                        <p style="margin: 0 0 10px 0;"><strong style="color: #10b981;">Username:</strong> <span style="color: #1e293b;">${username}</span></p>
                        <p style="margin: 0 0 10px 0;"><strong style="color: #10b981;">User ID:</strong> <span style="color: #64748b; font-family: monospace; font-size: 14px;">${userId}</span></p>
                        <p style="margin: 0;"><strong style="color: #10b981;">Time:</strong> <span style="color: #64748b;">${timestamp}</span></p>
                    </div>
                    <p style="color: #94a3b8; font-size: 12px; margin: 20px 0 0 0; text-align: center;">
                        ClipMark - Mark the moments that matter
                    </p>
                </div>
            </div>
        `;

        const response = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${RESEND_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                from: EMAIL_FROM,
                to: [ADMIN_EMAIL],
                subject: `🎉 New ClipMark signup: ${username}`,
                html: emailHtml,
                text: `New ClipMark signup!\n\nUsername: ${username}\nUser ID: ${userId}\nTime: ${timestamp}`
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.message || `HTTP ${response.status}`);
        }

        console.log(`📧 Signup notification sent for user: ${username}`);
    } catch (e) {
        console.error('📧 Failed to send signup notification:', e.message);
    }
}

// Send share invitation email (for email shares to non-users)
async function sendShareInvitationEmail(share, ownerUsername) {
    if (!RESEND_API_KEY) {
        console.log('📧 Skipping share invitation email (Resend not configured)');
        return;
    }

    try {
        // Construct share URL - use APP_URL from env or default
        // Link to /app route where share preview logic lives
        const appUrl = process.env.APP_URL || 'http://localhost:3456';
        const shareLink = `${appUrl}/app?share_token=${share.shareToken}`;

        const emailHtml = `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                <div style="background: linear-gradient(135deg, #10b981 0%, #34d399 100%); padding: 30px; border-radius: 12px 12px 0 0;">
                    <h1 style="color: white; margin: 0; font-size: 24px;">Video Shared With You</h1>
                </div>
                <div style="background: #f8fafc; padding: 30px; border-radius: 0 0 12px 12px; border: 1px solid #e2e8f0; border-top: none;">
                    <p style="color: #334155; font-size: 16px; margin: 0 0 20px 0;">
                        <strong style="color: #10b981;">${ownerUsername}</strong> wants to share a video with you!
                    </p>

                    <div style="background: white; padding: 20px; border-radius: 8px; border: 1px solid #e2e8f0; margin-bottom: 20px;">
                        <div style="display: flex; gap: 15px;">
                            <img src="${share.videoThumbnail}" alt="" style="width: 120px; height: 68px; border-radius: 4px; object-fit: cover;" />
                            <div>
                                <p style="margin: 0 0 5px 0; font-weight: 600; color: #1e293b;">${share.videoTitle}</p>
                                ${share.includeNotes ? '<p style="margin: 0; color: #64748b; font-size: 14px;">Includes notes</p>' : ''}
                            </div>
                        </div>
                    </div>

                    <a href="${shareLink}" style="display: inline-block; background: linear-gradient(135deg, #10b981 0%, #34d399 100%); color: white; text-decoration: none; padding: 14px 28px; border-radius: 8px; font-weight: 600; font-size: 16px;">
                        Join ClipMark to View
                    </a>

                    <p style="color: #64748b; font-size: 14px; margin: 20px 0 0 0;">
                        ClipMark helps you save, organize, and annotate YouTube videos with timestamped notes.
                    </p>

                    <p style="color: #94a3b8; font-size: 12px; margin: 20px 0 0 0;">
                        This invitation expires in 30 days.
                    </p>
                </div>
            </div>
        `;

        const response = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${RESEND_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                from: EMAIL_FROM,
                to: [share.targetEmail],
                subject: `${ownerUsername} wants to share a video with you on ClipMark`,
                html: emailHtml,
                text: `${ownerUsername} wants to share "${share.videoTitle}" with you on ClipMark!\n\nJoin here: ${shareLink}\n\nThis link expires in 30 days.`
            })
        });

        if (!response.ok) {
            const error = await response.json();
            console.error(`📧 Resend API error response:`, JSON.stringify(error));
            throw new Error(error.message || `HTTP ${response.status}`);
        }

        const result = await response.json();
        console.log(`📧 Share invitation sent to: ${share.targetEmail} (ID: ${result.id})`);
    } catch (e) {
        console.error(`📧 Failed to send share invitation to ${share.targetEmail}:`, e.message);
        // Log additional context for debugging
        console.error(`📧 EMAIL_FROM: ${EMAIL_FROM}, Share token: ${share.shareToken?.substring(0, 8)}...`);
    }
}

// Send notification when someone accepts your share
async function sendShareAcceptedEmail(share, acceptorUsername, sharerEmail) {
    if (!RESEND_API_KEY || !sharerEmail) {
        console.log('📧 Skipping share accepted email (Resend not configured or no email)');
        return;
    }

    try {
        const emailHtml = `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                <div style="background: linear-gradient(135deg, #10b981 0%, #34d399 100%); padding: 30px; border-radius: 12px 12px 0 0;">
                    <h1 style="color: white; margin: 0; font-size: 24px;">Share Accepted!</h1>
                </div>
                <div style="background: #f8fafc; padding: 30px; border-radius: 0 0 12px 12px; border: 1px solid #e2e8f0; border-top: none;">
                    <p style="color: #334155; font-size: 16px; margin: 0 0 20px 0;">
                        Great news! <strong style="color: #10b981;">${acceptorUsername}</strong> accepted your shared video.
                    </p>

                    <div style="background: white; padding: 15px; border-radius: 8px; border: 1px solid #e2e8f0;">
                        <p style="margin: 0; color: #1e293b;">${share.videoTitle}</p>
                    </div>

                    <p style="color: #94a3b8; font-size: 12px; margin: 20px 0 0 0; text-align: center;">
                        ClipMark - Mark the moments that matter
                    </p>
                </div>
            </div>
        `;

        const response = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${RESEND_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                from: EMAIL_FROM,
                to: [sharerEmail],
                subject: `${acceptorUsername} accepted your shared video`,
                html: emailHtml,
                text: `${acceptorUsername} accepted your shared video "${share.videoTitle}" on ClipMark!`
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.message || `HTTP ${response.status}`);
        }

        console.log(`📧 Share accepted notification sent to: ${sharerEmail}`);
    } catch (e) {
        console.error('📧 Failed to send share accepted email:', e.message);
    }
}

// Static file serving configuration
const STATIC_DIR = __dirname;
const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
};

// =============================================
// AUTHENTICATION SYSTEM
// =============================================

// Data directory paths - use RAILWAY_VOLUME_MOUNT_PATH if available (for persistent storage)
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'data')
    : path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const SHARES_FILE = path.join(DATA_DIR, 'shares.json');

// Share token expiration: 30 days
const SHARE_TOKEN_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

// Rate limiting for login attempts
const loginAttempts = new Map(); // Map<ip_or_username, {count, lockedUntil}>
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

// Rate limiting for share creation
const shareAttempts = new Map(); // Map<userId, {count, resetAt}>
const MAX_SHARES_PER_HOUR = 10;
const SHARE_RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour

// Rate limiting for AI transcription generation
const transcriptionAttempts = new Map(); // Map<userId, {count, resetAt}>
const MAX_TRANSCRIPTIONS_PER_HOUR = 5;
const TRANSCRIPTION_RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour

// Rate limiting for quick-add API
const quickAddAttempts = new Map(); // Map<userId, {count, resetAt}>
const MAX_QUICK_ADDS_PER_HOUR = 30;
const QUICK_ADD_RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour

// =============================================
// SRT/VTT TRANSCRIPT PARSING
// =============================================

// Parse SRT format to transcript segments
// SRT format:
// 1
// 00:00:00,000 --> 00:00:02,500
// First subtitle text
//
// 2
// 00:00:02,500 --> 00:00:05,000
// Second subtitle text
function parseSRT(content) {
    const segments = [];
    const blocks = content.trim().split(/\n\n+/);

    for (const block of blocks) {
        const lines = block.trim().split('\n');
        if (lines.length < 3) continue;

        // Skip the sequence number (first line)
        const timeLine = lines[1];
        const textLines = lines.slice(2);

        // Parse timestamp line: 00:00:00,000 --> 00:00:02,500
        const timeMatch = timeLine.match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
        if (!timeMatch) continue;

        const startSeconds = parseInt(timeMatch[1]) * 3600 +
                            parseInt(timeMatch[2]) * 60 +
                            parseInt(timeMatch[3]) +
                            parseInt(timeMatch[4]) / 1000;

        const endSeconds = parseInt(timeMatch[5]) * 3600 +
                          parseInt(timeMatch[6]) * 60 +
                          parseInt(timeMatch[7]) +
                          parseInt(timeMatch[8]) / 1000;

        const text = textLines.join(' ').replace(/<[^>]+>/g, '').trim();
        if (text) {
            segments.push({
                start: startSeconds,
                duration: endSeconds - startSeconds,
                text
            });
        }
    }

    return segments;
}

// Parse VTT (WebVTT) format to transcript segments
// VTT format:
// WEBVTT
//
// 00:00:00.000 --> 00:00:02.500
// First subtitle text
//
// 00:00:02.500 --> 00:00:05.000
// Second subtitle text
function parseVTT(content) {
    const segments = [];

    // Remove WEBVTT header and any metadata
    let vttContent = content.replace(/^WEBVTT[^\n]*\n/, '');
    vttContent = vttContent.replace(/^NOTE[^\n]*\n/gm, '');
    vttContent = vttContent.replace(/^STYLE[^\n]*\n(?:.*\n)*?\n/gm, '');

    const blocks = vttContent.trim().split(/\n\n+/);

    for (const block of blocks) {
        const lines = block.trim().split('\n');
        if (lines.length < 2) continue;

        // Find the timestamp line (might have a cue identifier before it)
        let timeLineIndex = 0;
        let timeLine = lines[0];

        // If first line doesn't contain -->, it's a cue identifier
        if (!timeLine.includes('-->') && lines.length > 1) {
            timeLineIndex = 1;
            timeLine = lines[1];
        }

        const textLines = lines.slice(timeLineIndex + 1);

        // Parse timestamp line: 00:00:00.000 --> 00:00:02.500 or 00:00.000 --> 00:02.500
        let timeMatch = timeLine.match(/(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/);
        if (!timeMatch) {
            // Try shorter format: 00:00.000 --> 00:02.500
            timeMatch = timeLine.match(/(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2}):(\d{2})[.,](\d{3})/);
            if (timeMatch) {
                const startSeconds = parseInt(timeMatch[1]) * 60 +
                                    parseInt(timeMatch[2]) +
                                    parseInt(timeMatch[3]) / 1000;
                const endSeconds = parseInt(timeMatch[4]) * 60 +
                                  parseInt(timeMatch[5]) +
                                  parseInt(timeMatch[6]) / 1000;

                const text = textLines.join(' ').replace(/<[^>]+>/g, '').trim();
                if (text) {
                    segments.push({
                        start: startSeconds,
                        duration: endSeconds - startSeconds,
                        text
                    });
                }
                continue;
            }
            continue;
        }

        const startSeconds = parseInt(timeMatch[1]) * 3600 +
                            parseInt(timeMatch[2]) * 60 +
                            parseInt(timeMatch[3]) +
                            parseInt(timeMatch[4]) / 1000;

        const endSeconds = parseInt(timeMatch[5]) * 3600 +
                          parseInt(timeMatch[6]) * 60 +
                          parseInt(timeMatch[7]) +
                          parseInt(timeMatch[8]) / 1000;

        const text = textLines.join(' ').replace(/<[^>]+>/g, '').trim();
        if (text) {
            segments.push({
                start: startSeconds,
                duration: endSeconds - startSeconds,
                text
            });
        }
    }

    return segments;
}

// Detect format and parse accordingly
function parseSubtitleFile(content, filename) {
    const ext = filename.toLowerCase().split('.').pop();

    if (ext === 'srt') {
        return { segments: parseSRT(content), source: 'srt' };
    } else if (ext === 'vtt') {
        return { segments: parseVTT(content), source: 'vtt' };
    } else if (content.trim().startsWith('WEBVTT')) {
        return { segments: parseVTT(content), source: 'vtt' };
    } else {
        // Default to SRT format
        return { segments: parseSRT(content), source: 'srt' };
    }
}

// Check transcription rate limit
function checkTranscriptionRateLimit(userId) {
    const now = Date.now();
    const record = transcriptionAttempts.get(userId);

    if (!record || now > record.resetAt) {
        return { allowed: true, remaining: MAX_TRANSCRIPTIONS_PER_HOUR };
    }

    if (record.count >= MAX_TRANSCRIPTIONS_PER_HOUR) {
        const waitTime = Math.ceil((record.resetAt - now) / 60000);
        return { allowed: false, remaining: 0, waitMinutes: waitTime };
    }

    return { allowed: true, remaining: MAX_TRANSCRIPTIONS_PER_HOUR - record.count };
}

// Record transcription attempt
function recordTranscriptionAttempt(userId) {
    const now = Date.now();
    const record = transcriptionAttempts.get(userId);

    if (!record || now > record.resetAt) {
        transcriptionAttempts.set(userId, {
            count: 1,
            resetAt: now + TRANSCRIPTION_RATE_LIMIT_WINDOW
        });
    } else {
        record.count++;
    }
}

// Quick-add rate limiter
function checkQuickAddRateLimit(userId) {
    const now = Date.now();
    const record = quickAddAttempts.get(userId);

    if (!record || now > record.resetAt) {
        return { allowed: true, remaining: MAX_QUICK_ADDS_PER_HOUR };
    }

    if (record.count >= MAX_QUICK_ADDS_PER_HOUR) {
        const waitTime = Math.ceil((record.resetAt - now) / 60000);
        return { allowed: false, remaining: 0, waitMinutes: waitTime };
    }

    return { allowed: true, remaining: MAX_QUICK_ADDS_PER_HOUR - record.count };
}

function recordQuickAddAttempt(userId) {
    const now = Date.now();
    const record = quickAddAttempts.get(userId);

    if (!record || now > record.resetAt) {
        quickAddAttempts.set(userId, {
            count: 1,
            resetAt: now + QUICK_ADD_RATE_LIMIT_WINDOW
        });
    } else {
        record.count++;
    }
}

// Parse video URL into sourceType and sourceId
function parseVideoUrl(videoUrl) {
    try {
        const urlObj = new URL(videoUrl);
        const hostname = urlObj.hostname.toLowerCase().replace(/^www\./, '');

        // YouTube
        if (hostname === 'youtube.com' || hostname === 'm.youtube.com' || hostname === 'youtu.be') {
            let videoId = null;
            if (hostname === 'youtu.be') {
                videoId = urlObj.pathname.slice(1).split('/')[0];
            } else {
                videoId = urlObj.searchParams.get('v');
                if (!videoId) {
                    // Handle /embed/ID or /shorts/ID
                    const pathMatch = urlObj.pathname.match(/\/(embed|shorts|live)\/([^/?]+)/);
                    if (pathMatch) videoId = pathMatch[2];
                }
            }
            if (videoId) return { sourceType: 'youtube', sourceId: videoId };
        }

        // Vimeo
        if (hostname === 'vimeo.com' || hostname === 'player.vimeo.com') {
            const match = urlObj.pathname.match(/\/(?:video\/)?(\d+)/);
            if (match) return { sourceType: 'vimeo', sourceId: match[1] };
        }

        // Loom
        if (hostname === 'loom.com' || hostname === 'www.loom.com') {
            const match = urlObj.pathname.match(/\/share\/([a-f0-9]+)/);
            if (match) return { sourceType: 'loom', sourceId: match[1] };
        }

        // Wistia
        if (hostname.endsWith('.wistia.com') || hostname === 'fast.wistia.net') {
            const match = urlObj.pathname.match(/\/medias\/([a-zA-Z0-9]+)/);
            if (match) return { sourceType: 'wistia', sourceId: match[1] };
        }

        // Google Drive
        if (hostname === 'drive.google.com') {
            const match = urlObj.pathname.match(/\/file\/d\/([^/]+)/);
            if (match) return { sourceType: 'googledrive', sourceId: match[1] };
        }

        // X / Twitter
        if (hostname === 'twitter.com' || hostname === 'x.com') {
            const match = urlObj.pathname.match(/\/[^/]+\/status\/(\d+)/);
            if (match) return { sourceType: 'twitter', sourceId: match[1] };
        }

        // Direct video URLs
        if (/\.(mp4|webm|ogg|mov)(\?.*)?$/i.test(urlObj.pathname)) {
            return { sourceType: 'direct', sourceId: null, sourceUrl: videoUrl };
        }

        return null; // Unsupported
    } catch (e) {
        return null;
    }
}

// Fetch video metadata from URL (title, thumbnail, description)
async function fetchVideoMetadata(sourceType, sourceId, sourceUrl) {
    const metadata = { title: '', thumbnail: '', description: '' };

    try {
        if (sourceType === 'youtube' && sourceId) {
            // Try YouTube API first if configured
            if (YOUTUBE_API_KEY) {
                const ytResponse = await fetchUrl(
                    `https://www.googleapis.com/youtube/v3/videos?id=${sourceId}&part=snippet&key=${YOUTUBE_API_KEY}`
                );
                if (ytResponse.status === 200) {
                    const data = JSON.parse(ytResponse.data);
                    const video = data.items?.[0];
                    if (video) {
                        metadata.title = video.snippet?.title || '';
                        metadata.thumbnail = video.snippet?.thumbnails?.high?.url || video.snippet?.thumbnails?.default?.url || '';
                        metadata.description = video.snippet?.description || '';
                        metadata.publishDate = video.snippet?.publishedAt || '';
                        metadata.channelTitle = video.snippet?.channelTitle || '';
                        return metadata;
                    }
                }
            }
            // Fallback: oEmbed
            const oembedResp = await fetchUrl(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${sourceId}&format=json`);
            if (oembedResp.status === 200) {
                const data = JSON.parse(oembedResp.data);
                metadata.title = data.title || '';
                metadata.thumbnail = `https://i.ytimg.com/vi/${sourceId}/hqdefault.jpg`;
                return metadata;
            }
        }

        if (sourceType === 'vimeo' && sourceId) {
            const oembedResp = await fetchUrl(`https://vimeo.com/api/oembed.json?url=https://vimeo.com/${sourceId}`);
            if (oembedResp.status === 200) {
                const data = JSON.parse(oembedResp.data);
                metadata.title = data.title || '';
                metadata.thumbnail = data.thumbnail_url || '';
                metadata.description = data.description || '';
                return metadata;
            }
        }

        if (sourceType === 'wistia' && sourceId) {
            const oembedResp = await fetchUrl(`https://fast.wistia.com/oembed?url=https://fast.wistia.com/medias/${sourceId}&format=json`);
            if (oembedResp.status === 200) {
                const data = JSON.parse(oembedResp.data);
                metadata.title = data.title || '';
                metadata.thumbnail = data.thumbnail_url || '';
                return metadata;
            }
        }

        if (sourceType === 'loom' && sourceId) {
            const oembedResp = await fetchUrl(`https://www.loom.com/v1/oembed?url=https://www.loom.com/share/${sourceId}`);
            if (oembedResp.status === 200) {
                const data = JSON.parse(oembedResp.data);
                metadata.title = data.title || '';
                metadata.thumbnail = data.thumbnail_url || '';
                return metadata;
            }
        }

        if (sourceType === 'twitter' && sourceId) {
            const oembedResp = await fetchUrl(`https://publish.twitter.com/oembed?url=https://twitter.com/i/status/${sourceId}&format=json`);
            if (oembedResp.status === 200) {
                const data = JSON.parse(oembedResp.data);
                metadata.title = data.author_name ? `${data.author_name} on X` : `Tweet ${sourceId}`;
                return metadata;
            }
        }

        // Direct / Google Drive — just use URL as title
        if (sourceType === 'direct' || sourceType === 'googledrive') {
            metadata.title = sourceUrl ? sourceUrl.split('/').pop().split('?')[0] : `Video ${sourceId || ''}`;
        }
    } catch (e) {
        console.error(`⚠️ Error fetching metadata for ${sourceType}:${sourceId}:`, e.message);
    }

    return metadata;
}

// Session duration: 30 days
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

// Ensure data directories exist
function ensureDataDirs() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        console.log('📁 Created data directory');
    }
}

// Read users from file
function readUsers() {
    try {
        if (fs.existsSync(USERS_FILE)) {
            const data = fs.readFileSync(USERS_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (e) {
        console.error('Error reading users:', e.message);
    }
    return {};
}

// Write users to file
function writeUsers(users) {
    try {
        ensureDataDirs();
        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
        return true;
    } catch (e) {
        console.error('Error writing users:', e.message);
        return false;
    }
}

// Read sessions from file
function readSessions() {
    try {
        if (fs.existsSync(SESSIONS_FILE)) {
            const data = fs.readFileSync(SESSIONS_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (e) {
        console.error('Error reading sessions:', e.message);
    }
    return {};
}

// Write sessions to file
function writeSessions(sessions) {
    try {
        ensureDataDirs();
        fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
        return true;
    } catch (e) {
        console.error('Error writing sessions:', e.message);
        return false;
    }
}

// Clean expired sessions
function cleanExpiredSessions() {
    const sessions = readSessions();
    const now = Date.now();
    let cleaned = false;

    for (const [token, session] of Object.entries(sessions)) {
        if (session.expiresAt < now) {
            delete sessions[token];
            cleaned = true;
        }
    }

    if (cleaned) {
        writeSessions(sessions);
        console.log('🧹 Cleaned expired sessions');
    }
}

// Create session for user
function createSession(userId) {
    const sessions = readSessions();
    const token = uuidv4();
    const expiresAt = Date.now() + SESSION_DURATION_MS;

    sessions[token] = { userId, expiresAt, createdAt: Date.now() };
    writeSessions(sessions);

    return { token, expiresAt };
}

// Validate session token and return userId
function validateSession(token) {
    if (!token) {
        console.log('🔐 validateSession: No token provided');
        return null;
    }

    const sessions = readSessions();
    const session = sessions[token];

    if (!session) {
        console.log(`🔐 validateSession: Token not found in sessions (${Object.keys(sessions).length} total sessions)`);
        return null;
    }
    if (session.expiresAt < Date.now()) {
        // Clean up expired session
        console.log(`🔐 validateSession: Session expired for user ${session.userId}`);
        delete sessions[token];
        writeSessions(sessions);
        return null;
    }

    return session.userId;
}

// Delete session (logout)
function deleteSession(token) {
    const sessions = readSessions();
    if (sessions[token]) {
        delete sessions[token];
        writeSessions(sessions);
        return true;
    }
    return false;
}

// Delete all sessions for a user (used when suspending/deleting)
function deleteUserSessions(userId) {
    const sessions = readSessions();
    let deleted = 0;
    for (const [token, session] of Object.entries(sessions)) {
        if (session.userId === userId) {
            delete sessions[token];
            deleted++;
        }
    }
    if (deleted > 0) {
        writeSessions(sessions);
        console.log(`🧹 Deleted ${deleted} sessions for user ${userId}`);
    }
    return deleted;
}

// =============================================
// SHARING SYSTEM
// =============================================

// Read shares from file
function readShares() {
    try {
        if (fs.existsSync(SHARES_FILE)) {
            const data = fs.readFileSync(SHARES_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (e) {
        console.error('Error reading shares:', e.message);
    }
    return {};
}

// Write shares to file
function writeShares(shares) {
    try {
        ensureDataDirs();
        fs.writeFileSync(SHARES_FILE, JSON.stringify(shares, null, 2));
        return true;
    } catch (e) {
        console.error('Error writing shares:', e.message);
        return false;
    }
}

// Read user's "shared with me" file
function readUserSharedWithMe(userId) {
    try {
        const filePath = path.join(getUserDataDir(userId), 'shared-with-me.json');
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf8');
            return JSON.parse(data);
        }
    } catch (e) {
        console.error(`Error reading shared-with-me for user ${userId}:`, e.message);
    }
    return [];
}

// Write user's "shared with me" file
function writeUserSharedWithMe(userId, sharedWithMe) {
    try {
        ensureUserDataDir(userId);
        const filePath = path.join(getUserDataDir(userId), 'shared-with-me.json');
        fs.writeFileSync(filePath, JSON.stringify(sharedWithMe, null, 2));
        return true;
    } catch (e) {
        console.error(`Error writing shared-with-me for user ${userId}:`, e.message);
        return false;
    }
}

// Generate a share token
function generateShareToken() {
    return uuidv4() + '-' + uuidv4(); // Double UUID for extra security
}

// Clean expired shares (called periodically)
function cleanExpiredShares() {
    const shares = readShares();
    const now = Date.now();
    let cleaned = 0;

    for (const [shareId, share] of Object.entries(shares)) {
        // Only clean email shares with expired tokens
        if (share.type === 'email' && share.status === 'pending' && share.tokenExpiresAt < now) {
            delete shares[shareId];
            cleaned++;
        }
    }

    if (cleaned > 0) {
        writeShares(shares);
        console.log(`🧹 Cleaned ${cleaned} expired share tokens`);
    }
}

// Check share rate limit for user
function checkShareRateLimit(userId) {
    const now = Date.now();
    const attempt = shareAttempts.get(userId);

    if (!attempt || now > attempt.resetAt) {
        // Reset window
        shareAttempts.set(userId, { count: 1, resetAt: now + SHARE_RATE_LIMIT_WINDOW });
        return { allowed: true, remaining: MAX_SHARES_PER_HOUR - 1 };
    }

    if (attempt.count >= MAX_SHARES_PER_HOUR) {
        const minutesRemaining = Math.ceil((attempt.resetAt - now) / 60000);
        return { allowed: false, minutesRemaining };
    }

    // Increment count
    attempt.count++;
    shareAttempts.set(userId, attempt);
    return { allowed: true, remaining: MAX_SHARES_PER_HOUR - attempt.count };
}

// Get user data directory
function getUserDataDir(userId) {
    return path.join(DATA_DIR, 'users', userId);
}

// Check if user is admin (by username)
function isAdminUser(userId) {
    const users = readUsers();
    const user = users[userId];
    return user?.username?.toLowerCase() === 'absolute0net';
}

// Read user watch time
function readUserWatchTime(userId) {
    try {
        const filePath = path.join(getUserDataDir(userId), 'watchtime.json');
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf8');
            return JSON.parse(data);
        }
    } catch (e) {
        console.error(`Error reading watch time for user ${userId}:`, e.message);
    }
    return {};
}

// Write user watch time
function writeUserWatchTime(userId, watchTime) {
    try {
        ensureUserDataDir(userId);
        const filePath = path.join(getUserDataDir(userId), 'watchtime.json');
        fs.writeFileSync(filePath, JSON.stringify(watchTime, null, 2));
        return true;
    } catch (e) {
        console.error(`Error writing watch time for user ${userId}:`, e.message);
        return false;
    }
}

// API usage tracking per user
function readUserApiUsage(userId) {
    try {
        const filePath = path.join(getUserDataDir(userId), 'api-usage.json');
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
    } catch (e) {
        console.error(`Error reading API usage for user ${userId}:`, e.message);
    }
    return { totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0, totalThinkingTokens: 0, calls: [] };
}

function writeUserApiUsage(userId, usage) {
    try {
        ensureUserDataDir(userId);
        const filePath = path.join(getUserDataDir(userId), 'api-usage.json');
        fs.writeFileSync(filePath, JSON.stringify(usage, null, 2));
    } catch (e) {
        console.error(`Error writing API usage for user ${userId}:`, e.message);
    }
}

function trackApiUsage(userId, endpoint, usageMetadata) {
    if (!userId) return;
    const usage = readUserApiUsage(userId);
    const inputTokens = usageMetadata?.promptTokenCount || 0;
    const outputTokens = usageMetadata?.candidatesTokenCount || 0;
    const thinkingTokens = usageMetadata?.thoughtsTokenCount || 0;

    usage.totalCalls = (usage.totalCalls || 0) + 1;
    usage.totalInputTokens = (usage.totalInputTokens || 0) + inputTokens;
    usage.totalOutputTokens = (usage.totalOutputTokens || 0) + outputTokens;
    usage.totalThinkingTokens = (usage.totalThinkingTokens || 0) + thinkingTokens;

    // Keep last 100 calls for detail view
    usage.calls = usage.calls || [];
    usage.calls.unshift({
        endpoint,
        inputTokens,
        outputTokens,
        thinkingTokens,
        timestamp: Date.now()
    });
    if (usage.calls.length > 100) usage.calls = usage.calls.slice(0, 100);

    writeUserApiUsage(userId, usage);
    console.log(`📊 API usage tracked for ${userId}: ${endpoint} — ${inputTokens} in / ${outputTokens} out`);
}

// Track system-level API calls (e.g., transcript fetches not tied to a user)
function trackSystemApiUsage(endpoint, usageMetadata) {
    trackApiUsage('_system', endpoint, usageMetadata);
}

// Get admin stats for all users
function getAdminStats() {
    const users = readUsers();
    const sessions = readSessions();
    const userStats = [];
    let totalVideos = 0;
    let totalNotes = 0;
    let totalWatchTime = 0;
    let totalApiCalls = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    // Build a map of userId -> most recent session createdAt
    const lastLoginMap = {};
    for (const session of Object.values(sessions)) {
        const { userId, createdAt } = session;
        if (!lastLoginMap[userId] || createdAt > lastLoginMap[userId]) {
            lastLoginMap[userId] = createdAt;
        }
    }

    for (const [userId, user] of Object.entries(users)) {
        const bookmarks = readUserBookmarks(userId);
        const watchTime = readUserWatchTime(userId);
        const apiUsage = readUserApiUsage(userId);

        // Calculate video and note counts
        const videoCount = bookmarks.length;
        let noteCount = 0;
        const videos = bookmarks.map(video => {
            const notes = video.notes || [];
            noteCount += notes.length;
            return {
                id: video.id,
                title: video.title || 'Untitled',
                sourceType: video.sourceType || 'youtube',
                sourceUrl: video.sourceUrl || null,
                videoId: video.videoId || video.sourceId || null,
                thumbnail: video.thumbnail || null,
                notes: notes.map(n => ({
                    id: n.id,
                    text: n.text,
                    timestamp: n.timestamp,
                    createdAt: n.createdAt,
                    favorite: n.favorite || false
                }))
            };
        });

        // Calculate total watch time for this user
        const userWatchTime = Object.values(watchTime).reduce((sum, seconds) => sum + seconds, 0);

        totalVideos += videoCount;
        totalNotes += noteCount;
        totalWatchTime += userWatchTime;
        totalApiCalls += apiUsage.totalCalls || 0;
        totalInputTokens += apiUsage.totalInputTokens || 0;
        totalOutputTokens += apiUsage.totalOutputTokens || 0;

        userStats.push({
            userId,
            username: user.username,
            createdAt: user.createdAt,
            lastLogin: lastLoginMap[userId] || null,
            suspended: user.suspended || false,
            videoCount,
            noteCount,
            watchTime: userWatchTime,
            apiCalls: apiUsage.totalCalls || 0,
            inputTokens: apiUsage.totalInputTokens || 0,
            outputTokens: apiUsage.totalOutputTokens || 0,
            recentApiCalls: (apiUsage.calls || []).slice(0, 10),
            videos
        });
    }

    // Sort by creation date (newest first)
    userStats.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    // Also include system-level API usage
    const systemUsage = readUserApiUsage('_system');

    // Build daily activity timeline from all API calls and note creation dates
    const dailyActivity = {};
    const allApiCalls = [];

    // Collect all API calls from all users + system
    for (const [uid, user] of Object.entries(users)) {
        const usage = readUserApiUsage(uid);
        for (const call of (usage.calls || [])) {
            allApiCalls.push(call);
        }
    }
    for (const call of (systemUsage.calls || [])) {
        allApiCalls.push(call);
    }

    // Aggregate into daily buckets (last 30 days)
    const now = Date.now();
    const thirtyDaysAgo = now - 30 * 86400000;
    for (let d = 0; d < 30; d++) {
        const date = new Date(now - d * 86400000);
        const key = date.toISOString().split('T')[0];
        dailyActivity[key] = { apiCalls: 0, inputTokens: 0, outputTokens: 0, notes: 0, signups: 0 };
    }

    for (const call of allApiCalls) {
        if (call.timestamp && call.timestamp > thirtyDaysAgo) {
            const key = new Date(call.timestamp).toISOString().split('T')[0];
            if (dailyActivity[key]) {
                dailyActivity[key].apiCalls++;
                dailyActivity[key].inputTokens += call.inputTokens || 0;
                dailyActivity[key].outputTokens += call.outputTokens || 0;
            }
        }
    }

    // Count note creations per day
    for (const user of userStats) {
        for (const video of (user.videos || [])) {
            for (const note of (video.notes || [])) {
                if (note.createdAt) {
                    const key = new Date(note.createdAt).toISOString().split('T')[0];
                    if (dailyActivity[key]) dailyActivity[key].notes++;
                }
            }
        }
    }

    // Count signups per day
    for (const [uid, user] of Object.entries(users)) {
        if (user.createdAt) {
            const key = new Date(user.createdAt).toISOString().split('T')[0];
            if (dailyActivity[key]) dailyActivity[key].signups++;
        }
    }

    // Convert to sorted array
    const timeline = Object.entries(dailyActivity)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, data]) => ({ date, ...data }));

    return {
        totalUsers: Object.keys(users).length,
        totalVideos,
        totalNotes,
        totalWatchTime,
        totalApiCalls: totalApiCalls + (systemUsage.totalCalls || 0),
        totalInputTokens: totalInputTokens + (systemUsage.totalInputTokens || 0),
        totalOutputTokens: totalOutputTokens + (systemUsage.totalOutputTokens || 0),
        timeline,
        users: userStats
    };
}

// Ensure user data directory exists
function ensureUserDataDir(userId) {
    const userDir = getUserDataDir(userId);
    if (!fs.existsSync(userDir)) {
        fs.mkdirSync(userDir, { recursive: true });
        console.log(`📁 Created user data directory for ${userId}`);
    }
    return userDir;
}

// Subscription helpers
function getUserSubscription(userId) {
    const users = readUsers();
    const user = users[userId];
    if (!user) return { status: 'none' };

    const sub = user.subscription || {};
    const createdAt = user.createdAt || Date.now();
    const trialEndsAt = sub.trialEndsAt || (createdAt + STRIPE_TRIAL_DAYS * 86400000);
    const now = Date.now();

    // Admin always has access
    if (isAdminUser(userId)) {
        return { status: 'active', plan: 'admin', trialEndsAt };
    }

    // Active Stripe subscription
    if (sub.stripeStatus === 'active' || sub.stripeStatus === 'trialing') {
        return {
            status: 'active',
            plan: sub.plan || 'pro',
            stripeStatus: sub.stripeStatus,
            stripeCustomerId: sub.stripeCustomerId,
            stripeSubscriptionId: sub.stripeSubscriptionId,
            currentPeriodEnd: sub.currentPeriodEnd,
            trialEndsAt
        };
    }

    // Within trial period (no subscription yet)
    if (now < trialEndsAt && !sub.stripeStatus) {
        const daysLeft = Math.ceil((trialEndsAt - now) / 86400000);
        return {
            status: 'trial',
            daysLeft,
            trialEndsAt,
            stripeCustomerId: sub.stripeCustomerId
        };
    }

    // Trial expired, no active subscription
    return {
        status: 'expired',
        trialEndsAt,
        stripeCustomerId: sub.stripeCustomerId
    };
}

function updateUserSubscription(userId, subData) {
    const users = readUsers();
    if (!users[userId]) return false;
    users[userId].subscription = { ...(users[userId].subscription || {}), ...subData };
    return writeUsers(users);
}

// Read user bookmarks
function readUserBookmarks(userId) {
    try {
        const filePath = path.join(getUserDataDir(userId), 'bookmarks.json');
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf8');
            return JSON.parse(data);
        }
    } catch (e) {
        console.error(`Error reading bookmarks for user ${userId}:`, e.message);
    }
    return [];
}

// Write user bookmarks
function writeUserBookmarks(userId, bookmarks) {
    try {
        ensureUserDataDir(userId);
        const filePath = path.join(getUserDataDir(userId), 'bookmarks.json');
        fs.writeFileSync(filePath, JSON.stringify(bookmarks, null, 2));
        return true;
    } catch (e) {
        console.error(`Error writing bookmarks for user ${userId}:`, e.message);
        return false;
    }
}

// Read user categories
function readUserCategories(userId) {
    try {
        const filePath = path.join(getUserDataDir(userId), 'categories.json');
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf8');
            return JSON.parse(data);
        }
    } catch (e) {
        console.error(`Error reading categories for user ${userId}:`, e.message);
    }
    return [];
}

// Write user categories
function writeUserCategories(userId, categories) {
    try {
        ensureUserDataDir(userId);
        const filePath = path.join(getUserDataDir(userId), 'categories.json');
        fs.writeFileSync(filePath, JSON.stringify(categories, null, 2));
        return true;
    } catch (e) {
        console.error(`Error writing categories for user ${userId}:`, e.message);
        return false;
    }
}

// Check if this is the first user (for migration)
function isFirstUser() {
    const users = readUsers();
    return Object.keys(users).length === 0;
}

// Migrate legacy data to first user
function migrateLegacyData(userId) {
    const legacyBookmarks = BOOKMARKS_FILE;
    const legacyCategories = CATEGORIES_FILE;

    // Check if legacy files exist and haven't been migrated
    if (fs.existsSync(legacyBookmarks) && !fs.existsSync(legacyBookmarks + '.legacy')) {
        try {
            const bookmarks = JSON.parse(fs.readFileSync(legacyBookmarks, 'utf8'));
            if (Array.isArray(bookmarks) && bookmarks.length > 0) {
                writeUserBookmarks(userId, bookmarks);
                fs.renameSync(legacyBookmarks, legacyBookmarks + '.legacy');
                console.log(`📦 Migrated ${bookmarks.length} legacy bookmarks to user ${userId}`);
            }
        } catch (e) {
            console.error('Error migrating legacy bookmarks:', e.message);
        }
    }

    if (fs.existsSync(legacyCategories) && !fs.existsSync(legacyCategories + '.legacy')) {
        try {
            const categories = JSON.parse(fs.readFileSync(legacyCategories, 'utf8'));
            if (Array.isArray(categories) && categories.length > 0) {
                writeUserCategories(userId, categories);
                fs.renameSync(legacyCategories, legacyCategories + '.legacy');
                console.log(`📦 Migrated ${categories.length} legacy categories to user ${userId}`);
            }
        } catch (e) {
            console.error('Error migrating legacy categories:', e.message);
        }
    }
}

// Rate limiting helpers
function getClientIdentifier(req, username = null) {
    // Use username if provided, otherwise use IP
    if (username) return `user:${username}`;
    const forwarded = req.headers['x-forwarded-for'];
    const ip = forwarded ? forwarded.split(',')[0].trim() : req.socket.remoteAddress;
    return `ip:${ip}`;
}

function checkRateLimit(identifier) {
    const attempt = loginAttempts.get(identifier);
    if (!attempt) return { allowed: true };

    if (attempt.lockedUntil && attempt.lockedUntil > Date.now()) {
        const remainingMs = attempt.lockedUntil - Date.now();
        const remainingMins = Math.ceil(remainingMs / 60000);
        return {
            allowed: false,
            message: `Too many failed attempts. Try again in ${remainingMins} minute(s).`
        };
    }

    return { allowed: true };
}

function recordFailedLogin(identifier) {
    const attempt = loginAttempts.get(identifier) || { count: 0, lockedUntil: null };
    attempt.count++;

    if (attempt.count >= MAX_LOGIN_ATTEMPTS) {
        attempt.lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
        console.log(`🔒 Locked out ${identifier} for ${LOCKOUT_DURATION_MS / 60000} minutes`);
    }

    loginAttempts.set(identifier, attempt);
}

function clearFailedLogins(identifier) {
    loginAttempts.delete(identifier);
}

// Extract auth token from request
function extractAuthToken(req) {
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
        return authHeader.substring(7);
    }
    return null;
}

// Authentication middleware - returns userId or null
function authenticateRequest(req) {
    const token = extractAuthToken(req);
    if (!token) return null;
    return validateSession(token);
}

// Validate username format
function isValidUsername(username) {
    return /^[a-zA-Z0-9_]{3,30}$/.test(username);
}

// Validate password strength
function isValidPassword(password) {
    return password && password.length >= 6;
}

// Path to yt-dlp binary (check multiple locations)
const YT_DLP_PATHS = [
    path.join(__dirname, 'yt-dlp'),  // Project directory (preferred)
    '/tmp/yt-dlp',
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    'yt-dlp'  // Will use PATH
];

function findYtDlp() {
    for (const ytdlpPath of YT_DLP_PATHS) {
        try {
            if (fs.existsSync(ytdlpPath)) {
                return ytdlpPath;
            }
        } catch (e) {
            // Continue checking
        }
    }
    return 'yt-dlp';  // Default to PATH
}

// File paths
const BOOKMARKS_FILE = path.join(__dirname, 'bookmarks.json');
const CATEGORIES_FILE = path.join(__dirname, 'categories.json');
// Store transcript cache on persistent volume if available, otherwise in app dir
const TRANSCRIPT_CACHE_FILE = process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'data', 'transcript-cache.json')
    : path.join(__dirname, 'transcript-cache.json');

// Cache duration: 30 days in milliseconds (longer cache to reduce YouTube requests)
const CACHE_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

// Rate limiting: minimum delay between YouTube requests (in ms)
const MIN_REQUEST_DELAY = 3000;
let lastYouTubeRequest = 0;

// Transcript cache functions
function readTranscriptCache() {
    try {
        if (fs.existsSync(TRANSCRIPT_CACHE_FILE)) {
            const data = fs.readFileSync(TRANSCRIPT_CACHE_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (e) {
        console.error('Error reading transcript cache:', e.message);
    }
    return {};
}

function writeTranscriptCache(cache) {
    try {
        fs.writeFileSync(TRANSCRIPT_CACHE_FILE, JSON.stringify(cache, null, 2));
        return true;
    } catch (e) {
        console.error('Error writing transcript cache:', e.message);
        return false;
    }
}

function getCachedTranscript(videoId) {
    const cache = readTranscriptCache();
    const entry = cache[videoId];
    if (entry && entry.timestamp && entry.transcript) {
        const age = Date.now() - entry.timestamp;
        if (age < CACHE_DURATION_MS) {
            console.log(`✅ Cache hit for ${videoId} (age: ${Math.round(age / 1000 / 60)} minutes)`);
            return entry.transcript;
        } else {
            console.log(`⚠️ Cache expired for ${videoId} (age: ${Math.round(age / 1000 / 60 / 60)} hours)`);
        }
    }
    return null;
}

function cacheTranscript(videoId, transcript) {
    const cache = readTranscriptCache();
    cache[videoId] = {
        timestamp: Date.now(),
        transcript: transcript
    };
    writeTranscriptCache(cache);
    console.log(`💾 Cached transcript for ${videoId} (${transcript.length} segments)`);
}

// Wait for rate limiting
async function waitForRateLimit() {
    const now = Date.now();
    const timeSinceLastRequest = now - lastYouTubeRequest;
    if (timeSinceLastRequest < MIN_REQUEST_DELAY) {
        const waitTime = MIN_REQUEST_DELAY - timeSinceLastRequest;
        console.log(`⏳ Rate limiting: waiting ${waitTime}ms before next YouTube request`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    lastYouTubeRequest = Date.now();
}

// Read bookmarks from file
function readBookmarks() {
    try {
        if (fs.existsSync(BOOKMARKS_FILE)) {
            const data = fs.readFileSync(BOOKMARKS_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (e) {
        console.error('Error reading bookmarks:', e.message);
    }
    return [];
}

// Write bookmarks to file
function writeBookmarks(bookmarks) {
    try {
        fs.writeFileSync(BOOKMARKS_FILE, JSON.stringify(bookmarks, null, 2));
        return true;
    } catch (e) {
        console.error('Error writing bookmarks:', e.message);
        return false;
    }
}

// Read categories from file
function readCategories() {
    try {
        if (fs.existsSync(CATEGORIES_FILE)) {
            const data = fs.readFileSync(CATEGORIES_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (e) {
        console.error('Error reading categories:', e.message);
    }
    return [];
}

// Write categories to file
function writeCategories(categories) {
    try {
        fs.writeFileSync(CATEGORIES_FILE, JSON.stringify(categories, null, 2));
        return true;
    } catch (e) {
        console.error('Error writing categories:', e.message);
        return false;
    }
}

// Parse request body
function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : null);
            } catch (e) {
                reject(new Error('Invalid JSON'));
            }
        });
        req.on('error', reject);
    });
}

// Fetch URL helper
// Rotate user agents to reduce rate limiting fingerprinting
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15',
];
let userAgentIndex = 0;
function getNextUserAgent() {
    const ua = USER_AGENTS[userAgentIndex % USER_AGENTS.length];
    userAgentIndex++;
    return ua;
}

function fetchUrl(url, options = {}) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const client = parsedUrl.protocol === 'https:' ? https : http;

        const reqOptions = {
            hostname: parsedUrl.hostname,
            path: parsedUrl.pathname + parsedUrl.search,
            method: options.method || 'GET',
            // Force IPv4 when caller requests it (e.g. IP-restricted API keys)
            ...(options.forceIPv4 ? { family: 4 } : {}),
            headers: {
                'User-Agent': getNextUserAgent(),
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                // Consent cookie bypasses YouTube's consent wall for bot-like requests
                'Cookie': 'CONSENT=YES+1',
                // Content-Length required for APIs that don't support chunked transfer-encoding
                ...(options.body ? { 'Content-Length': Buffer.byteLength(options.body) } : {}),
                ...options.headers
            }
        };

        const req = client.request(reqOptions, (res) => {
            // Handle redirects
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetchUrl(res.headers.location, options).then(resolve).catch(reject);
            }

            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ status: res.statusCode, data, headers: res.headers }));
        });

        req.on('error', reject);
        req.setTimeout(options.timeout || 15000, () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });

        if (options.body) {
            req.write(options.body);
        }
        req.end();
    });
}

// Fetch with retry and exponential backoff for 429 responses
async function fetchUrlWithRetry(url, options = {}, maxRetries = 3) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const response = await fetchUrl(url, options);
        if (response.status !== 429 || attempt === maxRetries) {
            return response;
        }
        const delay = Math.min(2000 * Math.pow(2, attempt), 10000);
        console.log(`⏳ Got 429, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...`);
        await new Promise(resolve => setTimeout(resolve, delay));
    }
}

// Decode HTML entities
function decodeHtml(text) {
    return text
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x27;/g, "'")
        .replace(/&#x2F;/g, '/')
        .replace(/\\n/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Extract transcript using yt-dlp (more reliable)
async function getTranscriptYtDlp(videoId) {
    return new Promise((resolve, reject) => {
        const ytdlp = findYtDlp();
        const tempDir = '/tmp';
        const outputTemplate = path.join(tempDir, `yt-${videoId}`);
        const expectedFile = `${outputTemplate}.en.json3`;

        console.log(`Trying yt-dlp method with: ${ytdlp}`);

        // Clean up any existing file first
        try {
            if (fs.existsSync(expectedFile)) {
                fs.unlinkSync(expectedFile);
            }
        } catch (e) {
            // Ignore cleanup errors
        }

        const args = [
            '--skip-download',
            '--write-auto-sub',
            '--sub-lang', 'en',
            '--sub-format', 'json3',
            '-o', outputTemplate,
        ];

        // Use cookies file if available (required for Hetzner/datacenter IPs to bypass bot detection)
        const cookiesFile = process.env.YOUTUBE_COOKIES_FILE || path.join(__dirname, 'youtube-cookies.txt');
        if (fs.existsSync(cookiesFile)) {
            args.push('--cookies', cookiesFile);
            console.log(`Using cookies file: ${cookiesFile}`);
        }

        args.push(`https://www.youtube.com/watch?v=${videoId}`);

        execFile(ytdlp, args, { timeout: 30000 }, (error, stdout, stderr) => {
            if (error) {
                console.log('yt-dlp error:', error.message);
                console.log('yt-dlp stderr:', stderr);
                reject(new Error(`yt-dlp failed: ${error.message}`));
                return;
            }

            // Check for the output file
            if (!fs.existsSync(expectedFile)) {
                // Try without language code
                const altFile = `${outputTemplate}.json3`;
                if (fs.existsSync(altFile)) {
                    try {
                        const data = fs.readFileSync(altFile, 'utf8');
                        const transcript = parseJson3Transcript(data);
                        fs.unlinkSync(altFile);
                        resolve(transcript);
                        return;
                    } catch (e) {
                        reject(new Error('Failed to parse subtitle file'));
                        return;
                    }
                }
                reject(new Error('No subtitle file generated'));
                return;
            }

            try {
                const data = fs.readFileSync(expectedFile, 'utf8');
                const transcript = parseJson3Transcript(data);

                // Clean up temp file
                fs.unlinkSync(expectedFile);

                if (transcript.length > 0) {
                    console.log(`✅ yt-dlp got ${transcript.length} segments`);
                    resolve(transcript);
                } else {
                    reject(new Error('No transcript segments parsed from yt-dlp output'));
                }
            } catch (e) {
                reject(new Error(`Failed to parse yt-dlp output: ${e.message}`));
            }
        });
    });
}

// Parse json3 format from yt-dlp
function parseJson3Transcript(data) {
    try {
        const json = JSON.parse(data);
        const transcript = [];

        if (json.events) {
            for (const event of json.events) {
                if (event.segs && event.segs.length > 0) {
                    const text = event.segs.map(s => s.utf8 || '').join('').trim();
                    if (text && text !== '\n' && !text.match(/^\[.*\]$/)) {  // Skip [Music], [Applause] etc.
                        transcript.push({
                            start: (event.tStartMs || 0) / 1000,
                            duration: (event.dDurationMs || 2000) / 1000,
                            text: decodeHtml(text.replace(/\n/g, ' ').trim())
                        });
                    }
                }
            }
        }

        return transcript;
    } catch (e) {
        console.log('JSON3 parse error:', e.message);
        return [];
    }
}

// Extract transcript using innertube API
async function getTranscriptInnertube(videoId) {
    console.log('Trying innertube API method...');

    // First, get the page to extract necessary tokens and cookies.
    // Use a 8s timeout and no retries so Hetzner IP blocks fail fast.
    const pageUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const pageResponse = await fetchUrlWithRetry(pageUrl, { timeout: 8000 }, 0);

    if (pageResponse.status !== 200) {
        throw new Error(`Failed to fetch YouTube page: ${pageResponse.status}`);
    }

    const html = pageResponse.data;

    // Extract cookies from response for subsequent requests
    const cookies = pageResponse.headers['set-cookie'];
    const cookieString = cookies ? (Array.isArray(cookies) ? cookies.map(c => c.split(';')[0]).join('; ') : cookies.split(';')[0]) : '';
    console.log('Got cookies:', cookieString ? 'yes' : 'no');

    // Check if video exists
    if (html.includes('"playabilityStatus":{"status":"ERROR"')) {
        throw new Error('Video not found or unavailable');
    }

    // Try to extract caption tracks directly from the page
    const captionTracksMatch = html.match(/"captionTracks":\s*(\[.*?\])\s*,\s*"/s);

    if (captionTracksMatch) {
        try {
            let tracksJson = captionTracksMatch[1];
            // Fix escaped characters
            tracksJson = tracksJson.replace(/\\u0026/g, '&').replace(/\\"/g, '"');

            const tracks = JSON.parse(tracksJson);
            console.log(`Found ${tracks.length} caption tracks`);

            if (tracks.length > 0) {
                // Find English track or use first available
                const track = tracks.find(t =>
                    t.languageCode === 'en' ||
                    t.languageCode?.startsWith('en')
                ) || tracks[0];

                console.log(`Using track: ${track.languageCode} - ${track.name?.simpleText || 'unnamed'}`);

                let captionUrl = track.baseUrl;
                captionUrl = captionUrl.replace(/\\u0026/g, '&');

                // Try fetching with cookies and different format parameters
                const formats = ['', '&fmt=json3', '&fmt=srv3'];

                for (const fmt of formats) {
                    const url = captionUrl + fmt;
                    console.log(`Trying URL with fmt='${fmt || 'default'}': ${url.substring(0, 80)}...`);

                    const captionResponse = await fetchUrl(url, {
                        headers: {
                            'Cookie': cookieString,
                            'Referer': pageUrl,
                        }
                    });
                    console.log(`Response: ${captionResponse.status}, length: ${captionResponse.data.length}`);

                    if (captionResponse.status === 200 && captionResponse.data.length > 100) {
                        const transcript = parseTranscriptData(captionResponse.data);
                        if (transcript.length > 0) {
                            return transcript;
                        }
                    }
                }
            }
        } catch (e) {
            console.log('Caption tracks parsing error:', e.message);
        }
    }

    // Alternative: Try YouTube's internal transcript endpoint via POST
    console.log('Trying innertube transcript endpoint...');

    // Extract API key from page
    const apiKeyMatch = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
    const apiKey = apiKeyMatch ? apiKeyMatch[1] : 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

    // Extract client version
    const clientVersionMatch = html.match(/"clientVersion":"([^"]+)"/);
    const clientVersion = clientVersionMatch ? clientVersionMatch[1] : '2.20240101.00.00';

    // Get serialized share entity for transcript params
    const engagementPanelMatch = html.match(/"engagementPanels".*?"serializedShareEntity":"([^"]+)"/s);

    // Try to get transcript via the get_transcript endpoint
    const transcriptPayload = {
        context: {
            client: {
                clientName: 'WEB',
                clientVersion: clientVersion,
            }
        },
        params: Buffer.from(`\n\x0b${videoId}`).toString('base64')
    };

    try {
        const transcriptResponse = await fetchUrl(
            `https://www.youtube.com/youtubei/v1/get_transcript?key=${apiKey}`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Cookie': cookieString,
                    'Origin': 'https://www.youtube.com',
                    'Referer': pageUrl,
                },
                body: JSON.stringify(transcriptPayload)
            }
        );

        console.log(`Innertube transcript response: ${transcriptResponse.status}, length: ${transcriptResponse.data.length}`);

        if (transcriptResponse.status === 200 && transcriptResponse.data.length > 100) {
            try {
                const data = JSON.parse(transcriptResponse.data);
                const transcriptParts = data?.actions?.[0]?.updateEngagementPanelAction?.content
                    ?.transcriptRenderer?.content?.transcriptSearchPanelRenderer?.body
                    ?.transcriptSegmentListRenderer?.initialSegments;

                if (transcriptParts && transcriptParts.length > 0) {
                    const transcript = transcriptParts.map(part => {
                        const seg = part.transcriptSegmentRenderer;
                        return {
                            start: parseInt(seg.startMs) / 1000,
                            duration: (parseInt(seg.endMs) - parseInt(seg.startMs)) / 1000,
                            text: seg.snippet?.runs?.map(r => r.text).join('') || ''
                        };
                    }).filter(t => t.text);

                    if (transcript.length > 0) {
                        console.log(`Got ${transcript.length} segments from innertube endpoint`);
                        return transcript;
                    }
                }
            } catch (e) {
                console.log('Innertube response parse error:', e.message);
            }
        }
    } catch (e) {
        console.log('Innertube transcript endpoint error:', e.message);
    }

    throw new Error('No captions found. The video may not have subtitles enabled.');
}

// Parse transcript data (handles multiple formats)
function parseTranscriptData(data) {
    const transcript = [];

    // Skip if empty
    if (!data || data.length < 50) {
        console.log('Data too short:', data.length);
        return [];
    }

    console.log('Data starts with:', data.substring(0, 100));

    // Try JSON format (json3)
    if (data.trim().startsWith('{')) {
        try {
            const json = JSON.parse(data);
            if (json.events) {
                for (const event of json.events) {
                    if (event.segs) {
                        const text = event.segs.map(s => s.utf8 || '').join('');
                        if (text.trim() && text !== '\n') {
                            transcript.push({
                                start: (event.tStartMs || 0) / 1000,
                                duration: (event.dDurationMs || 2000) / 1000,
                                text: decodeHtml(text)
                            });
                        }
                    }
                }
                console.log(`Parsed ${transcript.length} segments from JSON`);
                return transcript;
            }
        } catch (e) {
            console.log('JSON parse failed:', e.message);
        }
    }

    // Try XML srv3 format: <p t="123" d="456">text</p>
    const srv3Regex = /<p\s+t="(\d+)"(?:\s+d="(\d+)")?[^>]*>([\s\S]*?)<\/p>/gi;
    let match;
    while ((match = srv3Regex.exec(data)) !== null) {
        const text = match[3].replace(/<[^>]+>/g, '').trim();
        if (text) {
            transcript.push({
                start: parseInt(match[1]) / 1000,
                duration: match[2] ? parseInt(match[2]) / 1000 : 2,
                text: decodeHtml(text)
            });
        }
    }

    if (transcript.length > 0) {
        console.log(`Parsed ${transcript.length} segments from srv3 XML`);
        return transcript;
    }

    // Try standard XML format: <text start="1.23" dur="4.56">text</text>
    const xmlRegex = /<text\s+start="([^"]+)"(?:\s+dur="([^"]+)")?[^>]*>([\s\S]*?)<\/text>/gi;
    while ((match = xmlRegex.exec(data)) !== null) {
        const text = match[3].replace(/<[^>]+>/g, '').trim();
        if (text) {
            transcript.push({
                start: parseFloat(match[1]),
                duration: match[2] ? parseFloat(match[2]) : 2,
                text: decodeHtml(text)
            });
        }
    }

    if (transcript.length > 0) {
        console.log(`Parsed ${transcript.length} segments from standard XML`);
        return transcript;
    }

    console.log('Could not parse data. Sample:', data.substring(0, 500));
    return [];
}

// Gemini API method - uses Gemini to extract transcript from YouTube video
// Completely bypasses YouTube scraping, works regardless of IP rate limits
// Tries multiple models in order — older models get deprecated, billing caps vary
const GEMINI_TRANSCRIPT_MODELS = ['gemini-2.5-flash', 'gemini-1.5-flash'];

async function getTranscriptViaGemini(videoId) {
    if (!GEMINI_API_KEY) return null;
    console.log('Trying Gemini API transcript extraction...');

    const payload = JSON.stringify({
        contents: [{
            parts: [
                {
                    text: 'Extract the complete transcript from this YouTube video. Break it into segments of roughly 5-10 seconds each with accurate start timestamps. Return ONLY a raw JSON array (no markdown, no code fences) with objects: {"start": <seconds as number>, "duration": <seconds as number>, "text": "<spoken text>"}.'
                },
                {
                    fileData: {
                        mimeType: 'video/youtube',
                        fileUri: `https://www.youtube.com/watch?v=${videoId}`
                    }
                }
            ]
        }]
    });

    let lastError = null;

    for (const model of GEMINI_TRANSCRIPT_MODELS) {
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
        console.log(`📡 Calling Gemini API (${model}) for video ${videoId} (payload: ${payload.length} bytes)...`);

        try {
            const response = await fetchUrl(apiUrl, {
                method: 'POST',
                forceIPv4: true,  // API key is IP-restricted to IPv4 address
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    // Override fetchUrl defaults — don't send YouTube cookies to Gemini
                    'Cookie': '',
                    'User-Agent': 'ClipMark/1.0'
                },
                body: payload,
                timeout: 300000  // Up to 5 min for long videos
            });

            if (response.status === 404) {
                console.log(`⚠️ Model ${model} not found, trying next...`);
                continue;
            }

            if (response.status === 429) {
                // Billing cap or rate limit — parse the actual message
                let errMsg = 'Rate limited';
                try {
                    const errData = JSON.parse(response.data);
                    errMsg = errData?.error?.message || errMsg;
                } catch (_) {}
                console.log(`⚠️ Gemini ${model} returned 429: ${errMsg}`);
                throw new Error(`Gemini billing/rate limit: ${errMsg}`);
            }

            if (response.status !== 200) {
                let errDetail = response.data?.substring(0, 300) || '';
                try {
                    const errData = JSON.parse(response.data);
                    errDetail = errData?.error?.message || errDetail;
                } catch (_) {}
                console.log(`Gemini ${model} returned ${response.status}: ${errDetail}`);
                lastError = new Error(`Gemini API HTTP ${response.status}: ${errDetail}`);
                continue;
            }

            const data = JSON.parse(response.data);

            if (data?.candidates?.[0]?.finishReason === 'SAFETY') {
                console.log('⚠️ Gemini blocked response for safety reasons');
                throw new Error('Gemini blocked response (safety filter)');
            }
            if (!data?.candidates?.length) {
                console.log('⚠️ Gemini returned no candidates:', JSON.stringify(data).substring(0, 300));
                lastError = new Error('Gemini returned no candidates');
                continue;
            }

            let text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

            trackSystemApiUsage('/transcript (gemini)', data.usageMetadata);

            // Strip markdown code fences if present
            text = text.replace(/^```json\s*/i, '').replace(/\s*```\s*$/i, '').trim();

            try {
                const segments = JSON.parse(text);
                if (Array.isArray(segments) && segments.length > 0) {
                    const transcript = segments.map(s => ({
                        start: parseFloat(s.start) || 0,
                        duration: parseFloat(s.duration) || 5,
                        text: String(s.text || '').trim()
                    })).filter(t => t.text);

                    if (transcript.length > 0) {
                        console.log(`✅ Got ${transcript.length} segments via Gemini API (${model})`);
                        return transcript;
                    }
                }
            } catch (e) {
                console.log(`Gemini ${model} response parse error: ${e.message}`);
                console.log('Raw text:', text.substring(0, 200));
            }

            lastError = new Error(`Gemini ${model} returned unparseable response`);
        } catch (e) {
            // 429 billing/rate limit errors are terminal — don't try other models
            if (e.message.includes('billing') || e.message.includes('spending cap')) {
                throw e;
            }
            lastError = e;
        }
    }

    if (lastError) throw lastError;
    return null;
}

// Direct timedtext API method - doesn't require page scraping
// Uses short 5s timeout so blocked Hetzner IPs fail fast rather than hanging.
async function getTranscriptTimedText(videoId) {
    console.log('Trying direct timedtext API...');
    // Try the most common auto-caption lang first, then manual English variants.
    // Limit to no-retry (maxRetries=0) and short timeout to fail fast if blocked.
    const langs = ['a.en', 'en', 'en-US', 'en-GB'];

    for (const lang of langs) {
        for (const fmt of ['json3', 'srv3', '']) {
            const fmtParam = fmt ? `&fmt=${fmt}` : '';
            const url = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}${fmtParam}`;

            try {
                const response = await fetchUrlWithRetry(url, { timeout: 5000 }, 0);
                if (response.status === 200 && response.data.length > 50) {
                    const transcript = parseTranscriptData(response.data);
                    if (transcript.length > 0) {
                        console.log(`Got ${transcript.length} segments via timedtext API (lang=${lang}, fmt=${fmt || 'default'})`);
                        return transcript;
                    }
                }
                // If we get a hard block (403/429), stop trying immediately
                if (response.status === 403 || response.status === 429) {
                    console.log(`Timedtext blocked (${response.status}) — aborting fast path`);
                    return null;
                }
            } catch (e) {
                // Timeout or network error — if it's a timeout on the first try, bail out early
                if (e.message.includes('timeout')) {
                    console.log(`Timedtext timeout — aborting fast path`);
                    return null;
                }
                // Otherwise continue to next lang/fmt combo
            }
        }
    }
    return null;
}

// Main transcript function
// Track in-progress Gemini background jobs
const pendingGeminiJobs = new Map();
// Track failed Gemini jobs to prevent infinite retry loops
// Map<videoId, { timestamp, attempts, lastError }>
const failedGeminiJobs = new Map();
const MAX_GEMINI_RETRIES = 2;
const FAILED_JOB_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes before allowing retry

async function getTranscript(videoId) {
    // Validate video ID
    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
        throw new Error('Invalid video ID format');
    }

    // Check cache first
    const cached = getCachedTranscript(videoId);
    if (cached) {
        return cached;
    }

    // Check if this video recently failed — avoid infinite retry loop
    const failedJob = failedGeminiJobs.get(videoId);
    if (failedJob) {
        const elapsed = Date.now() - failedJob.timestamp;
        if (elapsed < FAILED_JOB_COOLDOWN_MS && failedJob.attempts >= MAX_GEMINI_RETRIES) {
            const minutesLeft = Math.ceil((FAILED_JOB_COOLDOWN_MS - elapsed) / 60000);
            throw new Error(`No captions available. AI transcription failed after ${failedJob.attempts} attempts (${failedJob.lastError}). Retry available in ${minutesLeft} min.`);
        }
        if (elapsed >= FAILED_JOB_COOLDOWN_MS) {
            failedGeminiJobs.delete(videoId); // Allow retry after cooldown
        }
    }

    // Method 1: Try YouTube's timedtext API first — fast (< 2s) when it works.
    // Uses a short 5s timeout so Hetzner IP blocks fail quickly without delaying the user.
    try {
        console.log(`Attempting fast timedtext API for ${videoId}...`);
        const transcript = await getTranscriptTimedText(videoId);
        if (transcript && transcript.length > 0) {
            console.log(`✅ Got ${transcript.length} segments via timedtext (fast path)`);
            cacheTranscript(videoId, transcript);
            return transcript;
        }
    } catch (e) {
        console.log(`Timedtext fast path failed: ${e.message} — falling back to Gemini`);
    }

    // Method 2: yt-dlp subtitle download — works from any IP, handles YouTube auth.
    // Uses the local yt-dlp binary to download auto-generated subtitles as json3.
    try {
        console.log(`Attempting yt-dlp method for ${videoId}...`);
        const transcript = await getTranscriptYtDlp(videoId);
        if (transcript && transcript.length > 0) {
            console.log(`✅ Got ${transcript.length} segments via yt-dlp`);
            cacheTranscript(videoId, transcript);
            return transcript;
        }
    } catch (e) {
        console.log(`yt-dlp method failed: ${e.message} — falling back to innertube`);
    }

    // Method 3: Innertube caption extraction — parses caption track URLs from the page.
    // Also falls back to Gemini on failure since datacenter IPs may be blocked.
    try {
        console.log(`Attempting innertube method for ${videoId}...`);
        const transcript = await getTranscriptInnertube(videoId);
        if (transcript && transcript.length > 0) {
            console.log(`✅ Got ${transcript.length} segments via innertube (fast path)`);
            cacheTranscript(videoId, transcript);
            return transcript;
        }
    } catch (e) {
        console.log(`Innertube method failed: ${e.message} — falling back to Gemini`);
    }

    // Method 4: Gemini API — reliable from any IP, but slow (30-60s for background job).
    // Start as background job to avoid Cloudflare 100s timeout on long videos.
    if (GEMINI_API_KEY && !pendingGeminiJobs.has(videoId)) {
        const attemptNum = (failedJob?.attempts || 0) + 1;
        console.log(`Starting background Gemini transcript job for ${videoId} (attempt ${attemptNum})...`);
        const job = getTranscriptViaGemini(videoId)
            .then(transcript => {
                if (transcript && transcript.length > 0) {
                    cacheTranscript(videoId, transcript);
                    failedGeminiJobs.delete(videoId); // Clear failure record on success
                    console.log(`✅ Background Gemini job completed for ${videoId}: ${transcript.length} segments`);
                } else {
                    const errMsg = 'Gemini returned no transcript segments';
                    console.log(`⚠️ Background Gemini job returned no segments for ${videoId}`);
                    failedGeminiJobs.set(videoId, {
                        timestamp: Date.now(),
                        attempts: attemptNum,
                        lastError: errMsg
                    });
                }
            })
            .catch(e => {
                console.log(`❌ Background Gemini job failed for ${videoId}: ${e.message}`);
                failedGeminiJobs.set(videoId, {
                    timestamp: Date.now(),
                    attempts: attemptNum,
                    lastError: e.message.substring(0, 100)
                });
            })
            .finally(() => {
                pendingGeminiJobs.delete(videoId);
            });
        pendingGeminiJobs.set(videoId, job);

        throw new Error('Transcript is being generated. Please try again in 30-60 seconds.');
    } else if (pendingGeminiJobs.has(videoId)) {
        throw new Error('Transcript is still being generated. Please try again in a few seconds.');
    }

    throw new Error('All transcript methods failed. The video may not have captions available.');
}

// Clean expired sessions and shares on startup
ensureDataDirs();
cleanExpiredSessions();
cleanExpiredShares();

// Clean sessions and shares periodically (every hour)
setInterval(cleanExpiredSessions, 60 * 60 * 1000);
setInterval(cleanExpiredShares, 60 * 60 * 1000);

// Create the server
const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const url = new URL(req.url, `http://localhost:${PORT}`);

    // =============================================
    // AUTHENTICATION ENDPOINTS
    // =============================================

    // Register new user
    if (url.pathname === '/auth/register' && req.method === 'POST') {
        try {
            const body = await parseBody(req);
            const { username, password, email, firstName, lastName } = body || {};

            // Validate input
            if (!username || !password) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Username and password are required' }));
                return;
            }

            if (!isValidUsername(username)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Username must be 3-30 alphanumeric characters or underscores' }));
                return;
            }

            if (!isValidPassword(password)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Password must be at least 6 characters' }));
                return;
            }

            const users = readUsers();

            // Check if username already exists
            const existingUser = Object.values(users).find(
                u => u.username.toLowerCase() === username.toLowerCase()
            );
            if (existingUser) {
                res.writeHead(409, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Username already taken' }));
                return;
            }

            // Check if this is the first user (for legacy data migration)
            const firstUser = isFirstUser();

            // Hash password and create user
            const userId = uuidv4();
            const passwordHash = await bcrypt.hash(password, 10);

            users[userId] = {
                username,
                passwordHash,
                createdAt: Date.now(),
                profile: {
                    firstName: firstName || null,
                    lastName: lastName || null,
                    email: email || null,
                    interests: [],
                    updatedAt: Date.now()
                }
            };

            if (!writeUsers(users)) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to create user' }));
                return;
            }

            // Create user data directory
            ensureUserDataDir(userId);

            // Migrate legacy data for first user
            if (firstUser) {
                migrateLegacyData(userId);
            }

            // Set trial period
            const trialEndsAt = Date.now() + STRIPE_TRIAL_DAYS * 86400000;
            updateUserSubscription(userId, { trialEndsAt, trialUsed: false });

            // Create session
            const { token, expiresAt } = createSession(userId);

            console.log(`👤 Registered new user: ${username} (${userId})${firstUser ? ' [first user - legacy data migrated]' : ''}`);

            // Send signup notification email (async, don't block response)
            sendSignupNotification(username, userId);

            const sub = getUserSubscription(userId);
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                token,
                userId,
                username,
                expiresAt,
                subscription: sub
            }));
        } catch (e) {
            console.error('Registration error:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Registration failed' }));
        }
        return;
    }

    // Login
    if (url.pathname === '/auth/login' && req.method === 'POST') {
        try {
            const body = await parseBody(req);
            const { username, password } = body || {};

            if (!username || !password) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Username and password are required' }));
                return;
            }

            // Check rate limiting
            const ipIdentifier = getClientIdentifier(req);
            const userIdentifier = getClientIdentifier(req, username);

            const ipLimit = checkRateLimit(ipIdentifier);
            const userLimit = checkRateLimit(userIdentifier);

            if (!ipLimit.allowed) {
                res.writeHead(429, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: ipLimit.message }));
                return;
            }

            if (!userLimit.allowed) {
                res.writeHead(429, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: userLimit.message }));
                return;
            }

            const users = readUsers();

            // Find user by username (case-insensitive)
            const [userId, user] = Object.entries(users).find(
                ([, u]) => u.username.toLowerCase() === username.toLowerCase()
            ) || [];

            if (!user) {
                recordFailedLogin(ipIdentifier);
                recordFailedLogin(userIdentifier);
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid username or password' }));
                return;
            }

            // Check if user is suspended
            if (user.suspended) {
                console.log(`🚫 Suspended user attempted login: ${user.username}`);
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Account suspended. Please contact support.' }));
                return;
            }

            // Verify password
            const validPassword = await bcrypt.compare(password, user.passwordHash);
            if (!validPassword) {
                recordFailedLogin(ipIdentifier);
                recordFailedLogin(userIdentifier);
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid username or password' }));
                return;
            }

            // Clear failed login attempts on success
            clearFailedLogins(ipIdentifier);
            clearFailedLogins(userIdentifier);

            // Create session
            const { token, expiresAt } = createSession(userId);

            console.log(`🔑 User logged in: ${user.username} (${userId})`);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                token,
                userId,
                username: user.username,
                expiresAt
            }));
        } catch (e) {
            console.error('Login error:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Login failed' }));
        }
        return;
    }

    // Logout
    if (url.pathname === '/auth/logout' && req.method === 'POST') {
        const token = extractAuthToken(req);
        if (token) {
            deleteSession(token);
            console.log('🚪 User logged out');
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
    }

    // Check authentication status
    if (url.pathname === '/auth/check' && req.method === 'GET') {
        const token = extractAuthToken(req);
        const userId = validateSession(token);

        if (userId) {
            const users = readUsers();
            const user = users[userId];
            const sub = getUserSubscription(userId);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                valid: true,
                userId,
                username: user?.username || 'Unknown',
                isAdmin: isAdminUser(userId),
                subscription: sub
            }));
        } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ valid: false }));
        }
        return;
    }

    // =============================================
    // STRIPE / SUBSCRIPTION ENDPOINTS
    // =============================================

    // Get subscription status
    if (url.pathname === '/api/subscription' && req.method === 'GET') {
        const userId = authenticateRequest(req);
        if (!userId) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Authentication required' }));
            return;
        }
        const sub = getUserSubscription(userId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(sub));
        return;
    }

    // Create Stripe checkout session
    if (url.pathname === '/api/subscription/checkout' && req.method === 'POST') {
        const userId = authenticateRequest(req);
        if (!userId) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Authentication required' }));
            return;
        }
        if (!stripe) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Payments not configured' }));
            return;
        }

        try {
            const body = await parseBody(req);
            const plan = body?.plan === 'annual' ? 'annual' : 'monthly';
            const priceId = STRIPE_PRICES[plan];

            if (!priceId) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Price not configured. Please try again shortly.' }));
                return;
            }

            const users = readUsers();
            const user = users[userId];
            const sub = user?.subscription || {};
            const appUrl = process.env.APP_URL || `http://localhost:${PORT}`;

            // Reuse existing Stripe customer or create new one
            let customerId = sub.stripeCustomerId;
            if (!customerId) {
                const customer = await stripe.customers.create({
                    metadata: { userId, username: user.username },
                    email: user.profile?.email || undefined
                });
                customerId = customer.id;
                updateUserSubscription(userId, { stripeCustomerId: customerId });
            }

            // Create checkout session with trial
            const sessionParams = {
                customer: customerId,
                payment_method_types: ['card'],
                line_items: [{ price: priceId, quantity: 1 }],
                mode: 'subscription',
                success_url: `${appUrl}/app?checkout=success`,
                cancel_url: `${appUrl}/app?checkout=cancel`,
                metadata: { userId, plan },
                allow_promotion_codes: true,
            };

            // Only add trial if user hasn't had one before
            if (!sub.trialUsed) {
                sessionParams.subscription_data = {
                    trial_period_days: STRIPE_TRIAL_DAYS,
                    metadata: { userId, plan }
                };
            }

            const session = await stripe.checkout.sessions.create(sessionParams);

            console.log(`💳 Checkout session created for ${user.username} (${plan}): ${session.id}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ url: session.url, sessionId: session.id }));
        } catch (e) {
            console.error('Stripe checkout error:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to create checkout session' }));
        }
        return;
    }

    // Stripe customer portal (manage subscription)
    if (url.pathname === '/api/subscription/portal' && req.method === 'POST') {
        const userId = authenticateRequest(req);
        if (!userId) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Authentication required' }));
            return;
        }
        if (!stripe) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Payments not configured' }));
            return;
        }

        try {
            const sub = getUserSubscription(userId);
            if (!sub.stripeCustomerId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'No subscription found' }));
                return;
            }

            const appUrl = process.env.APP_URL || `http://localhost:${PORT}`;
            const session = await stripe.billingPortal.sessions.create({
                customer: sub.stripeCustomerId,
                return_url: `${appUrl}/app`
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ url: session.url }));
        } catch (e) {
            console.error('Stripe portal error:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to create portal session' }));
        }
        return;
    }

    // Stripe webhook
    if (url.pathname === '/api/stripe/webhook' && req.method === 'POST') {
        // Stripe webhooks send raw body — read it without JSON parsing
        let rawBody = '';
        req.on('data', chunk => rawBody += chunk);
        await new Promise(resolve => req.on('end', resolve));

        try {
            const event = JSON.parse(rawBody);
            console.log(`💳 Stripe webhook: ${event.type}`);

            switch (event.type) {
                case 'checkout.session.completed': {
                    const session = event.data.object;
                    const userId = session.metadata?.userId;
                    if (userId && session.subscription) {
                        const subscription = await stripe.subscriptions.retrieve(session.subscription);
                        updateUserSubscription(userId, {
                            stripeSubscriptionId: subscription.id,
                            stripeCustomerId: session.customer,
                            stripeStatus: subscription.status,
                            plan: subscription.items.data[0]?.price?.recurring?.interval === 'year' ? 'annual' : 'monthly',
                            currentPeriodEnd: subscription.current_period_end * 1000,
                            trialEndsAt: subscription.trial_end ? subscription.trial_end * 1000 : undefined,
                            trialUsed: true
                        });
                        console.log(`💳 Subscription activated for user ${userId}: ${subscription.status}`);
                    }
                    break;
                }

                case 'customer.subscription.updated': {
                    const subscription = event.data.object;
                    const userId = subscription.metadata?.userId;
                    if (userId) {
                        updateUserSubscription(userId, {
                            stripeStatus: subscription.status,
                            currentPeriodEnd: subscription.current_period_end * 1000,
                            plan: subscription.items.data[0]?.price?.recurring?.interval === 'year' ? 'annual' : 'monthly'
                        });
                        console.log(`💳 Subscription updated for user ${userId}: ${subscription.status}`);
                    }
                    break;
                }

                case 'customer.subscription.deleted': {
                    const subscription = event.data.object;
                    const userId = subscription.metadata?.userId;
                    if (userId) {
                        updateUserSubscription(userId, {
                            stripeStatus: 'canceled',
                            stripeSubscriptionId: null
                        });
                        console.log(`💳 Subscription canceled for user ${userId}`);
                    }
                    break;
                }

                case 'invoice.payment_failed': {
                    const invoice = event.data.object;
                    const customerId = invoice.customer;
                    // Find user by customer ID
                    const users = readUsers();
                    for (const [uid, user] of Object.entries(users)) {
                        if (user.subscription?.stripeCustomerId === customerId) {
                            updateUserSubscription(uid, { stripeStatus: 'past_due' });
                            console.log(`💳 Payment failed for user ${uid}`);
                            break;
                        }
                    }
                    break;
                }
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ received: true }));
        } catch (e) {
            console.error('Stripe webhook error:', e.message);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // Get Stripe publishable key (public endpoint)
    if (url.pathname === '/api/stripe/config' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            publishableKey: STRIPE_PUBLISHABLE_KEY || null,
            configured: !!stripe,
            trialDays: STRIPE_TRIAL_DAYS
        }));
        return;
    }

    // =============================================
    // PROFILE ENDPOINTS (require authentication)
    // =============================================

    // Get current user's profile
    if (url.pathname === '/api/profile' && req.method === 'GET') {
        const userId = authenticateRequest(req);

        if (!userId) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Authentication required' }));
            return;
        }

        try {
            const users = readUsers();
            const user = users[userId];

            if (!user) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'User not found' }));
                return;
            }

            // Return profile data (create empty profile if doesn't exist)
            const profile = user.profile || {
                firstName: null,
                lastName: null,
                email: null,
                interests: [],
                updatedAt: null
            };

            console.log(`👤 GET /api/profile for user ${user.username}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                username: user.username,
                createdAt: user.createdAt,
                profile
            }));
        } catch (e) {
            console.error('Error getting profile:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to get profile' }));
        }
        return;
    }

    // Update current user's profile
    if (url.pathname === '/api/profile' && req.method === 'PUT') {
        const userId = authenticateRequest(req);

        if (!userId) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Authentication required' }));
            return;
        }

        try {
            const body = await parseBody(req);
            const { firstName, lastName, email, interests } = body || {};

            // Validate email format if provided
            if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid email format' }));
                return;
            }

            // Validate interests is an array if provided
            if (interests !== undefined && !Array.isArray(interests)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Interests must be an array' }));
                return;
            }

            const users = readUsers();
            const user = users[userId];

            if (!user) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'User not found' }));
                return;
            }

            // Update profile fields
            user.profile = {
                firstName: firstName !== undefined ? firstName : (user.profile?.firstName || null),
                lastName: lastName !== undefined ? lastName : (user.profile?.lastName || null),
                email: email !== undefined ? email : (user.profile?.email || null),
                interests: interests !== undefined ? interests : (user.profile?.interests || []),
                updatedAt: Date.now()
            };

            if (!writeUsers(users)) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to save profile' }));
                return;
            }

            console.log(`👤 PUT /api/profile for user ${user.username}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                profile: user.profile
            }));
        } catch (e) {
            console.error('Error updating profile:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to update profile' }));
        }
        return;
    }

    // =============================================
    // SHARING ENDPOINTS (require authentication)
    // =============================================

    // Search users by username
    if (url.pathname === '/api/users/search' && req.method === 'GET') {
        const userId = authenticateRequest(req);

        if (!userId) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Authentication required' }));
            return;
        }

        const query = url.searchParams.get('q') || '';
        if (query.length < 2) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Query must be at least 2 characters' }));
            return;
        }

        try {
            const users = readUsers();
            const queryLower = query.toLowerCase();
            const results = [];

            for (const [uid, user] of Object.entries(users)) {
                // Don't include current user or suspended users
                if (uid === userId || user.suspended) continue;

                if (user.username.toLowerCase().includes(queryLower)) {
                    results.push({
                        userId: uid,
                        username: user.username
                    });
                }

                // Limit to 10 results
                if (results.length >= 10) break;
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(results));
        } catch (e) {
            console.error('Error searching users:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Search failed' }));
        }
        return;
    }

    // Create a new share
    if (url.pathname === '/api/shares' && req.method === 'POST') {
        const userId = authenticateRequest(req);

        if (!userId) {
            const token = extractAuthToken(req);
            console.log(`❌ Share creation failed - auth failed. Token present: ${!!token}, Token prefix: ${token ? token.substring(0, 8) + '...' : 'none'}`);
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Authentication required' }));
            return;
        }

        // Check rate limit
        const rateLimit = checkShareRateLimit(userId);
        if (!rateLimit.allowed) {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: `Rate limit exceeded. You can share up to ${MAX_SHARES_PER_HOUR} videos per hour. Try again in ${rateLimit.minutesRemaining} minutes.`
            }));
            return;
        }

        try {
            const body = await parseBody(req);
            const { type, targetUserId, targetEmail, videoId, youtubeVideoId, videoTitle, videoThumbnail, includeNotes, notes } = body || {};

            // Validate type
            if (type !== 'user' && type !== 'email') {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid share type' }));
                return;
            }

            // Validate target
            if (type === 'user' && !targetUserId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Target user ID required' }));
                return;
            }
            if (type === 'email' && (!targetEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(targetEmail))) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Valid email required' }));
                return;
            }

            // Can't share with yourself
            if (type === 'user' && targetUserId === userId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Cannot share with yourself' }));
                return;
            }

            // Validate video data
            if (!videoId || !youtubeVideoId || !videoTitle) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Video data required' }));
                return;
            }

            const users = readUsers();
            const ownerUser = users[userId];
            if (!ownerUser) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'User not found' }));
                return;
            }

            // For user shares, verify target exists
            if (type === 'user') {
                const targetUser = users[targetUserId];
                if (!targetUser) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Target user not found' }));
                    return;
                }
                if (targetUser.suspended) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Target user is suspended' }));
                    return;
                }
            }

            // Check for duplicate share
            const shares = readShares();
            const existingShare = Object.values(shares).find(s =>
                s.ownerId === userId &&
                s.youtubeVideoId === youtubeVideoId &&
                ((type === 'user' && s.targetUserId === targetUserId) ||
                 (type === 'email' && s.targetEmail === targetEmail)) &&
                s.status !== 'declined'
            );

            if (existingShare) {
                res.writeHead(409, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'You have already shared this video with this person' }));
                return;
            }

            // Create share
            const shareId = uuidv4();
            const share = {
                id: shareId,
                type,
                ownerId: userId,
                ownerUsername: ownerUser.username,
                videoId,
                youtubeVideoId,
                videoTitle,
                videoThumbnail: videoThumbnail || `https://img.youtube.com/vi/${youtubeVideoId}/mqdefault.jpg`,
                includeNotes: !!includeNotes,
                notes: includeNotes ? (notes || []) : null,
                targetUserId: type === 'user' ? targetUserId : null,
                targetEmail: type === 'email' ? targetEmail : null,
                status: 'pending',
                shareToken: type === 'email' ? generateShareToken() : null,
                tokenExpiresAt: type === 'email' ? Date.now() + SHARE_TOKEN_EXPIRY_MS : null,
                createdAt: Date.now(),
                acceptedAt: null
            };

            shares[shareId] = share;

            if (!writeShares(shares)) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to create share' }));
                return;
            }

            console.log(`📤 Share created: ${ownerUser.username} -> ${type === 'user' ? users[targetUserId].username : targetEmail} (${videoTitle})`);

            // If email share, send the invitation email
            if (type === 'email') {
                if (RESEND_API_KEY) {
                    console.log(`📧 Attempting to send share invitation to: ${targetEmail}`);
                    sendShareInvitationEmail(share, ownerUser.username).catch(e => {
                        console.error('Failed to send share invitation email:', e.message);
                    });
                } else {
                    console.log(`📧 Email share created but RESEND_API_KEY not configured - no email sent to: ${targetEmail}`);
                }
            }

            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, shareId, share }));
        } catch (e) {
            console.error('Error creating share:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to create share' }));
        }
        return;
    }

    // Get outgoing shares (shares I created)
    if (url.pathname === '/api/shares/outgoing' && req.method === 'GET') {
        const userId = authenticateRequest(req);

        if (!userId) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Authentication required' }));
            return;
        }

        try {
            const shares = readShares();
            const users = readUsers();
            const outgoing = Object.values(shares)
                .filter(s => s.ownerId === userId)
                .map(s => ({
                    ...s,
                    targetUsername: s.targetUserId ? users[s.targetUserId]?.username : null
                }))
                .sort((a, b) => b.createdAt - a.createdAt);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(outgoing));
        } catch (e) {
            console.error('Error getting outgoing shares:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to get shares' }));
        }
        return;
    }

    // Get incoming shares (pending shares for me)
    if (url.pathname === '/api/shares/incoming' && req.method === 'GET') {
        const userId = authenticateRequest(req);

        if (!userId) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Authentication required' }));
            return;
        }

        try {
            const shares = readShares();
            const incoming = Object.values(shares)
                .filter(s => s.targetUserId === userId && s.status === 'pending')
                .sort((a, b) => b.createdAt - a.createdAt);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(incoming));
        } catch (e) {
            console.error('Error getting incoming shares:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to get shares' }));
        }
        return;
    }

    // Get accepted shares (my shared-with-me library)
    if (url.pathname === '/api/shares/library' && req.method === 'GET') {
        const userId = authenticateRequest(req);

        if (!userId) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Authentication required' }));
            return;
        }

        try {
            const sharedWithMe = readUserSharedWithMe(userId);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(sharedWithMe));
        } catch (e) {
            console.error('Error getting shared library:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to get library' }));
        }
        return;
    }

    // Update notes on a shared video
    if (url.pathname === '/api/shares/library' && req.method === 'PUT') {
        const userId = authenticateRequest(req);

        if (!userId) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Authentication required' }));
            return;
        }

        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { shareId, notes } = JSON.parse(body);

                if (!shareId) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'shareId is required' }));
                    return;
                }

                const sharedWithMe = readUserSharedWithMe(userId);
                const index = sharedWithMe.findIndex(s => s.shareId === shareId);

                if (index === -1) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Shared video not found' }));
                    return;
                }

                // Update notes for the shared video
                sharedWithMe[index].notes = notes || [];
                writeUserSharedWithMe(userId, sharedWithMe);

                console.log(`✅ Updated notes for shared video ${shareId} for user ${userId}`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch (e) {
                console.error('Error updating shared video notes:', e.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to update notes' }));
            }
        });
        return;
    }

    // Accept a share
    const acceptMatch = url.pathname.match(/^\/api\/shares\/([^\/]+)\/accept$/);
    if (acceptMatch && req.method === 'POST') {
        const userId = authenticateRequest(req);

        if (!userId) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Authentication required' }));
            return;
        }

        const shareId = acceptMatch[1];

        try {
            const shares = readShares();
            const share = shares[shareId];

            if (!share) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Share not found' }));
                return;
            }

            if (share.targetUserId !== userId) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'This share is not for you' }));
                return;
            }

            if (share.status !== 'pending') {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Share is not pending' }));
                return;
            }

            // Update share status
            share.status = 'accepted';
            share.acceptedAt = Date.now();

            // Add to user's shared-with-me list
            const sharedWithMe = readUserSharedWithMe(userId);
            const newVideoId = uuidv4(); // New ID for the shared video in recipient's library

            sharedWithMe.push({
                shareId: share.id,
                fromUserId: share.ownerId,
                fromUsername: share.ownerUsername,
                videoId: newVideoId,
                youtubeVideoId: share.youtubeVideoId,
                videoTitle: share.videoTitle,
                videoThumbnail: share.videoThumbnail,
                includeNotes: share.includeNotes,
                notes: share.notes,
                sharedAt: share.createdAt,
                acceptedAt: share.acceptedAt
            });

            if (!writeShares(shares) || !writeUserSharedWithMe(userId, sharedWithMe)) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to accept share' }));
                return;
            }

            const users = readUsers();
            console.log(`✅ Share accepted: ${users[userId]?.username} accepted share from ${share.ownerUsername}`);

            // Send notification to sharer
            if (RESEND_API_KEY) {
                const sharerUser = users[share.ownerId];
                if (sharerUser?.profile?.email) {
                    sendShareAcceptedEmail(share, users[userId]?.username, sharerUser.profile.email).catch(e => {
                        console.error('Failed to send share accepted email:', e.message);
                    });
                }
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, share }));
        } catch (e) {
            console.error('Error accepting share:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to accept share' }));
        }
        return;
    }

    // Decline a share
    const declineMatch = url.pathname.match(/^\/api\/shares\/([^\/]+)\/decline$/);
    if (declineMatch && req.method === 'POST') {
        const userId = authenticateRequest(req);

        if (!userId) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Authentication required' }));
            return;
        }

        const shareId = declineMatch[1];

        try {
            const shares = readShares();
            const share = shares[shareId];

            if (!share) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Share not found' }));
                return;
            }

            if (share.targetUserId !== userId) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'This share is not for you' }));
                return;
            }

            if (share.status !== 'pending') {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Share is not pending' }));
                return;
            }

            // Update share status
            share.status = 'declined';

            if (!writeShares(shares)) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to decline share' }));
                return;
            }

            const users = readUsers();
            console.log(`❌ Share declined: ${users[userId]?.username} declined share from ${share.ownerUsername}`);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        } catch (e) {
            console.error('Error declining share:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to decline share' }));
        }
        return;
    }

    // Revoke a share (owner only)
    const revokeMatch = url.pathname.match(/^\/api\/shares\/([^\/]+)$/);
    if (revokeMatch && req.method === 'DELETE') {
        const userId = authenticateRequest(req);

        if (!userId) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Authentication required' }));
            return;
        }

        const shareId = revokeMatch[1];

        try {
            const shares = readShares();
            const share = shares[shareId];

            if (!share) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Share not found' }));
                return;
            }

            if (share.ownerId !== userId) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Only the owner can revoke this share' }));
                return;
            }

            delete shares[shareId];

            if (!writeShares(shares)) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to revoke share' }));
                return;
            }

            console.log(`🗑️ Share revoked by owner: ${share.videoTitle}`);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        } catch (e) {
            console.error('Error revoking share:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to revoke share' }));
        }
        return;
    }

    // =============================================
    // PUBLIC SHARE ENDPOINTS (no authentication required)
    // =============================================

    // Get share preview by token (for email shares to non-users)
    if (url.pathname === '/api/shares/preview' && req.method === 'GET') {
        const token = url.searchParams.get('token');

        if (!token) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Token required' }));
            return;
        }

        try {
            const shares = readShares();
            const share = Object.values(shares).find(s => s.shareToken === token);

            if (!share) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Share not found or has been revoked' }));
                return;
            }

            if (share.status !== 'pending') {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'This share has already been claimed' }));
                return;
            }

            if (share.tokenExpiresAt && share.tokenExpiresAt < Date.now()) {
                res.writeHead(410, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'This share link has expired' }));
                return;
            }

            // Return preview data (without sensitive info)
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                valid: true,
                ownerUsername: share.ownerUsername,
                videoTitle: share.videoTitle,
                videoThumbnail: share.videoThumbnail,
                youtubeVideoId: share.youtubeVideoId,
                includeNotes: share.includeNotes,
                noteCount: share.notes?.length || 0,
                createdAt: share.createdAt
            }));
        } catch (e) {
            console.error('Error getting share preview:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to get share preview' }));
        }
        return;
    }

    // Claim share by token (after signup/login)
    if (url.pathname === '/api/shares/claim' && req.method === 'POST') {
        const userId = authenticateRequest(req);

        if (!userId) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Authentication required. Please login or signup first.' }));
            return;
        }

        const token = url.searchParams.get('token');

        if (!token) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Token required' }));
            return;
        }

        try {
            const shares = readShares();
            const share = Object.values(shares).find(s => s.shareToken === token);

            if (!share) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Share not found or has been revoked' }));
                return;
            }

            if (share.ownerId === userId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'You cannot claim your own share' }));
                return;
            }

            if (share.status !== 'pending') {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'This share has already been claimed' }));
                return;
            }

            if (share.tokenExpiresAt && share.tokenExpiresAt < Date.now()) {
                res.writeHead(410, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'This share link has expired' }));
                return;
            }

            // Update share status
            share.status = 'accepted';
            share.acceptedAt = Date.now();
            share.targetUserId = userId; // Update target to claiming user

            // Add to user's shared-with-me list
            const sharedWithMe = readUserSharedWithMe(userId);
            const newVideoId = uuidv4();

            sharedWithMe.push({
                shareId: share.id,
                fromUserId: share.ownerId,
                fromUsername: share.ownerUsername,
                videoId: newVideoId,
                youtubeVideoId: share.youtubeVideoId,
                videoTitle: share.videoTitle,
                videoThumbnail: share.videoThumbnail,
                includeNotes: share.includeNotes,
                notes: share.notes,
                sharedAt: share.createdAt,
                acceptedAt: share.acceptedAt
            });

            if (!writeShares(shares) || !writeUserSharedWithMe(userId, sharedWithMe)) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to claim share' }));
                return;
            }

            const users = readUsers();
            console.log(`✅ Email share claimed: ${users[userId]?.username} claimed share from ${share.ownerUsername}`);

            // Send notification to sharer
            if (RESEND_API_KEY) {
                const sharerUser = users[share.ownerId];
                if (sharerUser?.profile?.email) {
                    sendShareAcceptedEmail(share, users[userId]?.username, sharerUser.profile.email).catch(e => {
                        console.error('Failed to send share accepted email:', e.message);
                    });
                }
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, share }));
        } catch (e) {
            console.error('Error claiming share:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to claim share' }));
        }
        return;
    }

    // =============================================
    // ADMIN ENDPOINTS (require admin authentication)
    // =============================================

    // Admin stats endpoint
    if (url.pathname === '/admin/stats' && req.method === 'GET') {
        const userId = authenticateRequest(req);

        if (!userId) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Authentication required' }));
            return;
        }

        if (!isAdminUser(userId)) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Admin access required' }));
            return;
        }

        try {
            const stats = getAdminStats();
            console.log(`📊 Admin ${userId} requested stats: ${stats.totalUsers} users`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(stats));
        } catch (e) {
            console.error('Error getting admin stats:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to get stats' }));
        }
        return;
    }

    // Watch time tracking endpoint
    if (url.pathname === '/admin/watch-time' && req.method === 'POST') {
        const userId = authenticateRequest(req);

        if (!userId) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Authentication required' }));
            return;
        }

        try {
            const body = await parseBody(req);
            const { videoId, duration } = body || {};

            if (!videoId || typeof duration !== 'number' || duration < 0) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid videoId or duration' }));
                return;
            }

            // Read current watch time
            const watchTime = readUserWatchTime(userId);

            // Add to existing time for this video
            watchTime[videoId] = (watchTime[videoId] || 0) + Math.round(duration);

            // Save watch time
            if (writeUserWatchTime(userId, watchTime)) {
                console.log(`⏱️ User ${userId} watched ${videoId} for ${duration}s (total: ${watchTime[videoId]}s)`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, totalTime: watchTime[videoId] }));
            } else {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to save watch time' }));
            }
        } catch (e) {
            console.error('Error saving watch time:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to save watch time' }));
        }
        return;
    }

    // Suspend/unsuspend user endpoint
    const suspendMatch = url.pathname.match(/^\/admin\/users\/([^\/]+)\/suspend$/);
    if (suspendMatch && req.method === 'POST') {
        const adminUserId = authenticateRequest(req);

        if (!adminUserId) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Authentication required' }));
            return;
        }

        if (!isAdminUser(adminUserId)) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Admin access required' }));
            return;
        }

        const targetUserId = suspendMatch[1];
        const users = readUsers();
        const targetUser = users[targetUserId];

        if (!targetUser) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'User not found' }));
            return;
        }

        // Prevent admin from suspending themselves
        if (targetUserId === adminUserId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Cannot suspend yourself' }));
            return;
        }

        try {
            const body = await parseBody(req);
            const suspend = body?.suspend ?? !targetUser.suspended;

            users[targetUserId].suspended = suspend;

            if (!writeUsers(users)) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to update user' }));
                return;
            }

            // If suspending, delete all their sessions
            if (suspend) {
                deleteUserSessions(targetUserId);
            }

            console.log(`${suspend ? '🔒' : '🔓'} Admin ${adminUserId} ${suspend ? 'suspended' : 'unsuspended'} user ${targetUser.username}`);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                userId: targetUserId,
                suspended: suspend
            }));
        } catch (e) {
            console.error('Error suspending user:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to suspend user' }));
        }
        return;
    }

    // Purge test users (usernames starting with "test")
    if (url.pathname === '/admin/purge-test-users' && req.method === 'POST') {
        const adminUserId = authenticateRequest(req);
        if (!adminUserId) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Auth required' })); return; }
        if (!isAdminUser(adminUserId)) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Admin required' })); return; }

        try {
            const users = readUsers();
            const purged = [];

            for (const [userId, user] of Object.entries(users)) {
                if (user.username.toLowerCase().startsWith('test')) {
                    // Cancel Stripe subscription if exists
                    if (stripe && user.subscription?.stripeSubscriptionId) {
                        try {
                            await stripe.subscriptions.cancel(user.subscription.stripeSubscriptionId);
                            console.log(`💳 Canceled Stripe subscription for test user ${user.username}`);
                        } catch (e) { console.log(`💳 Could not cancel subscription: ${e.message}`); }
                    }
                    // Delete Stripe customer if exists
                    if (stripe && user.subscription?.stripeCustomerId) {
                        try {
                            await stripe.customers.del(user.subscription.stripeCustomerId);
                            console.log(`💳 Deleted Stripe customer for test user ${user.username}`);
                        } catch (e) { console.log(`💳 Could not delete customer: ${e.message}`); }
                    }

                    // Delete sessions
                    deleteUserSessions(userId);

                    // Delete user data directory
                    const userDataDir = getUserDataDir(userId);
                    if (fs.existsSync(userDataDir)) {
                        fs.rmSync(userDataDir, { recursive: true, force: true });
                    }

                    purged.push({ userId, username: user.username });
                    delete users[userId];
                }
            }

            writeUsers(users);
            console.log(`🧹 Purged ${purged.length} test users: ${purged.map(u => u.username).join(', ')}`);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, purged }));
        } catch (e) {
            console.error('Purge error:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // Delete user endpoint
    const deleteMatch = url.pathname.match(/^\/admin\/users\/([^\/]+)$/);
    if (deleteMatch && req.method === 'DELETE') {
        const adminUserId = authenticateRequest(req);

        if (!adminUserId) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Authentication required' }));
            return;
        }

        if (!isAdminUser(adminUserId)) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Admin access required' }));
            return;
        }

        const targetUserId = deleteMatch[1];
        const users = readUsers();
        const targetUser = users[targetUserId];

        if (!targetUser) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'User not found' }));
            return;
        }

        // Prevent admin from deleting themselves
        if (targetUserId === adminUserId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Cannot delete yourself' }));
            return;
        }

        try {
            const username = targetUser.username;

            // Delete user sessions
            deleteUserSessions(targetUserId);

            // Delete user from users.json
            delete users[targetUserId];
            if (!writeUsers(users)) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to delete user' }));
                return;
            }

            // Delete user data directory
            const userDataDir = getUserDataDir(targetUserId);
            if (fs.existsSync(userDataDir)) {
                fs.rmSync(userDataDir, { recursive: true, force: true });
                console.log(`🗑️ Deleted user data directory: ${userDataDir}`);
            }

            console.log(`❌ Admin ${adminUserId} deleted user ${username} (${targetUserId})`);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                userId: targetUserId,
                username: username
            }));
        } catch (e) {
            console.error('Error deleting user:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to delete user' }));
        }
        return;
    }

    // =============================================
    // QUICK-ADD API (Chrome Extension / External)
    // =============================================

    if (url.pathname === '/api/clips/quick-add' && req.method === 'POST') {
        const userId = authenticateRequest(req);

        if (!userId) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Authentication required' }));
            return;
        }

        // Check rate limit
        const rateLimit = checkQuickAddRateLimit(userId);
        if (!rateLimit.allowed) {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: `Rate limit exceeded. You can quick-add up to ${MAX_QUICK_ADDS_PER_HOUR} clips per hour. Try again in ${rateLimit.waitMinutes} minutes.`
            }));
            return;
        }

        try {
            const body = await parseBody(req);
            const { url: videoUrl, note, timestamp, tags } = body || {};

            if (!videoUrl) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'URL is required' }));
                return;
            }

            // Parse URL into sourceType and sourceId
            const parsed = parseVideoUrl(videoUrl);
            if (!parsed) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unsupported video URL. Supported: YouTube, Vimeo, Loom, Wistia, Google Drive, X/Twitter, or direct video links (.mp4, .webm)' }));
                return;
            }

            const { sourceType, sourceId, sourceUrl } = parsed;

            // Check for duplicates
            const bookmarks = readUserBookmarks(userId);
            const isDuplicate = bookmarks.some(b => {
                if (sourceType === 'direct') {
                    return b.sourceType === 'direct' && b.sourceUrl === videoUrl;
                }
                return b.sourceType === sourceType && b.sourceId === sourceId;
            });

            if (isDuplicate) {
                res.writeHead(409, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'This video is already in your library' }));
                return;
            }

            // Fetch metadata
            const metadata = await fetchVideoMetadata(sourceType, sourceId, sourceUrl || videoUrl);

            // Build video bookmark object matching Video data structure
            const videoId = uuidv4();
            const now = new Date().toISOString();
            const video = {
                id: videoId,
                title: metadata.title || `Untitled ${sourceType} video`,
                sourceType: sourceType,
                sourceId: sourceId || null,
                sourceUrl: sourceType === 'direct' ? videoUrl : (sourceUrl || videoUrl),
                // Legacy YouTube field for backward compat
                videoId: sourceType === 'youtube' ? sourceId : null,
                category: '',
                tags: Array.isArray(tags) ? tags : [],
                notes: [],
                thumbnail: metadata.thumbnail || '',
                description: metadata.description || '',
                publishDate: metadata.publishDate || '',
                viewCount: 0,
                lastWatchedAt: null,
                addedAt: now
            };

            // Add note if provided
            if (note && typeof note === 'string' && note.trim()) {
                video.notes.push({
                    id: uuidv4(),
                    text: note.trim(),
                    timestamp: typeof timestamp === 'number' ? timestamp : 0,
                    createdAt: now,
                    autoGenerated: false,
                    aiGenerated: false,
                    favorite: false
                });
            }

            // Append to bookmarks and save
            bookmarks.push(video);
            if (!writeUserBookmarks(userId, bookmarks)) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to save bookmark' }));
                return;
            }

            // Record rate limit
            recordQuickAddAttempt(userId);

            console.log(`📌 Quick-add: ${sourceType} video "${video.title}" added by user ${userId}`);
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                video: {
                    id: videoId,
                    title: video.title,
                    sourceType: sourceType,
                    thumbnail: video.thumbnail
                }
            }));
        } catch (e) {
            console.error('Quick-add error:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to add video' }));
        }
        return;
    }

    // =============================================
    // API PROXY ENDPOINTS (server-side API keys)
    // =============================================

    // Check API key availability (no auth required, just returns status)
    if (url.pathname === '/api/status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            geminiConfigured: !!GEMINI_API_KEY,
            youtubeConfigured: !!YOUTUBE_API_KEY
        }));
        return;
    }

    // Gemini API proxy - requires authentication
    if (url.pathname === '/api/gemini' && req.method === 'POST') {
        const userId = authenticateRequest(req);

        if (!userId) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Authentication required' }));
            return;
        }

        if (!GEMINI_API_KEY) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Gemini API not configured on server' }));
            return;
        }

        try {
            const body = await parseBody(req);
            const { prompt, maxTokens = 2048, temperature = 0.3, model = 'gemini-2.5-flash' } = body || {};

            if (!prompt) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Prompt is required' }));
                return;
            }

            // Call Gemini API
            const geminiResponse = await fetchUrl(
                `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
                {
                    method: 'POST',
                    forceIPv4: true,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }],
                        generationConfig: { temperature, maxOutputTokens: maxTokens }
                    })
                }
            );

            if (geminiResponse.status !== 200) {
                console.error('Gemini API error:', geminiResponse.data);
                let errorMessage = `Gemini API error (${geminiResponse.status})`;
                try {
                    const errParsed = JSON.parse(geminiResponse.data);
                    if (errParsed.error?.message) errorMessage = errParsed.error.message;
                    else if (typeof errParsed.error === 'string') errorMessage = errParsed.error;
                } catch (_) {}
                res.writeHead(geminiResponse.status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: errorMessage }));
                return;
            }

            const geminiData = JSON.parse(geminiResponse.data);
            const responseText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';

            // Track API usage
            trackApiUsage(userId, '/api/gemini', geminiData.usageMetadata);

            console.log(`🤖 Gemini API called by user ${userId}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ text: responseText }));
        } catch (e) {
            console.error('Gemini proxy error:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Gemini API request failed' }));
        }
        return;
    }

    // YouTube API proxy - requires authentication
    if (url.pathname === '/api/youtube/video' && req.method === 'GET') {
        const userId = authenticateRequest(req);

        if (!userId) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Authentication required' }));
            return;
        }

        if (!YOUTUBE_API_KEY) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'YouTube API not configured on server' }));
            return;
        }

        const videoId = url.searchParams.get('id');
        if (!videoId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Video ID is required' }));
            return;
        }

        try {
            const youtubeResponse = await fetchUrl(
                `https://www.googleapis.com/youtube/v3/videos?id=${videoId}&part=snippet&key=${YOUTUBE_API_KEY}`
            );

            if (youtubeResponse.status !== 200) {
                console.error('YouTube API error:', youtubeResponse.data);
                res.writeHead(youtubeResponse.status, { 'Content-Type': 'application/json' });
                res.end(youtubeResponse.data);
                return;
            }

            const youtubeData = JSON.parse(youtubeResponse.data);
            const video = youtubeData.items?.[0];

            if (!video) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Video not found' }));
                return;
            }

            console.log(`📺 YouTube API called for ${videoId} by user ${userId}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                id: video.id,
                title: video.snippet?.title,
                description: video.snippet?.description,
                publishedAt: video.snippet?.publishedAt,
                channelTitle: video.snippet?.channelTitle,
                thumbnails: video.snippet?.thumbnails
            }));
        } catch (e) {
            console.error('YouTube proxy error:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'YouTube API request failed' }));
        }
        return;
    }

    // =============================================
    // TRANSCRIPT ENDPOINTS
    // =============================================

    // Upload transcript file (SRT/VTT) - requires authentication
    if (url.pathname === '/api/transcript/upload' && req.method === 'POST') {
        const userId = authenticateRequest(req);

        if (!userId) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Authentication required' }));
            return;
        }

        try {
            const body = await parseBody(req);
            const { content, filename, videoId } = body || {};

            if (!content) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Transcript content is required' }));
                return;
            }

            if (!filename && !content.trim().startsWith('WEBVTT')) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Filename is required to determine format (or content must start with WEBVTT)' }));
                return;
            }

            // Parse the subtitle file
            const result = parseSubtitleFile(content, filename || 'subtitle.vtt');

            if (!result.segments || result.segments.length === 0) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Could not parse any transcript segments from file' }));
                return;
            }

            console.log(`📝 Parsed ${result.segments.length} segments from ${result.source.toUpperCase()} file for user ${userId}`);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                transcript: {
                    segments: result.segments,
                    source: result.source
                },
                segmentCount: result.segments.length
            }));
        } catch (e) {
            console.error('Transcript upload error:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to parse transcript file' }));
        }
        return;
    }

    // Generate AI transcription - requires authentication and Gemini API
    if (url.pathname === '/api/transcript/generate' && req.method === 'POST') {
        const userId = authenticateRequest(req);

        if (!userId) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Authentication required' }));
            return;
        }

        if (!GEMINI_API_KEY) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Gemini API not configured on server' }));
            return;
        }

        // Check rate limit
        const rateLimit = checkTranscriptionRateLimit(userId);
        if (!rateLimit.allowed) {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: `Rate limit exceeded. You can generate ${MAX_TRANSCRIPTIONS_PER_HOUR} transcriptions per hour.`,
                waitMinutes: rateLimit.waitMinutes
            }));
            return;
        }

        try {
            const body = await parseBody(req);
            const { videoUrl, videoTitle, sourceType } = body || {};

            if (!videoUrl) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Video URL is required' }));
                return;
            }

            // Note: For non-YouTube sources, we can't actually transcribe the audio
            // Gemini would need the actual audio/video file to transcribe
            // This is a placeholder that creates a basic timestamp guide based on video duration
            // In a real implementation, you would need to:
            // 1. Download the video
            // 2. Extract audio
            // 3. Send to a speech-to-text service

            // For now, we return a helpful message
            const prompt = `You are helping create a transcript placeholder for a video.
The video is titled: "${videoTitle || 'Untitled Video'}"
Video source type: ${sourceType || 'unknown'}
Video URL: ${videoUrl}

Since we cannot directly access the video content, please generate a helpful response explaining that:
1. Automatic transcription for non-YouTube videos requires the actual video file
2. The user can upload an SRT or VTT file manually
3. If this is a Loom or Wistia video, the platform might provide their own transcript

Format your response as JSON with a "message" field explaining this, and include a "canTranscribe" boolean set to false.`;

            // Call Gemini API
            const geminiResponse = await fetchUrl(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
                {
                    method: 'POST',
                    forceIPv4: true,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }],
                        generationConfig: { temperature: 0.3, maxOutputTokens: 1024 }
                    })
                }
            );

            // Record the attempt
            recordTranscriptionAttempt(userId);

            if (geminiResponse.status !== 200) {
                console.error('Gemini API error:', geminiResponse.data);
                res.writeHead(geminiResponse.status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'AI transcription service error' }));
                return;
            }

            const geminiData = JSON.parse(geminiResponse.data);
            const responseText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';

            // Track API usage
            trackApiUsage(userId, '/api/transcript/generate', geminiData.usageMetadata);

            // Try to parse as JSON, otherwise return raw message
            let responseObj;
            try {
                // Extract JSON from potential markdown code block
                let jsonStr = responseText;
                const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
                if (jsonMatch) {
                    jsonStr = jsonMatch[1];
                }
                responseObj = JSON.parse(jsonStr.trim());
            } catch (e) {
                responseObj = {
                    canTranscribe: false,
                    message: 'Automatic transcription is not available for this video type. Please upload an SRT or VTT file manually.'
                };
            }

            console.log(`🎙️ AI transcription request for ${sourceType} video by user ${userId} (${rateLimit.remaining - 1} remaining)`);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                ...responseObj,
                rateLimit: {
                    remaining: rateLimit.remaining - 1,
                    limit: MAX_TRANSCRIPTIONS_PER_HOUR
                }
            }));
        } catch (e) {
            console.error('AI transcription error:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'AI transcription request failed' }));
        }
        return;
    }

    // Diagnostic: bookmark count per user (no sensitive data)
    if (url.pathname === '/api/debug/bookmark-counts') {
        const users = readUsers();
        const counts = {};
        for (const [userId, user] of Object.entries(users)) {
            const bookmarks = readUserBookmarks(userId);
            counts[user.username] = { userId: userId.substring(0, 8), count: bookmarks.length };
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(counts));
        return;
    }

    // =============================================
    // PROTECTED ENDPOINTS (require authentication)
    // =============================================

    // Bookmarks API - requires authentication
    if (url.pathname === '/bookmarks') {
        const userId = authenticateRequest(req);

        if (!userId) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Authentication required' }));
            return;
        }

        if (req.method === 'GET') {
            const bookmarks = readUserBookmarks(userId);
            console.log(`📚 GET /bookmarks - returning ${bookmarks.length} bookmarks for user ${userId}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(bookmarks));
            return;
        }

        if (req.method === 'POST') {
            try {
                const incoming = await parseBody(req);
                if (Array.isArray(incoming)) {
                    const existing = readUserBookmarks(userId);
                    console.log(`📚 POST /bookmarks - merging ${incoming.length} incoming with ${existing.length} existing for user ${userId}`);

                    // MERGE STRATEGY: never lose data
                    // 1. Build a map of existing videos by ID
                    const existingMap = new Map();
                    for (const video of existing) {
                        if (video.id) existingMap.set(video.id, video);
                    }

                    // 2. Build a map of incoming videos by ID
                    const incomingMap = new Map();
                    for (const video of incoming) {
                        if (video.id) incomingMap.set(video.id, video);
                    }

                    // 3. Merge: for each video, keep the version with more notes.
                    //    For notes within a video, union by note ID, keeping the
                    //    version with the longest text (captures enhancements).
                    const merged = [];
                    const allIds = new Set([...existingMap.keys(), ...incomingMap.keys()]);

                    for (const id of allIds) {
                        const ext = existingMap.get(id);
                        const inc = incomingMap.get(id);

                        if (!inc) {
                            // Video only on server — keep it. Deletes happen via DELETE /bookmarks/:id.
                            // Never infer a delete from the client not including a video; that would
                            // silently destroy videos added by the Chrome extension or another session.
                            merged.push(ext);
                        } else if (!ext) {
                            // Video only in incoming — add it
                            merged.push(inc);
                        } else {
                            // Video exists in both — merge notes
                            const extNotes = ext.notes || [];
                            const incNotes = inc.notes || [];
                            const noteMap = new Map();

                            // Start with existing notes
                            for (const note of extNotes) {
                                noteMap.set(note.id, note);
                            }

                            // Merge incoming notes: keep longer text, preserve favorites
                            for (const note of incNotes) {
                                const existing = noteMap.get(note.id);
                                if (!existing) {
                                    noteMap.set(note.id, note);
                                } else {
                                    // Keep the richer version
                                    noteMap.set(note.id, {
                                        ...existing,
                                        ...note,
                                        text: (note.text || '').length >= (existing.text || '').length ? note.text : existing.text,
                                        favorite: note.favorite || existing.favorite
                                    });
                                }
                            }

                            // Use incoming video metadata (title, tags, etc.) but merged notes
                            merged.push({
                                ...ext,
                                ...inc,
                                notes: Array.from(noteMap.values()),
                                // Keep the higher view count
                                viewCount: Math.max(ext.viewCount || 0, inc.viewCount || 0),
                                // Keep the most recent lastWatchedAt
                                lastWatchedAt: (ext.lastWatchedAt || '') > (inc.lastWatchedAt || '') ? ext.lastWatchedAt : inc.lastWatchedAt
                            });
                        }
                    }

                    const notesBefore = existing.reduce((sum, v) => sum + (v.notes || []).length, 0);
                    const notesAfter = merged.reduce((sum, v) => sum + (v.notes || []).length, 0);
                    console.log(`📚 Merge result: ${existing.length} → ${merged.length} videos, ${notesBefore} → ${notesAfter} notes`);
                    if (notesAfter < notesBefore) {
                        console.warn(`⚠️ NOTE COUNT DECREASED after merge — this should not happen!`);
                    }

                    writeUserBookmarks(userId, merged);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, count: merged.length }));
                } else {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Expected array of bookmarks' }));
                }
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
            return;
        }
    }

    // DELETE /bookmarks/:id — remove a single video by ID
    if (req.method === 'DELETE' && url.pathname.startsWith('/bookmarks/')) {
        const userId = authenticateRequest(req);
        if (!userId) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
        }
        const videoId = url.pathname.split('/bookmarks/')[1];
        if (!videoId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing video ID' }));
            return;
        }
        const bookmarks = readUserBookmarks(userId);
        const filtered = bookmarks.filter(v => v.id !== videoId);
        if (filtered.length === bookmarks.length) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Video not found' }));
            return;
        }
        writeUserBookmarks(userId, filtered);
        console.log(`🗑️ DELETE /bookmarks/${videoId} for user ${userId}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
    }

    // Categories API - requires authentication
    if (url.pathname === '/categories') {
        const userId = authenticateRequest(req);

        if (!userId) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Authentication required' }));
            return;
        }

        if (req.method === 'GET') {
            const categories = readUserCategories(userId);
            console.log(`📁 GET /categories - returning ${categories.length} categories for user ${userId}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(categories));
            return;
        }

        if (req.method === 'POST') {
            try {
                const categories = await parseBody(req);
                if (Array.isArray(categories)) {
                    writeUserCategories(userId, categories);
                    console.log(`📁 POST /categories - saved ${categories.length} categories for user ${userId}`);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, count: categories.length }));
                } else {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Expected array of categories' }));
                }
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
            return;
        }
    }

    // =============================================
    // BACKUP / RESTORE ENDPOINTS
    // =============================================

    if (url.pathname === '/api/backup/export') {
        const userId = authenticateRequest(req);
        if (!userId) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Authentication required' }));
            return;
        }

        if (req.method !== 'GET') {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Method not allowed' }));
            return;
        }

        const bookmarks = readUserBookmarks(userId);
        const categories = readUserCategories(userId);
        const users = readUsers();
        const username = users[userId]?.username || 'unknown';

        const noteCount = bookmarks.reduce((sum, v) => sum + (v.notes?.length || 0), 0);

        const backup = {
            clipmark_backup: true,
            version: 1,
            exportedAt: new Date().toISOString(),
            username,
            stats: {
                videoCount: bookmarks.length,
                noteCount,
                categoryCount: categories.length
            },
            data: {
                bookmarks,
                categories
            }
        };

        const dateStr = new Date().toISOString().split('T')[0];
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Content-Disposition': `attachment; filename="clipmark-backup-${dateStr}.json"`
        });
        res.end(JSON.stringify(backup, null, 2));
        console.log(`📦 GET /api/backup/export - exported ${bookmarks.length} bookmarks, ${categories.length} categories for user ${userId}`);
        return;
    }

    if (url.pathname === '/api/backup/import') {
        const userId = authenticateRequest(req);
        if (!userId) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Authentication required' }));
            return;
        }

        if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Method not allowed' }));
            return;
        }

        try {
            const body = await parseBody(req);
            const strategy = body.strategy || 'merge';

            if (strategy !== 'merge' && strategy !== 'replace') {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid strategy. Use "merge" or "replace".' }));
                return;
            }

            // Parse backup data - support both v1 and legacy format
            let importBookmarks, importCategories;

            if (body.clipmark_backup && body.data) {
                // v1 format
                importBookmarks = body.data.bookmarks;
                importCategories = body.data.categories;
            } else if (body.videos || body.categories) {
                // Legacy format
                importBookmarks = body.videos;
                importCategories = body.categories;
            } else {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid backup format. Expected ClipMark backup file.' }));
                return;
            }

            if (!Array.isArray(importBookmarks)) importBookmarks = [];
            if (!Array.isArray(importCategories)) importCategories = [];

            // Filter out entries without IDs
            importBookmarks = importBookmarks.filter(b => b && b.id);
            importCategories = importCategories.filter(c => c && c.id);

            let result;

            if (strategy === 'replace') {
                writeUserBookmarks(userId, importBookmarks);
                writeUserCategories(userId, importCategories);
                result = {
                    success: true,
                    strategy: 'replace',
                    bookmarks: { total: importBookmarks.length, added: importBookmarks.length, skipped: 0 },
                    categories: { total: importCategories.length }
                };
            } else {
                // Merge strategy
                const existingBookmarks = readUserBookmarks(userId);
                const existingCategories = readUserCategories(userId);

                // Build dedup key set for existing bookmarks
                const existingKeys = new Set();
                for (const b of existingBookmarks) {
                    const key = b.sourceType && b.sourceId
                        ? `${b.sourceType}:${b.sourceId}`
                        : (b.videoId ? `youtube:${b.videoId}` : b.id);
                    existingKeys.add(key);
                }

                // Build category name -> id map (case-insensitive)
                const existingCatMap = new Map();
                for (const c of existingCategories) {
                    existingCatMap.set(c.name.toLowerCase(), c.id);
                }

                // Merge categories first (dedup by name)
                let newCatCount = 0;
                const catIdRemap = new Map(); // old imported cat ID -> existing cat ID
                for (const ic of importCategories) {
                    const lowerName = ic.name.toLowerCase();
                    if (existingCatMap.has(lowerName)) {
                        catIdRemap.set(ic.id, existingCatMap.get(lowerName));
                    } else {
                        existingCategories.push(ic);
                        existingCatMap.set(lowerName, ic.id);
                        newCatCount++;
                    }
                }

                // Merge bookmarks (dedup by sourceType:sourceId)
                let added = 0;
                let skipped = 0;
                for (const b of importBookmarks) {
                    const key = b.sourceType && b.sourceId
                        ? `${b.sourceType}:${b.sourceId}`
                        : (b.videoId ? `youtube:${b.videoId}` : b.id);

                    if (existingKeys.has(key)) {
                        skipped++;
                    } else {
                        // Remap category ID if needed
                        if (b.category && catIdRemap.has(b.category)) {
                            b.category = catIdRemap.get(b.category);
                        }
                        existingBookmarks.push(b);
                        existingKeys.add(key);
                        added++;
                    }
                }

                writeUserBookmarks(userId, existingBookmarks);
                writeUserCategories(userId, existingCategories);

                result = {
                    success: true,
                    strategy: 'merge',
                    bookmarks: { total: existingBookmarks.length, added, skipped },
                    categories: { total: existingCategories.length }
                };
            }

            console.log(`📦 POST /api/backup/import - ${strategy}: ${result.bookmarks.added} added, ${result.bookmarks.skipped || 0} skipped for user ${userId}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (e) {
            console.error('❌ Import error:', e.message);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // =============================================
    // PUBLIC ENDPOINTS (no authentication required)
    // =============================================

    // Transcript job status (for debugging)
    if (url.pathname === '/api/transcript/status') {
        const videoId = url.searchParams.get('v');
        const status = {
            videoId,
            hasCached: videoId ? !!getCachedTranscript(videoId) : false,
            isPending: videoId ? pendingGeminiJobs.has(videoId) : false,
            failedJob: videoId ? failedGeminiJobs.get(videoId) || null : null,
            geminiConfigured: !!GEMINI_API_KEY,
            totalPendingJobs: pendingGeminiJobs.size,
            totalFailedJobs: failedGeminiJobs.size
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status));
        return;
    }

    if (url.pathname === '/transcript') {
        const videoId = url.searchParams.get('v');

        if (!videoId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing video ID parameter (v)' }));
            return;
        }

        try {
            console.log(`\n${'='.repeat(50)}`);
            console.log(`Request for video: ${videoId}`);
            console.log(`${'='.repeat(50)}`);

            const transcript = await getTranscript(videoId);
            console.log(`✅ Success! Got ${transcript.length} segments`);
            console.log(`First segment: [${transcript[0]?.start}s] ${transcript[0]?.text?.substring(0, 50)}...`);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ transcript }));
        } catch (error) {
            console.error(`❌ Error: ${error.message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
        return;
    }

    // Chrome extension download
    if (url.pathname === '/download/chrome-extension') {
        const zipPath = path.join(__dirname, 'chrome-extension.zip');
        if (fs.existsSync(zipPath)) {
            const stat = fs.statSync(zipPath);
            res.writeHead(200, {
                'Content-Type': 'application/zip',
                'Content-Disposition': 'attachment; filename="clipmark-chrome-extension.zip"',
                'Content-Length': stat.size
            });
            fs.createReadStream(zipPath).pipe(res);
        } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Extension download not available' }));
        }
        return;
    }

    if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
    }

    if (url.pathname === '/test') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
<!DOCTYPE html>
<html>
<head>
    <title>Transcript Server</title>
    <style>
        body { font-family: system-ui, sans-serif; padding: 40px; max-width: 900px; margin: 0 auto; background: #1a1a2e; color: #eee; }
        h1 { color: #e94560; }
        .card { background: #16213e; padding: 20px; border-radius: 12px; margin: 20px 0; }
        input { padding: 12px; width: 300px; border-radius: 8px; border: 1px solid #444; background: #0f3460; color: #fff; font-size: 16px; }
        button { padding: 12px 24px; background: #e94560; color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 16px; margin-left: 10px; }
        button:hover { background: #ff6b6b; }
        pre { background: #0f3460; padding: 20px; border-radius: 8px; overflow: auto; max-height: 400px; white-space: pre-wrap; word-wrap: break-word; }
        .links a { display: inline-block; margin-right: 10px; padding: 10px 16px; background: #0f3460; border-radius: 8px; color: #e94560; text-decoration: none; }
        .links a:hover { background: #1a3a6e; }
        .success { color: #4ade80; }
        .error { color: #f87171; }
    </style>
</head>
<body>
    <h1>🎬 YouTube Transcript Server</h1>

    <div class="card">
        <h3>Test with sample videos:</h3>
        <div class="links">
            <a href="#" onclick="test('dQw4w9WgXcQ')">Rick Astley</a>
            <a href="#" onclick="test('jNQXAC9IVRw')">First YT Video</a>
            <a href="#" onclick="test('9bZkp7q19f0')">Gangnam Style</a>
        </div>
    </div>

    <div class="card">
        <h3>Or enter a video ID or URL:</h3>
        <input type="text" id="vid" placeholder="Video ID or YouTube URL">
        <button onclick="testInput()">Get Transcript</button>
    </div>

    <div class="card">
        <h3>Result:</h3>
        <pre id="result">Click a test link or enter a video ID above</pre>
    </div>

    <script>
        function extractVideoId(input) {
            // Handle full URLs (including live videos)
            const urlMatch = input.match(/(?:youtube\\.com\\/watch\\?v=|youtu\\.be\\/|youtube\\.com\\/embed\\/|youtube\\.com\\/live\\/)([a-zA-Z0-9_-]{11})/);
            if (urlMatch) return urlMatch[1];
            // Handle plain video ID
            if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;
            return null;
        }

        function testInput() {
            const input = document.getElementById('vid').value.trim();
            const videoId = extractVideoId(input);
            if (!videoId) {
                document.getElementById('result').innerHTML = '<span class="error">Invalid video ID or URL</span>';
                return;
            }
            test(videoId);
        }

        async function test(videoId) {
            document.getElementById('result').textContent = 'Loading...';
            try {
                const res = await fetch('/transcript?v=' + videoId);
                const data = await res.json();
                if (data.error) {
                    document.getElementById('result').innerHTML = '<span class="error">Error: ' + data.error + '</span>';
                } else {
                    const preview = data.transcript.slice(0, 15).map(t =>
                        '[' + t.start.toFixed(1) + 's] ' + t.text
                    ).join('\\n');
                    document.getElementById('result').innerHTML =
                        '<span class="success">✅ Found ' + data.transcript.length + ' segments</span>\\n\\n' + preview +
                        (data.transcript.length > 15 ? '\\n\\n... and ' + (data.transcript.length - 15) + ' more segments' : '');
                }
            } catch (e) {
                document.getElementById('result').innerHTML = '<span class="error">Network error: ' + e.message + '</span>';
            }
        }
    </script>
</body>
</html>
        `);
        return;
    }

    // Static file serving for production deployment
    // Serve index.html for root path, app.html for /app and /admin routes
    const appRoutes = ['/app', '/admin'];
    let filePath;
    if (url.pathname === '/') {
        filePath = '/index.html';
    } else if (appRoutes.includes(url.pathname)) {
        filePath = '/app.html';
    } else {
        filePath = url.pathname;
    }

    // Security: prevent directory traversal
    filePath = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');
    const fullPath = path.join(STATIC_DIR, filePath);

    // Check if file exists and is within STATIC_DIR
    if (!fullPath.startsWith(STATIC_DIR)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden' }));
        return;
    }

    try {
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
            const ext = path.extname(fullPath).toLowerCase();
            const contentType = MIME_TYPES[ext] || 'application/octet-stream';
            const content = fs.readFileSync(fullPath);

            res.writeHead(200, {
                'Content-Type': contentType,
                'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400'
            });
            res.end(content);
            return;
        }
    } catch (e) {
        console.error('Static file error:', e.message);
    }

    // 404 for everything else
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n${'='.repeat(50)}`);
    console.log('🎬 VideoNoteSnatch Server');
    console.log(`${'='.repeat(50)}`);
    console.log(`\nEnvironment: ${process.env.RAILWAY_ENVIRONMENT || 'local'}`);
    console.log(`Running at: http://0.0.0.0:${PORT}`);
    console.log(`\nAPI Status:`);
    console.log(`  Gemini AI: ${GEMINI_API_KEY ? '✅ Configured' : '❌ Not configured'}`);
    console.log(`  YouTube Data: ${YOUTUBE_API_KEY ? '✅ Configured' : '❌ Not configured'}`);
    console.log(`\nPress Ctrl+C to stop\n`);
});
