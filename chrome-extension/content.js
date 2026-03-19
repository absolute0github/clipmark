// ClipMark YouTube Content Script
// Injects a 📌 button near YouTube's action buttons

(function() {
  'use strict';

  let currentVideoUrl = '';
  let buttonInjected = false;
  let styleInjected = false;

  // Inject styles with !important to beat YouTube's CSS
  function injectStyles() {
    if (styleInjected) return;
    const style = document.createElement('style');
    style.textContent = `
      #clipmark-btn {
        display: inline-flex !important;
        align-items: center !important;
        gap: 6px !important;
        padding: 0 14px !important;
        height: 36px !important;
        background: #10b981 !important;
        border: none !important;
        border-radius: 18px !important;
        color: #fff !important;
        font-size: 13px !important;
        font-family: 'Roboto', Arial, sans-serif !important;
        font-weight: 600 !important;
        cursor: pointer !important;
        white-space: nowrap !important;
        vertical-align: middle !important;
        margin-left: 4px !important;
        opacity: 1 !important;
        visibility: visible !important;
      }
      #clipmark-btn:hover {
        background: #059669 !important;
      }
      #clipmark-btn * {
        color: #fff !important;
        opacity: 1 !important;
        visibility: visible !important;
      }
      #clipmark-btn .cm-icon {
        font-size: 16px !important;
        line-height: 1 !important;
      }
      #clipmark-btn.cm-saved {
        background: #064e3b !important;
      }
    `;
    document.head.appendChild(style);
    styleInjected = true;
  }

  // Format seconds to MM:SS or HH:MM:SS
  function formatTime(seconds) {
    const s = Math.floor(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

  // Get current video playback time
  function getCurrentTime() {
    const video = document.querySelector('video');
    return video ? video.currentTime : 0;
  }

  // Show toast notification
  function showToast(message, type = 'success') {
    const existing = document.getElementById('clipmark-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'clipmark-toast';
    toast.className = type;
    toast.innerHTML = `${type === 'success' ? '✅' : '❌'} ${message}`;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.animation = 'cmToastOut 0.3s ease forwards';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // Show the quick-add modal
  function showModal() {
    // Check auth first
    chrome.storage.sync.get(['serverUrl', 'authToken'], (data) => {
      if (!data.authToken) {
        showToast('Not logged in — open ClipMark extension to log in', 'error');
        return;
      }

      const time = getCurrentTime();
      const overlay = document.createElement('div');
      overlay.id = 'clipmark-modal-overlay';
      overlay.innerHTML = `
        <div id="clipmark-modal">
          <h3>📌 Save to ClipMark</h3>
          <div class="cm-subtitle">${document.title.replace(/ - YouTube$/, '')}</div>
          <div class="cm-timestamp">⏱ Timestamp: <code>${formatTime(time)}</code></div>
          <textarea id="clipmark-note" placeholder="Add a note (optional)..." autofocus></textarea>
          <div class="cm-actions">
            <button class="cm-btn cm-btn-cancel" id="clipmark-cancel">Cancel</button>
            <button class="cm-btn cm-btn-save" id="clipmark-save">Save</button>
          </div>
        </div>
      `;

      document.body.appendChild(overlay);

      // Focus textarea
      setTimeout(() => {
        const ta = document.getElementById('clipmark-note');
        if (ta) ta.focus();
      }, 100);

      // Close on overlay click
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
      });

      // Cancel button
      document.getElementById('clipmark-cancel').addEventListener('click', () => overlay.remove());

      // Escape key
      const escHandler = (e) => {
        if (e.key === 'Escape') {
          overlay.remove();
          document.removeEventListener('keydown', escHandler);
        }
      };
      document.addEventListener('keydown', escHandler);

      // Save button
      document.getElementById('clipmark-save').addEventListener('click', async () => {
        const saveBtn = document.getElementById('clipmark-save');
        const note = document.getElementById('clipmark-note').value.trim();
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';

        try {
          const serverUrl = (data.serverUrl || 'https://clipmark.top').replace(/\/+$/, '');
          const payload = {
            url: window.location.href.split('&list=')[0], // Strip playlist params
            timestamp: time
          };
          if (note) payload.note = note;

          const resp = await fetch(`${serverUrl}/api/clips/quick-add`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${data.authToken}`
            },
            body: JSON.stringify(payload)
          });

          const result = await resp.json();

          overlay.remove();

          if (resp.ok && result.success) {
            showToast(`Saved "${result.video.title}"`, 'success');
            // Mark button as saved
            const btn = document.getElementById('clipmark-btn');
            if (btn) {
              btn.classList.add('cm-saved');
              btn.querySelector('.cm-icon').textContent = '✅';
            }
          } else if (resp.status === 409) {
            showToast('Already in your library', 'error');
          } else if (resp.status === 401) {
            showToast('Session expired — re-login in extension', 'error');
          } else if (resp.status === 429) {
            showToast('Rate limit — try again later', 'error');
          } else {
            showToast(result.error || 'Failed to save', 'error');
          }
        } catch (e) {
          overlay.remove();
          showToast('Network error — check connection', 'error');
        }
      });

      // Ctrl/Cmd+Enter to save
      document.getElementById('clipmark-note').addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          document.getElementById('clipmark-save').click();
        }
      });
    });
  }

  // Inject the ClipMark button into YouTube's action bar
  function injectButton() {
    injectStyles();
    // Prevent double-injection
    if (document.getElementById('clipmark-btn')) return;

    // YouTube's action buttons container (below the video, right side)
    // Try multiple selectors for YouTube's evolving UI
    const targets = [
      '#top-level-buttons-computed',           // Desktop
      'ytd-menu-renderer #top-level-buttons-computed',
      '#actions #menu #top-level-buttons-computed',
      '#actions-inner #menu #top-level-buttons-computed',
      'ytd-watch-metadata #actions-inner ytd-menu-renderer' // Newer layout
    ];

    let container = null;
    for (const sel of targets) {
      container = document.querySelector(sel);
      if (container) break;
    }

    if (!container) return;

    const btn = document.createElement('button');
    btn.id = 'clipmark-btn';
    btn.title = 'Save to ClipMark';
    btn.innerHTML = '<span class="cm-icon">📌</span><span>Add to ClipMark</span>';
    btn.addEventListener('click', showModal);

    // Insert after the last button
    container.appendChild(btn);
    buttonInjected = true;
    currentVideoUrl = window.location.href;
  }

  // Remove button (for SPA navigation)
  function removeButton() {
    const btn = document.getElementById('clipmark-btn');
    if (btn) btn.remove();
    buttonInjected = false;
  }

  // Watch for YouTube SPA navigation
  function onNavigate() {
    const url = window.location.href;
    if (url === currentVideoUrl && buttonInjected) return;

    removeButton();
    currentVideoUrl = url;

    // Only inject on video pages
    if (url.includes('/watch')) {
      // YouTube loads DOM lazily — wait for the action buttons
      waitForElement().then(() => injectButton());
    }
  }

  // Wait for the YouTube action buttons to appear
  function waitForElement(timeout = 8000) {
    return new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        const el = document.querySelector('#top-level-buttons-computed');
        if (el) return resolve(el);
        if (Date.now() - start > timeout) return resolve(null);
        requestAnimationFrame(check);
      };
      check();
    });
  }

  // Listen for YouTube SPA navigation events
  document.addEventListener('yt-navigate-finish', onNavigate);

  // Also watch for popstate (back/forward)
  window.addEventListener('popstate', () => setTimeout(onNavigate, 500));

  // Initial injection
  if (window.location.href.includes('/watch')) {
    // Delay slightly to let YouTube render
    setTimeout(() => {
      waitForElement().then(() => injectButton());
    }, 1500);
  }

  // Inject critical styles directly into the page as a <style> tag
  // This provides a second layer of defense if YouTube strips the content.css link
  function ensureStyles() {
    if (document.getElementById('clipmark-injected-styles')) return;
    const style = document.createElement('style');
    style.id = 'clipmark-injected-styles';
    style.textContent = `
      #clipmark-btn {
        display: inline-flex !important;
        align-items: center !important;
        gap: 6px !important;
        padding: 0 12px !important;
        height: 36px !important;
        background: transparent !important;
        border: none !important;
        border-radius: 18px !important;
        color: #f1f1f1 !important;
        font-size: 14px !important;
        font-weight: 500 !important;
        cursor: pointer !important;
        white-space: nowrap !important;
        vertical-align: middle !important;
        opacity: 1 !important;
        visibility: visible !important;
        position: relative !important;
        flex-shrink: 0 !important;
      }
      #clipmark-btn:hover { background: rgba(16,185,129,0.15) !important; }
      #clipmark-btn .cm-icon { font-size: 18px !important; }
      #clipmark-btn span { display: inline !important; visibility: visible !important; opacity: 1 !important; }
      #clipmark-btn.cm-saved { color: #10b981 !important; }
      #clipmark-modal-overlay { z-index: 2147483647 !important; }
      #clipmark-toast { z-index: 2147483647 !important; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // MutationObserver fallback — re-inject if YouTube removes our button or styles
  const observer = new MutationObserver(() => {
    ensureStyles();
    if (window.location.href.includes('/watch') && !document.getElementById('clipmark-btn')) {
      buttonInjected = false;
      injectButton();
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
  ensureStyles();

})();
