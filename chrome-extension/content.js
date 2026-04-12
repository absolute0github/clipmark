// ClipMark YouTube Content Script
// Injects a 📌 button near YouTube's action buttons

(function() {
  'use strict';

  let currentVideoUrl = '';
  let buttonInjected = false;
  let styleInjected = false;
  let injectPending = false;
  let debounceTimer = null;

  // ── Selectors YouTube uses for the action button bar ─────────────────────
  const BUTTON_CONTAINER_SELECTORS = [
    '#top-level-buttons-computed',
    'ytd-menu-renderer #top-level-buttons-computed',
    '#actions #menu #top-level-buttons-computed',
    '#actions-inner #menu #top-level-buttons-computed',
    'ytd-watch-metadata #actions-inner ytd-menu-renderer',
    '#actions ytd-menu-renderer #top-level-buttons-computed',
    'div#top-level-buttons-computed',
    '[id="top-level-buttons-computed"]',
  ];

  // ── Critical style fallback ───────────────────────────────────────────────
  function ensureCriticalStyles() {
    if (styleInjected) return;

    const testEl = document.createElement('div');
    testEl.id = 'clipmark-btn';
    testEl.setAttribute('data-clipmark', 'button');
    testEl.style.cssText = 'position:absolute;top:-9999px;visibility:hidden;';
    document.body.appendChild(testEl);

    const computed = getComputedStyle(testEl);
    const hasStyles = computed.borderRadius === '18px';
    document.body.removeChild(testEl);

    if (!hasStyles) {
      console.warn('ClipMark: CSS file not loaded — injecting fallback styles');
      const style = document.createElement('style');
      style.id = 'clipmark-fallback-styles';
      style.textContent = `
        #clipmark-btn[data-clipmark="button"] {
          all: unset !important;
          display: inline-flex !important;
          align-items: center !important;
          justify-content: center !important;
          gap: 6px !important;
          padding: 0 12px !important;
          height: 36px !important;
          background: transparent !important;
          border: 1px solid rgba(255,255,255,0.1) !important;
          border-radius: 18px !important;
          color: #f1f1f1 !important;
          font-size: 14px !important;
          font-family: 'Roboto', sans-serif !important;
          font-weight: 500 !important;
          cursor: pointer !important;
          margin-left: 8px !important;
          z-index: 100 !important;
          box-sizing: border-box !important;
          pointer-events: auto !important;
        }
        #clipmark-btn[data-clipmark="button"] .cm-icon {
          all: unset !important;
          display: inline !important;
          visibility: visible !important;
          opacity: 1 !important;
          font-size: 18px !important;
        }
        #clipmark-btn[data-clipmark="button"] .cm-label {
          all: unset !important;
          display: inline-block !important;
          visibility: visible !important;
          opacity: 1 !important;
          color: #f1f1f1 !important;
          font-size: 14px !important;
        }
        #clipmark-btn[data-clipmark="button"]:hover {
          background: rgba(16,185,129,0.15) !important;
          border-color: rgba(16,185,129,0.3) !important;
        }
      `;
      document.head.appendChild(style);
    }

    styleInjected = true;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function formatTime(seconds) {
    const s = Math.floor(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

  function getCurrentTime() {
    const video = document.querySelector('video');
    return video ? video.currentTime : 0;
  }

  function isOnVideoPage() {
    return window.location.pathname === '/watch' || window.location.href.includes('/watch?');
  }

  // ── Toast notification ────────────────────────────────────────────────────

  function showToast(message, type = 'success') {
    const existing = document.getElementById('clipmark-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'clipmark-toast';
    toast.setAttribute('data-clipmark', 'toast');
    toast.className = type;
    toast.innerHTML = `<span>${type === 'success' ? '✅' : '❌'}</span><span>${message}</span>`;
    document.body.appendChild(toast);

    setTimeout(() => {
      if (toast && toast.parentNode) {
        toast.style.animation = 'cmToastOut 0.3s ease forwards';
        setTimeout(() => { if (toast && toast.parentNode) toast.remove(); }, 300);
      }
    }, 4000);
  }

  // ── API error handling ────────────────────────────────────────────────────

  function handleApiError(response, result) {
    if (response.status === 409) return 'This video is already in your library';
    if (response.status === 401) return 'Session expired — please re-login in the extension popup';
    if (response.status === 429) return 'Rate limit reached — try again in a few minutes';
    if (response.status === 403) return 'Access denied — check your permissions';
    if (response.status === 404) return 'ClipMark server not found — check your settings';
    if (response.status >= 500) return 'Server error — please try again later';
    return result?.error || result?.message || 'Failed to save clip';
  }

  // ── Save modal ────────────────────────────────────────────────────────────

  function showModal() {
    chrome.storage.sync.get(['serverUrl', 'authToken'], (data) => {
      if (!data.authToken) {
        showToast('Not logged in — open ClipMark extension to log in', 'error');
        return;
      }

      const time = getCurrentTime();
      const overlay = document.createElement('div');
      overlay.id = 'clipmark-modal-overlay';
      overlay.setAttribute('data-clipmark', 'overlay');

      const modal = document.createElement('div');
      modal.id = 'clipmark-modal';
      modal.setAttribute('data-clipmark', 'modal');

      const titleText = document.title.replace(/ - YouTube$/, '');
      const truncTitle = titleText.length > 60 ? titleText.substring(0, 60) + '…' : titleText;
      const isMac = navigator.platform.indexOf('Mac') === 0;

      modal.innerHTML = `
        <h3>📌 Save to ClipMark</h3>
        <div class="cm-subtitle">${truncTitle}</div>
        <div class="cm-timestamp">⏱ Timestamp: <code>${formatTime(time)}</code></div>
        <textarea id="clipmark-note" placeholder="Add a note about this clip (optional)…" autofocus></textarea>
        <div class="cm-hint">${isMac ? '⌘' : 'Ctrl'}+Enter to save quickly</div>
        <div class="cm-actions">
          <button class="cm-btn cm-btn-cancel" id="clipmark-cancel">Cancel</button>
          <button class="cm-btn cm-btn-save" id="clipmark-save">💾 Save Clip</button>
        </div>
      `;

      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      setTimeout(() => { const ta = document.getElementById('clipmark-note'); if (ta) ta.focus(); }, 100);

      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
      document.getElementById('clipmark-cancel').addEventListener('click', () => overlay.remove());

      const escHandler = (e) => {
        if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', escHandler); }
      };
      document.addEventListener('keydown', escHandler);

      document.getElementById('clipmark-note').addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') document.getElementById('clipmark-save').click();
      });

      document.getElementById('clipmark-save').addEventListener('click', async () => {
        const saveBtn = document.getElementById('clipmark-save');
        const note = document.getElementById('clipmark-note').value.trim();
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';

        try {
          const serverUrl = (data.serverUrl || 'https://clipmark.top').replace(/\/+$/, '');
          const payload = { url: window.location.href.split('&list=')[0], timestamp: time };
          if (note) payload.note = note;

          const resp = await fetch(`${serverUrl}/api/clips/quick-add`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${data.authToken}` },
            body: JSON.stringify(payload),
          });

          const result = await resp.json();
          overlay.remove();

          if (resp.ok && result.success) {
            const videoTitle = result.video?.title || 'Video';
            const t = videoTitle.length > 30 ? videoTitle.substring(0, 30) + '…' : videoTitle;
            showToast(`Saved "${t}"`, 'success');

            const btn = document.getElementById('clipmark-btn');
            if (btn) {
              btn.classList.add('cm-saved');
              const icon = btn.querySelector('.cm-icon');
              if (icon) icon.textContent = '✅';
              btn.title = 'Saved to ClipMark ✓';
            }
          } else {
            showToast(handleApiError(resp, result), 'error');
          }
        } catch (e) {
          if (overlay.parentNode) overlay.remove();
          console.error('ClipMark: Network error:', e);
          showToast(
            e.name === 'TypeError' && e.message.includes('fetch')
              ? 'Connection failed — check internet or server URL'
              : 'Network error — please try again',
            'error'
          );
        }
      });
    });
  }

  // ── Find button container ─────────────────────────────────────────────────

  function findButtonContainer() {
    for (const sel of BUTTON_CONTAINER_SELECTORS) {
      const el = document.querySelector(sel);
      if (el && (el.querySelector('button, ytd-button-renderer') || el.children.length > 0)) {
        return el;
      }
    }
    return null;
  }

  // ── Button injection ──────────────────────────────────────────────────────

  function injectButton() {
    ensureCriticalStyles();

    // Deduplication guard
    if (document.getElementById('clipmark-btn')) {
      buttonInjected = true;
      return;
    }

    const container = findButtonContainer();
    if (!container) {
      console.warn('ClipMark: Could not find YouTube action buttons container');
      return;
    }

    const btn = document.createElement('button');
    btn.id = 'clipmark-btn';
    btn.setAttribute('data-clipmark', 'button');
    btn.setAttribute('type', 'button');
    btn.setAttribute('aria-label', 'Save video to ClipMark with timestamp');
    const isMac = navigator.platform.indexOf('Mac') === 0;
    btn.title = `Save to ClipMark (${isMac ? 'Cmd' : 'Ctrl'}+Shift+M)`;

    // Use explicit class on the label span to avoid YouTube stripping visibility
    btn.innerHTML = '<span class="cm-icon" data-clipmark="icon">📌</span><span class="cm-label" data-clipmark="label">ClipMark</span>';

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      showModal();
    }, true);

    container.appendChild(btn);
    buttonInjected = true;
    currentVideoUrl = window.location.href;
    console.log('ClipMark: Button injected successfully');
  }

  function removeButton() {
    const btn = document.getElementById('clipmark-btn');
    if (btn) btn.remove();
    buttonInjected = false;
    injectPending = false;
  }

  // ── SPA navigation handling ───────────────────────────────────────────────

  function scheduleInject(delay = 1200) {
    if (injectPending) return;
    injectPending = true;
    setTimeout(() => {
      injectPending = false;
      if (isOnVideoPage() && !document.getElementById('clipmark-btn')) {
        waitForContainer().then(injectButton);
      }
    }, delay);
  }

  function onNavigate() {
    const url = window.location.href;

    // If still on the same video and button is present, nothing to do
    if (url === currentVideoUrl && document.getElementById('clipmark-btn')) return;

    removeButton();
    currentVideoUrl = url;

    if (isOnVideoPage()) {
      scheduleInject(1200);
    }
  }

  // ── Wait for container to appear ─────────────────────────────────────────

  function waitForContainer(timeout = 10000) {
    return new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        const el = findButtonContainer();
        if (el) return resolve(el);
        if (Date.now() - start > timeout) {
          console.warn('ClipMark: Timed out waiting for button container');
          return resolve(null);
        }
        requestAnimationFrame(check);
      };
      check();
    });
  }

  // ── MutationObserver (debounced) ──────────────────────────────────────────

  function onMutation(mutations) {
    if (!isOnVideoPage()) return;
    if (document.getElementById('clipmark-btn')) return; // Already injected

    let relevant = false;
    for (const m of mutations) {
      if (m.type !== 'childList') continue;
      const target = m.target;
      // Safe element check before calling closest()
      if (!(target instanceof Element)) continue;
      if (
        target.id === 'top-level-buttons-computed' ||
        target.closest('#top-level-buttons-computed') ||
        target.querySelector('#top-level-buttons-computed') ||
        target.id === 'actions' ||
        target.closest('#actions')
      ) {
        relevant = true;
        break;
      }
    }

    if (!relevant) return;

    // Debounce rapid mutations
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (isOnVideoPage() && !document.getElementById('clipmark-btn')) {
        buttonInjected = false;
        injectButton();
      }
    }, 150);
  }

  const observer = new MutationObserver(onMutation);

  function startObserver() {
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: false,
      characterData: false,
    });
  }

  // ── Keyboard shortcut ─────────────────────────────────────────────────────

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'M') {
      if (isOnVideoPage()) {
        e.preventDefault();
        e.stopPropagation();
        showModal();
      }
    }
  });

  // ── YouTube SPA events ────────────────────────────────────────────────────

  document.addEventListener('yt-navigate-finish', onNavigate);
  document.addEventListener('yt-page-data-updated', () => {
    if (isOnVideoPage() && !document.getElementById('clipmark-btn')) {
      scheduleInject(800);
    }
  });
  window.addEventListener('popstate', () => setTimeout(onNavigate, 300));

  // ── Backup periodic check (every 5s) for stubborn pages ──────────────────
  // YouTube sometimes loads the actions bar very late; this is the safety net.
  setInterval(() => {
    if (isOnVideoPage() && !document.getElementById('clipmark-btn') && !injectPending) {
      const container = findButtonContainer();
      if (container) injectButton();
    }
  }, 5000);

  // ── Boot ──────────────────────────────────────────────────────────────────

  if (document.body) {
    startObserver();
    ensureCriticalStyles();
    if (isOnVideoPage()) scheduleInject(1500);
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      startObserver();
      ensureCriticalStyles();
      if (isOnVideoPage()) scheduleInject(1500);
    });
  }

})();
