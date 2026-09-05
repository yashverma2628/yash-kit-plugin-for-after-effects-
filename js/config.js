/**
 * Yashkit runtime config
 * ─────────────────────
 * The plugin talks to a small proxy server that holds the Pulse + Groq API
 * keys (see /server). No secret keys live in the plugin anymore.
 *
 * Set PROXY_BASE_URL to your deployed proxy (https://… in production).
 * If you set APP_TOKEN here, it must match the server's APP_TOKEN env var.
 */
'use strict';

var YASHKIT_CONFIG = {
  // Production proxy (always-on, HTTPS). Replace with your live Worker / proxy URL
  // (e.g. https://yashkit.workers.dev or https://api.yashkit.ai).
  // For LOCAL development, swap this back to 'http://localhost:8787'.
  PROXY_BASE_URL: 'https://yashkit.workers.dev',
  // Shared gate token — must match the Worker's APP_TOKEN secret
  // (set with: npx wrangler secret put APP_TOKEN). Sent as x-app-token on every
  // proxy request. Note: this ships inside the panel, so it's a soft gate
  // against drive-by abuse of the proxy URL, not strong per-user auth.
  APP_TOKEN:      'yashkit_f4fade0b2325b0da752e1866060c005b74c1d07c720c22bc'
};
