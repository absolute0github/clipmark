// ClipMark Chrome Extension - Popup
const $ = id => document.getElementById(id);

// Enhanced error handling for popup
function logError(context, error) {
  console.error(`ClipMark Popup [${context}]:`, error);
}

// Safe async wrapper
async function safeAsync(fn, context) {
  try {
    return await fn();
  } catch (error) {
    logError(context, error);
    return null;
  }
}

const DEFAULT_SERVER = 'https://clipmark.top';

// Load saved settings and check connection
document.addEventListener('DOMContentLoaded', async () => {
  await safeAsync(async () => {
    const data = await chrome.storage.sync.get(['serverUrl', 'authToken', 'username']);
    const serverUrl = data.serverUrl || DEFAULT_SERVER;
    
    const serverUrlInput = $('serverUrl');
    if (serverUrlInput) {
      serverUrlInput.value = serverUrl;
    }

    if (data.authToken) {
      await checkConnection(serverUrl, data.authToken, data.username);
    } else {
      showLoginForm();
      await checkServerReachable(serverUrl);
    }
  }, 'initialization');
});

// Login button
$('loginBtn').addEventListener('click', async () => {
  const serverUrl = ($('serverUrl').value || DEFAULT_SERVER).replace(/\/+$/, '');
  const username = $('username').value.trim();
  const password = $('password').value;

  // Validate URL
  if (!validateUrl(serverUrl)) {
    showMsg('error', 'Please enter a valid server URL (https://...)');
    return;
  }

  // Validate credentials
  const credError = validateCredentials(username, password);
  if (credError) {
    showMsg('error', credError);
    return;
  }

  const loginBtn = $('loginBtn');
  if (!loginBtn) return;
  
  loginBtn.disabled = true;
  loginBtn.textContent = 'Logging in...';

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout
    
    const resp = await fetch(`${serverUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    const data = await resp.json();

    if (resp.ok && data.token) {
      await chrome.storage.sync.set({
        serverUrl,
        authToken: data.token,
        username: data.username || username
      });
      showMsg('success', 'Successfully logged in!');
      setTimeout(() => checkConnection(serverUrl, data.token, data.username || username), 500);
    } else {
      const errorMsg = data.error || `Login failed (${resp.status})`;
      showMsg('error', errorMsg);
    }
  } catch (e) {
    logError('login', e);
    if (e.name === 'AbortError') {
      showMsg('error', 'Login timeout — server not responding');
    } else if (e.message.includes('fetch')) {
      showMsg('error', 'Cannot reach server — check URL and connection');
    } else {
      showMsg('error', 'Login failed — please try again');
    }
  }

  loginBtn.disabled = false;
  loginBtn.textContent = 'Log in';
});

// Save manual token
$('saveTokenBtn').addEventListener('click', async () => {
  const serverUrl = ($('serverUrl').value || DEFAULT_SERVER).replace(/\/+$/, '');
  const token = $('tokenInput').value.trim();

  // Validate URL
  if (!validateUrl(serverUrl)) {
    showMsg('error', 'Please enter a valid server URL');
    return;
  }

  if (!token) {
    showMsg('error', 'Auth token is required');
    return;
  }

  if (token.length < 10) {
    showMsg('error', 'Token appears too short — please check');
    return;
  }

  try {
    await chrome.storage.sync.set({ serverUrl, authToken: token });
    showMsg('success', 'Token saved successfully');
    setTimeout(() => checkConnection(serverUrl, token), 500);
  } catch (e) {
    logError('token-save', e);
    showMsg('error', 'Failed to save token');
  }
});

// Logout
$('logoutBtn').addEventListener('click', async () => {
  const data = await chrome.storage.sync.get(['serverUrl', 'authToken']);
  if (data.authToken && data.serverUrl) {
    try {
      await fetch(`${data.serverUrl}/auth/logout`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${data.authToken}` }
      });
    } catch (e) { /* ignore */ }
  }
  await chrome.storage.sync.remove(['authToken', 'username']);
  showLoginForm();
  setStatus('disconnected', 'Logged out');
});

// Check connection with saved token
async function checkConnection(serverUrl, token, username) {
  setStatus('checking', 'Checking connection...');
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000); // 8s timeout
    
    const resp = await fetch(`${serverUrl}/auth/check`, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (resp.ok) {
      const data = await resp.json();
      const name = data.username || username || 'User';
      await chrome.storage.sync.set({ username: name });
      showLoggedIn(name);
      const hostname = new URL(serverUrl).hostname;
      setStatus('connected', `Connected to ${hostname}`);
    } else if (resp.status === 401) {
      showLoginForm();
      setStatus('disconnected', 'Session expired — please log in again');
      await chrome.storage.sync.remove(['authToken', 'username']);
    } else {
      showLoginForm();
      setStatus('disconnected', `Server error (${resp.status})`);
    }
  } catch (e) {
    logError('connection-check', e);
    showLoginForm();
    if (e.name === 'AbortError') {
      setStatus('disconnected', 'Connection timeout');
    } else {
      setStatus('disconnected', 'Cannot reach server');
    }
  }
}

async function checkServerReachable(serverUrl) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5s timeout
    
    const resp = await fetch(`${serverUrl}/api/status`, {
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (resp.ok) {
      setStatus('disconnected', 'Server reachable — please log in');
    } else {
      setStatus('disconnected', `Server error (${resp.status})`);
    }
  } catch (e) {
    logError('server-check', e);
    if (e.name === 'AbortError') {
      setStatus('disconnected', 'Server timeout — check URL');
    } else {
      setStatus('disconnected', 'Cannot reach server — check URL');
    }
  }
}

function showLoginForm() {
  $('loginSection').className = 'login-section active';
  $('loggedInSection').className = 'logged-in-section';
}

function showLoggedIn(username) {
  $('loginSection').className = 'login-section';
  $('loggedInSection').className = 'logged-in-section active';
  $('usernameDisplay').textContent = username;
}

function setStatus(state, text) {
  $('statusDot').className = `status-dot ${state}`;
  $('statusText').textContent = text;
}

function showMsg(type, text) {
  const el = $('loginMsg');
  if (!el) return;
  
  el.className = `msg ${type}`;
  el.textContent = text;
  
  // Auto-hide success messages faster, keep errors longer
  const hideDelay = type === 'success' ? 3000 : 6000;
  setTimeout(() => { 
    if (el.className.includes(type)) {
      el.className = 'msg';
    }
  }, hideDelay);
}

// Input validation helpers
function validateUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function validateCredentials(username, password) {
  if (!username || username.length < 2) {
    return 'Username must be at least 2 characters';
  }
  if (!password || password.length < 1) {
    return 'Password is required';
  }
  return null;
}
