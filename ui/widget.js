/**
 * Loop Gateway – Embeddable Chat Widget
 *
 * Usage:
 *   <script src="https://your-gateway.com/widget/embed.js"
 *           data-channel-id="CHANNEL_ID"
 *           data-server="https://your-gateway.com"></script>
 *
 * Optional attributes:
 *   data-position="bottom-right" | "bottom-left"
 *   data-primary-color="#6366f1"
 *   data-title="Chat"
 *   data-subtitle="Ask us anything"
 *   data-welcome="Hello! How can I help you?"
 *   data-placeholder="Type your message..."
 */
(function () {
  'use strict';

  // Prevent double-init
  if (window.__loopGatewayWidget) return;
  window.__loopGatewayWidget = true;

  // --- Read config from script tag ---
  var scriptTag = document.currentScript;
  var CHANNEL_ID = scriptTag && scriptTag.getAttribute('data-channel-id');
  var SERVER = scriptTag && scriptTag.getAttribute('data-server');

  if (!CHANNEL_ID || !SERVER) {
    console.error('[LoopWidget] data-channel-id and data-server attributes are required.');
    return;
  }

  // Strip trailing slash
  SERVER = SERVER.replace(/\/+$/, '');

  var CFG = {
    position: (scriptTag && scriptTag.getAttribute('data-position')) || 'bottom-right',
    primaryColor: (scriptTag && scriptTag.getAttribute('data-primary-color')) || '#6366f1',
    title: (scriptTag && scriptTag.getAttribute('data-title')) || 'Chat',
    subtitle: (scriptTag && scriptTag.getAttribute('data-subtitle')) || 'Ask us anything',
    welcome: (scriptTag && scriptTag.getAttribute('data-welcome')) || '',
    placeholder: (scriptTag && scriptTag.getAttribute('data-placeholder')) || 'Type your message...',
  };

  // --- Session persistence ---
  var SESSION_KEY = 'loop_widget_session_' + CHANNEL_ID;

  function getSessionId() {
    try {
      return sessionStorage.getItem(SESSION_KEY);
    } catch (_) {
      return null;
    }
  }

  function setSessionId(id) {
    try {
      sessionStorage.setItem(SESSION_KEY, id);
    } catch (_) {
      // ignore
    }
  }

  // --- State ---
  var ws = null;
  var isOpen = false;
  var isConnected = false;
  var messages = [];
  var reconnectTimer = null;
  var reconnectDelay = 1000;

  // --- Styles ---
  var STYLES = (function () {
    var pos = CFG.position === 'bottom-left' ? 'left: 20px;' : 'right: 20px;';
    var chatPos = CFG.position === 'bottom-left' ? 'left: 20px;' : 'right: 20px;';
    return (
      '\n' +
      '#loop-widget-toggle {\n' +
      '  position: fixed; bottom: 20px; ' + pos + '\n' +
      '  width: 56px; height: 56px; border-radius: 50%;\n' +
      '  background: ' + CFG.primaryColor + ';\n' +
      '  color: #fff; border: none; cursor: pointer;\n' +
      '  box-shadow: 0 4px 12px rgba(0,0,0,0.25);\n' +
      '  z-index: 999998; display: flex; align-items: center; justify-content: center;\n' +
      '  transition: transform 0.2s, box-shadow 0.2s;\n' +
      '}\n' +
      '#loop-widget-toggle:hover { transform: scale(1.08); box-shadow: 0 6px 20px rgba(0,0,0,0.3); }\n' +
      '#loop-widget-toggle svg { width: 26px; height: 26px; fill: #fff; }\n' +
      '\n' +
      '#loop-widget-panel {\n' +
      '  position: fixed; bottom: 88px; ' + chatPos + '\n' +
      '  width: 380px; max-width: calc(100vw - 32px);\n' +
      '  height: 520px; max-height: calc(100vh - 110px);\n' +
      '  background: #fff; border-radius: 16px;\n' +
      '  box-shadow: 0 8px 30px rgba(0,0,0,0.18);\n' +
      '  z-index: 999999; display: none; flex-direction: column;\n' +
      '  overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;\n' +
      '  font-size: 14px; color: #1a1a2e;\n' +
      '}\n' +
      '#loop-widget-panel.open { display: flex; }\n' +
      '\n' +
      '#loop-widget-header {\n' +
      '  background: ' + CFG.primaryColor + '; color: #fff;\n' +
      '  padding: 16px 18px; flex-shrink: 0;\n' +
      '}\n' +
      '#loop-widget-header h3 { margin: 0; font-size: 16px; font-weight: 600; }\n' +
      '#loop-widget-header p { margin: 4px 0 0; font-size: 12px; opacity: 0.85; }\n' +
      '#loop-widget-status {\n' +
      '  display: inline-block; width: 8px; height: 8px; border-radius: 50%;\n' +
      '  margin-right: 6px; vertical-align: middle;\n' +
      '}\n' +
      '#loop-widget-status.connected { background: #4ade80; }\n' +
      '#loop-widget-status.disconnected { background: #f87171; }\n' +
      '#loop-widget-status.connecting { background: #facc15; }\n' +
      '\n' +
      '#loop-widget-messages {\n' +
      '  flex: 1; overflow-y: auto; padding: 14px;\n' +
      '  display: flex; flex-direction: column; gap: 8px;\n' +
      '}\n' +
      '.loop-msg {\n' +
      '  max-width: 82%; padding: 10px 14px; border-radius: 14px;\n' +
      '  line-height: 1.45; word-break: break-word; white-space: pre-wrap;\n' +
      '}\n' +
      '.loop-msg.user {\n' +
      '  align-self: flex-end; background: ' + CFG.primaryColor + '; color: #fff;\n' +
      '  border-bottom-right-radius: 4px;\n' +
      '}\n' +
      '.loop-msg.bot {\n' +
      '  align-self: flex-start; background: #f1f3f5; color: #1a1a2e;\n' +
      '  border-bottom-left-radius: 4px;\n' +
      '}\n' +
      '.loop-msg.system {\n' +
      '  align-self: center; background: transparent; color: #888;\n' +
      '  font-size: 12px; font-style: italic; padding: 4px;\n' +
      '}\n' +
      '.loop-typing {\n' +
      '  align-self: flex-start; padding: 10px 18px;\n' +
      '  background: #f1f3f5; border-radius: 14px;\n' +
      '  border-bottom-left-radius: 4px;\n' +
      '  display: none;\n' +
      '}\n' +
      '.loop-typing.visible { display: block; }\n' +
      '.loop-typing span {\n' +
      '  display: inline-block; width: 7px; height: 7px;\n' +
      '  background: #aaa; border-radius: 50%; margin: 0 2px;\n' +
      '  animation: loop-bounce 1.2s infinite;\n' +
      '}\n' +
      '.loop-typing span:nth-child(2) { animation-delay: 0.2s; }\n' +
      '.loop-typing span:nth-child(3) { animation-delay: 0.4s; }\n' +
      '@keyframes loop-bounce {\n' +
      '  0%, 60%, 100% { transform: translateY(0); }\n' +
      '  30% { transform: translateY(-6px); }\n' +
      '}\n' +
      '\n' +
      '#loop-widget-input-area {\n' +
      '  display: flex; padding: 10px 12px; border-top: 1px solid #e5e7eb;\n' +
      '  background: #fafafa; flex-shrink: 0; gap: 8px;\n' +
      '}\n' +
      '#loop-widget-input {\n' +
      '  flex: 1; border: 1px solid #d1d5db; border-radius: 20px;\n' +
      '  padding: 8px 16px; font-size: 14px; outline: none;\n' +
      '  font-family: inherit; resize: none;\n' +
      '}\n' +
      '#loop-widget-input:focus { border-color: ' + CFG.primaryColor + '; }\n' +
      '#loop-widget-send {\n' +
      '  width: 38px; height: 38px; border-radius: 50%;\n' +
      '  background: ' + CFG.primaryColor + '; border: none;\n' +
      '  cursor: pointer; display: flex; align-items: center; justify-content: center;\n' +
      '  flex-shrink: 0;\n' +
      '}\n' +
      '#loop-widget-send:disabled { opacity: 0.5; cursor: not-allowed; }\n' +
      '#loop-widget-send svg { width: 18px; height: 18px; fill: #fff; }\n' +
      '\n' +
      '#loop-widget-powered {\n' +
      '  text-align: center; font-size: 10px; color: #aaa;\n' +
      '  padding: 4px 0 8px; background: #fafafa;\n' +
      '}\n'
    );
  })();

  // --- DOM ---
  function createWidget() {
    // Inject styles
    var style = document.createElement('style');
    style.textContent = STYLES;
    document.head.appendChild(style);

    // Toggle button
    var toggle = document.createElement('button');
    toggle.id = 'loop-widget-toggle';
    toggle.setAttribute('aria-label', 'Open chat');
    toggle.innerHTML =
      '<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12z"/><path d="M7 9h2v2H7zm4 0h2v2h-2zm4 0h2v2h-2z"/></svg>';
    document.body.appendChild(toggle);

    // Chat panel
    var panel = document.createElement('div');
    panel.id = 'loop-widget-panel';
    panel.innerHTML =
      '<div id="loop-widget-header">' +
      '  <h3><span id="loop-widget-status" class="disconnected"></span>' +
      escapeHtml(CFG.title) +
      '</h3>' +
      '  <p>' +
      escapeHtml(CFG.subtitle) +
      '</p>' +
      '</div>' +
      '<div id="loop-widget-messages"></div>' +
      '<div id="loop-widget-input-area">' +
      '  <input id="loop-widget-input" type="text" placeholder="' +
      escapeHtml(CFG.placeholder) +
      '" autocomplete="off" />' +
      '  <button id="loop-widget-send" aria-label="Send" disabled>' +
      '    <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>' +
      '  </button>' +
      '</div>' +
      '<div id="loop-widget-powered">Powered by Loop Gateway</div>';
    document.body.appendChild(panel);

    // Events
    toggle.addEventListener('click', function () {
      isOpen = !isOpen;
      panel.classList.toggle('open', isOpen);
      if (isOpen && !ws) connectWs();
      if (isOpen) {
        var input = document.getElementById('loop-widget-input');
        if (input) input.focus();
      }
    });

    var input = document.getElementById('loop-widget-input');
    var sendBtn = document.getElementById('loop-widget-send');

    input.addEventListener('input', function () {
      sendBtn.disabled = !input.value.trim() || !isConnected;
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    sendBtn.addEventListener('click', sendMessage);
  }

  // --- WebSocket ---
  function connectWs() {
    if (ws) return;

    setStatusIndicator('connecting');

    var proto = SERVER.indexOf('https') === 0 ? 'wss:' : 'ws:';
    var host = SERVER.replace(/^https?:\/\//, '');
    var sessionId = getSessionId();
    var url = proto + '//' + host + '/widget/' + CHANNEL_ID;
    if (sessionId) url += '?sessionId=' + encodeURIComponent(sessionId);

    ws = new WebSocket(url);

    ws.onopen = function () {
      isConnected = true;
      reconnectDelay = 1000;
      setStatusIndicator('connected');
      updateSendButton();
    };

    ws.onmessage = function (e) {
      try {
        var data = JSON.parse(e.data);
        handleMessage(data);
      } catch (_) {
        // ignore
      }
    };

    ws.onclose = function (e) {
      ws = null;
      isConnected = false;
      setStatusIndicator('disconnected');
      updateSendButton();

      // Don't reconnect on policy violations
      if (e.code === 4003 || e.code === 4004) {
        addSystemMessage('Connection refused: ' + (e.reason || 'unknown'));
        return;
      }

      // Auto-reconnect with backoff if panel is open
      if (isOpen) {
        reconnectTimer = setTimeout(function () {
          connectWs();
        }, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 15000);
      }
    };

    ws.onerror = function () {
      // onclose will handle cleanup
    };
  }

  function handleMessage(data) {
    switch (data.type) {
      case 'connected':
        if (data.sessionId) setSessionId(data.sessionId);
        // Apply server config if available
        if (data.config) {
          if (data.config.welcomeMessage && messages.length === 0) {
            addBotMessage(data.config.welcomeMessage);
          }
        } else if (CFG.welcome && messages.length === 0) {
          addBotMessage(CFG.welcome);
        }
        break;
      case 'message':
        hideTyping();
        addBotMessage(data.text || '');
        break;
    }
  }

  function sendMessage() {
    var input = document.getElementById('loop-widget-input');
    var text = input.value.trim();
    if (!text || !ws || ws.readyState !== 1) return;

    ws.send(JSON.stringify({ type: 'message', text: text }));
    addUserMessage(text);
    input.value = '';
    document.getElementById('loop-widget-send').disabled = true;
    showTyping();
  }

  // --- Message rendering ---
  function addUserMessage(text) {
    messages.push({ role: 'user', text: text });
    appendMessage('user', text);
  }

  function addBotMessage(text) {
    messages.push({ role: 'bot', text: text });
    appendMessage('bot', text);
  }

  function addSystemMessage(text) {
    messages.push({ role: 'system', text: text });
    appendMessage('system', text);
  }

  function appendMessage(role, text) {
    var container = document.getElementById('loop-widget-messages');
    if (!container) return;
    var div = document.createElement('div');
    div.className = 'loop-msg ' + role;
    div.textContent = text;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  function showTyping() {
    var container = document.getElementById('loop-widget-messages');
    if (!container) return;
    var existing = container.querySelector('.loop-typing');
    if (!existing) {
      var typing = document.createElement('div');
      typing.className = 'loop-typing visible';
      typing.innerHTML = '<span></span><span></span><span></span>';
      container.appendChild(typing);
    } else {
      existing.classList.add('visible');
    }
    container.scrollTop = container.scrollHeight;
  }

  function hideTyping() {
    var container = document.getElementById('loop-widget-messages');
    if (!container) return;
    var typing = container.querySelector('.loop-typing');
    if (typing) typing.remove();
  }

  function setStatusIndicator(status) {
    var el = document.getElementById('loop-widget-status');
    if (el) {
      el.className = status;
    }
  }

  function updateSendButton() {
    var input = document.getElementById('loop-widget-input');
    var btn = document.getElementById('loop-widget-send');
    if (input && btn) {
      btn.disabled = !input.value.trim() || !isConnected;
    }
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // --- Init ---
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createWidget);
  } else {
    createWidget();
  }
})();
