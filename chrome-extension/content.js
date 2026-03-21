// ClipMark YouTube Content Script
// Injects a 📌 button near YouTube's action buttons

(function() {
  'use strict';

  let currentVideoUrl = '';
  let buttonInjected = false;
  let styleInjected = false;

  // Check if critical styles are loaded, inject fallback if needed
  function ensureCriticalStyles() {
    if (styleInjected) return;
    
    // Check if our CSS file loaded properly
    const testEl = document.createElement('div');
    testEl.id = 'clipmark-btn';
    testEl.setAttribute('data-clipmark', 'button');
    testEl.style.position = 'absolute';
    testEl.style.top = '-9999px';
    testEl.style.visibility = 'hidden';
    document.body.appendChild(testEl);
    
    const computed = getComputedStyle(testEl);
    const hasStyles = computed.borderRadius === '18px';
    
    document.body.removeChild(testEl);
    
    if (!hasStyles) {
      console.warn('ClipMark: CSS not loaded, injecting fallback styles');
      // Minimal fallback styles only if content.css failed to load
      const style = document.createElement('style');
      style.id = 'clipmark-fallback-styles';
      style.textContent = `
        #clipmark-btn[data-clipmark="button"] {
          display: inline-flex !important;
          align-items: center !important;
          gap: 6px !important;
          padding: 0 12px !important;
          height: 36px !important;
          background: transparent !important;
          border: 1px solid rgba(255,255,255,0.1) !important;
          border-radius: 18px !important;
          color: #f1f1f1 !important;
          font-size: 14px !important;
          font-weight: 500 !important;
          cursor: pointer !important;
          margin-left: 8px !important;
          z-index: 100 !important;
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
    toast.setAttribute('data-clipmark', 'toast');
    toast.className = type;
    toast.innerHTML = `<span>${type === 'success' ? '✅' : '❌'}</span><span>${message}</span>`;
    document.body.appendChild(toast);

    // Auto-dismiss after 4 seconds
    setTimeout(() => {
      if (toast && toast.parentNode) {
        toast.style.animation = 'cmToastOut 0.3s ease forwards';
        setTimeout(() => {
          if (toast && toast.parentNode) {
            toast.remove();
          }
        }, 300);
      }
    }, 4000);
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
      overlay.setAttribute('data-clipmark', 'overlay');
      
      const modal = document.createElement('div');
      modal.id = 'clipmark-modal';
      modal.setAttribute('data-clipmark', 'modal');
      
      modal.innerHTML = `
        <h3>📌 Save to ClipMark</h3>
        <div class="cm-subtitle">${document.title.replace(/ - YouTube$/, '').substring(0, 60)}${document.title.length > 60 ? '...' : ''}</div>
        <div class="cm-timestamp">⏱ Timestamp: <code>${formatTime(time)}</code></div>
        <textarea id="clipmark-note" placeholder="Add a note about this clip (optional)..." autofocus></textarea>
        <div class="cm-actions">
          <button class="cm-btn cm-btn-cancel" id="clipmark-cancel">Cancel</button>
          <button class="cm-btn cm-btn-save" id="clipmark-save">💾 Save Clip</button>
        </div>
      `;
      
      overlay.appendChild(modal);

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
            const videoTitle = result.video?.title || 'Video';
            const truncatedTitle = videoTitle.length > 30 ? videoTitle.substring(0, 30) + '...' : videoTitle;
            showToast(`✅ Saved "${truncatedTitle}"`, 'success');
            
            // Mark button as saved
            const btn = document.getElementById('clipmark-btn');
            if (btn) {
              btn.classList.add('cm-saved');
              const icon = btn.querySelector('.cm-icon');
              if (icon) {
                icon.textContent = '✅';
              }
              btn.title = 'Saved to ClipMark ✓';
            }
          } else {
            const errorMessage = handleApiError(resp, result);
            showToast(errorMessage, 'error');
          }
        } catch (e) {
          overlay.remove();
          console.error('ClipMark: Network error:', e);
          if (e.name === 'TypeError' && e.message.includes('fetch')) {
            showToast('Connection failed — check internet or server URL', 'error');
          } else {
            showToast('Network error — please try again', 'error');
          }
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
    ensureCriticalStyles();
    // Prevent double-injection
    if (document.getElementById('clipmark-btn')) return;

    // YouTube's action buttons container (below the video, right side)
    // Try multiple selectors for YouTube's evolving UI
    const targets = [
      '#top-level-buttons-computed',           // Desktop primary
      'ytd-menu-renderer #top-level-buttons-computed',
      '#actions #menu #top-level-buttons-computed',
      '#actions-inner #menu #top-level-buttons-computed',
      'ytd-watch-metadata #actions-inner ytd-menu-renderer', // Newer layout
      '#actions ytd-menu-renderer #top-level-buttons-computed', // Alternative
      'div#top-level-buttons-computed', // More specific
      '[id="top-level-buttons-computed"]' // Attribute selector
    ];

    let container = null;
    for (const sel of targets) {
      container = document.querySelector(sel);
      if (container && container.querySelector('button, ytd-button-renderer')) {
        // Make sure it's actually a button container
        break;
      }
      container = null;
    }

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
    const shortcut = isMac ? 'Cmd+Shift+M' : 'Ctrl+Shift+M';
    btn.title = `Save to ClipMark (${shortcut})`;
    btn.innerHTML = '<span class="cm-icon">📌</span><span>ClipMark</span>';
    
    // Prevent YouTube's event handlers from interfering
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      showModal();
    }, true);

    // Insert after the last button, or at the end
    container.appendChild(btn);
    buttonInjected = true;
    currentVideoUrl = window.location.href;
    
    console.log('ClipMark: Button injected successfully');
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

  // Add keyboard shortcut: Ctrl+Shift+M (or Cmd+Shift+M on Mac) to open ClipMark modal
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'M') {
      if (window.location.href.includes('/watch')) {
        e.preventDefault();
        e.stopPropagation();
        showModal();
      }
    }
  });

  // Initial injection
  if (window.location.href.includes('/watch')) {
    // Delay slightly to let YouTube render
    setTimeout(() => {
      waitForElement().then(() => injectButton());
    }, 1500);
  }

  // Enhanced error handling for API calls
  function handleApiError(response, result) {
    if (response.status === 409) {
      return 'This video is already in your library';
    } else if (response.status === 401) {
      return 'Session expired — please re-login in the extension popup';
    } else if (response.status === 429) {
      return 'Rate limit reached — please try again in a few minutes';
    } else if (response.status === 403) {
      return 'Access denied — check your permissions';
    } else if (response.status === 404) {
      return 'ClipMark server not found — check your settings';
    } else if (response.status >= 500) {
      return 'Server error — please try again later';
    } else {
      return result?.error || result?.message || 'Failed to save clip';
    }
  }

  // Enhanced MutationObserver for better YouTube compatibility
  const observer = new MutationObserver((mutations) => {
    let shouldRecheck = false;
    
    for (const mutation of mutations) {
      // Check if YouTube's action buttons area was modified
      if (mutation.type === 'childList') {
        const target = mutation.target;
        if (target && (target.id === 'top-level-buttons-computed' || 
                      target.closest('#top-level-buttons-computed') ||
                      target.querySelector('#top-level-buttons-computed'))) {
          shouldRecheck = true;
          break;
        }
      }
    }
    
    if (shouldRecheck && window.location.href.includes('/watch') && !document.getElementById('clipmark-btn')) {
      buttonInjected = false;
      setTimeout(() => injectButton(), 100); // Small delay to let YouTube finish updating
    }
  });

  // Start observing when ready
  if (document.body) {
    observer.observe(document.body, { 
      childList: true, 
      subtree: true,
      attributes: false, // Don't watch attribute changes to reduce noise
      attributeOldValue: false,
      characterData: false
    });
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      observer.observe(document.body, { 
        childList: true, 
        subtree: true,
        attributes: false,
        attributeOldValue: false,
        characterData: false
      });
    });
  }

  // Initial style check
  ensureCriticalStyles();

})();
