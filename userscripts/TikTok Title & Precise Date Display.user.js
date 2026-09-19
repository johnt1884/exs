// ==UserScript==
// @name         TikTok Title & Precise Date Display
// @namespace    http://tampermonkey.net/
// @description  Injects a bold title and a smaller upload precise date below TikTok video and photo thumbnails on TikTok profile pages.
// @author       Homebrew Runner
// @version      0.2.2
// @match        https://www.tiktok.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.registerMenuCommand
// @license      MIT
// @downloadURL https://update.greasyfork.org/scripts/571250/TikTok%20Title%20%20Precise%20Date%20Display.user.js
// @updateURL https://update.greasyfork.org/scripts/571250/TikTok%20Title%20%20Precise%20Date%20Display.meta.js
// ==/UserScript==

(async () => {
  'use strict';

  const SCRIPT_ID = 'tt-thumb-meta';
  const STORAGE_KEY = `${SCRIPT_ID}:settings`;
  const POST_PATH_RE = /\/(?:video|photo)\/(\d{10,})/;

  const DEFAULT_SETTINGS = {
    hourFormat: '12', // '12' or '24'
    maxTitleLength: 42,
  };

  let settings = { ...DEFAULT_SETTINGS };
  let mutationObserver = null;
  let processTimer = null;
  let lastUrl = location.href;

  let currentProfile = null;
  let lastSeenMaxDate = 0;
  let sessionMaxDate = 0;

  const gmApi = typeof GM !== 'undefined' ? GM : null;

  const gm = {
    async get(key, fallbackValue) {
      try {
        if (gmApi && typeof gmApi.getValue === 'function') {
          return await gmApi.getValue(key, fallbackValue);
        }
      } catch (error) {
        console.warn(`[${SCRIPT_ID}] GM.getValue failed`, error);
      }

      try {
        if (typeof GM_getValue === 'function') {
          return GM_getValue(key, fallbackValue);
        }
      } catch (error) {
        console.warn(`[${SCRIPT_ID}] GM_getValue failed`, error);
      }

      try {
        const raw = localStorage.getItem(key);
        return raw === null ? fallbackValue : JSON.parse(raw);
      } catch (error) {
        console.warn(`[${SCRIPT_ID}] localStorage read failed`, error);
        return fallbackValue;
      }
    },

    async set(key, value) {
      try {
        if (gmApi && typeof gmApi.setValue === 'function') {
          await gmApi.setValue(key, value);
          return;
        }
      } catch (error) {
        console.warn(`[${SCRIPT_ID}] GM.setValue failed`, error);
      }

      try {
        if (typeof GM_setValue === 'function') {
          GM_setValue(key, value);
          return;
        }
      } catch (error) {
        console.warn(`[${SCRIPT_ID}] GM_setValue failed`, error);
      }

      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (error) {
        console.warn(`[${SCRIPT_ID}] localStorage write failed`, error);
      }
    },

    menu(label, handler) {
      try {
        if (gmApi && typeof gmApi.registerMenuCommand === 'function') {
          gmApi.registerMenuCommand(label, handler);
          return;
        }
      } catch (error) {
        console.warn(`[${SCRIPT_ID}] GM.registerMenuCommand failed`, error);
      }

      try {
        if (typeof GM_registerMenuCommand === 'function') {
          GM_registerMenuCommand(label, handler);
        }
      } catch (error) {
        console.warn(`[${SCRIPT_ID}] GM_registerMenuCommand failed`, error);
      }
    },
  };

  function clampNumber(value, min, max, fallbackValue) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallbackValue;
    return Math.min(max, Math.max(min, Math.round(numeric)));
  }

  function sanitizeSettings(candidate) {
    const safe = { ...DEFAULT_SETTINGS, ...(candidate || {}) };
    safe.hourFormat = safe.hourFormat === '24' ? '24' : '12';
    safe.maxTitleLength = clampNumber(safe.maxTitleLength, 8, 200, DEFAULT_SETTINGS.maxTitleLength);
    return safe;
  }

  async function loadSettings() {
    const stored = await gm.get(STORAGE_KEY, DEFAULT_SETTINGS);
    settings = sanitizeSettings(stored);
  }

  async function loadProfileData() {
    const handle = getProfileHandle();
    if (!handle) {
      currentProfile = null;
      lastSeenMaxDate = 0;
      sessionMaxDate = 0;
      return;
    }

    if (handle === currentProfile) return;

    currentProfile = handle;
    const key = `${SCRIPT_ID}:profile:${handle}`;
    lastSeenMaxDate = await gm.get(key, 0);
    sessionMaxDate = lastSeenMaxDate;
  }

  async function saveProfileData() {
    if (!currentProfile || sessionMaxDate <= lastSeenMaxDate) return;

    const key = `${SCRIPT_ID}:profile:${currentProfile}`;
    await gm.set(key, sessionMaxDate);
  }

  async function saveSettings() {
    settings = sanitizeSettings(settings);
    await gm.set(STORAGE_KEY, settings);
  }

  function getProfileHandle() {
    const match = location.pathname.match(/^\/(@[^/]+)/);
    return match ? match[1] : null;
  }

  function isProfileLikePage() {
    return !!getProfileHandle();
  }

  function normalizeWhitespace(text) {
    return String(text || '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function extractPostIdFromHref(href) {
    const match = String(href || '').match(POST_PATH_RE);
    return match ? match[1] : '';
  }

  function deriveDateFromPostId(postId) {
    if (!postId) return null;

    try {
      const seconds = Number(BigInt(postId) >> 32n);
      if (!Number.isFinite(seconds)) return null;

      // Plausibility window: 2015-01-01 through 2050-01-01
      if (seconds < 1420070400 || seconds > 2524608000) return null;
      return new Date(seconds * 1000);
    } catch (error) {
      return null;
    }
  }

  function deriveDateFromThumbnailSource(sourceText) {
    const match = String(sourceText || '').match(/_(\d{10})(?=[~?])/);
    if (!match) return null;

    const seconds = Number(match[1]);
    if (!Number.isFinite(seconds) || seconds < 1420070400 || seconds > 2524608000) {
      return null;
    }

    return new Date(seconds * 1000);
  }

  function formatDate(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
      return '';
    }

    const options = {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: settings.hourFormat === '12',
      hourCycle: settings.hourFormat === '24' ? 'h23' : 'h12',
    };

    try {
      return new Intl.DateTimeFormat(undefined, options).format(date);
    } catch (error) {
      return date.toLocaleString();
    }
  }

  function extractTitleFromAlt(altText) {
    const clean = normalizeWhitespace(altText);
    if (!clean) return '';

    const marker = ' created by ';
    const markerIndex = clean.lastIndexOf(marker);
    if (markerIndex > 0) {
      return normalizeWhitespace(clean.slice(0, markerIndex));
    }

    return clean;
  }

  function smartTruncate(text, maxLength) {
    const clean = normalizeWhitespace(text);
    if (!clean) return '';
    if (clean.length <= maxLength) return clean;

    const slice = clean.slice(0, Math.max(1, maxLength - 1));
    const wordBoundary = slice.replace(/\s+\S*$/, '').trimEnd();
    const candidate = wordBoundary.length >= Math.floor(maxLength * 0.6) ? wordBoundary : slice.trimEnd();
    return `${candidate}…`;
  }

  function findPostLink(card) {
    return Array.from(card.querySelectorAll('a[href]')).find((anchor) => POST_PATH_RE.test(anchor.href)) || null;
  }

  function getCardInfo(card) {
    if (!card) return null;

    const link = findPostLink(card);
    if (!link) return null;

    const image = link.querySelector('img[alt]') || card.querySelector('img[alt]');
    const postId = extractPostIdFromHref(link.href);
    const postType = /\/photo\//.test(link.href) ? 'photo' : 'video';

    const fullTitle = extractTitleFromAlt(image?.getAttribute('alt') || '');
    const displayTitle = smartTruncate(fullTitle || 'Untitled post', settings.maxTitleLength);

    const thumbSources = [
      image?.currentSrc,
      image?.getAttribute('src'),
      image?.getAttribute('srcset'),
    ].filter(Boolean).join(' ');

    const dateObject = deriveDateFromPostId(postId) || deriveDateFromThumbnailSource(thumbSources);
    const dateLabel = formatDate(dateObject);
    const pinned = Boolean(card.querySelector('[data-e2e="video-card-badge"]'));
    const timestamp = dateObject ? dateObject.getTime() : 0;

    return {
      card,
      link,
      postId,
      postType,
      fullTitle,
      displayTitle,
      dateLabel,
      pinned,
      timestamp,
    };
  }

  function getInjectionHost(card) {
    return card.closest('[id^="grid-item-container-"]') || card.parentElement || card;
  }

  function updateNewCountDisplay(count) {
    const h2 = document.querySelector('[data-e2e="user-title"]') ||
               document.querySelector('[data-e2e="user-subtitle"]') ||
               document.querySelector('h2');
    if (!h2) return;

    let countNode = document.getElementById(`${SCRIPT_ID}__new-count`);
    if (!countNode) {
      countNode = document.createElement('span');
      countNode.id = `${SCRIPT_ID}__new-count`;
      countNode.style.marginLeft = '8px';
      countNode.style.fontSize = '0.6em';
      countNode.style.verticalAlign = 'middle';
      countNode.style.backgroundColor = 'yellow';
      countNode.style.color = 'black';
      countNode.style.padding = '2px 6px';
      countNode.style.borderRadius = '10px';
      countNode.style.cursor = 'pointer';
      countNode.style.zIndex = '999999';
      countNode.style.position = 'relative';

      countNode.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const newMetas = document.querySelectorAll(`.${SCRIPT_ID}__meta--new`);
        newMetas.forEach(meta => {
          if (meta.dataset.postType === 'photo') return; // videos only, never photos
          const host = meta.closest(`.${SCRIPT_ID}__host`);
          if (host) {
            const checkbox = host.querySelector('.tmk-custom-checkbox, .tmk-video-checkbox');
            if (checkbox && !checkbox.checked) {
              checkbox.checked = true;
              checkbox.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }
        });
      };

      h2.insertAdjacentElement('afterend', countNode);
    }

    countNode.textContent = `${count} new`;
    countNode.style.display = count > 0 ? 'inline-block' : 'none';

    // Re-verify insertion in case of SPA navigation or DOM shifts
    if (!countNode.parentElement || countNode.previousElementSibling !== h2) {
      h2.insertAdjacentElement('afterend', countNode);
    }
  }

  function createMetaNode() {
    const meta = document.createElement('div');
    meta.className = `${SCRIPT_ID}__meta`;

    const title = document.createElement('div');
    title.className = `${SCRIPT_ID}__title`;

    const date = document.createElement('div');
    date.className = `${SCRIPT_ID}__date`;

    meta.append(title, date);
    return meta;
  }

  function upsertMeta(info, isNew = false) {
    const host = getInjectionHost(info.card);
    if (!host) return;

    host.classList.add(`${SCRIPT_ID}__host`);

    let meta = Array.from(host.children).find((element) => element.classList?.contains(`${SCRIPT_ID}__meta`));
    if (!meta) {
      meta = createMetaNode();
      host.appendChild(meta);
    }

    const titleNode = meta.querySelector(`.${SCRIPT_ID}__title`);
    const dateNode = meta.querySelector(`.${SCRIPT_ID}__date`);

    meta.dataset.postId = info.postId || '';
    meta.dataset.postType = info.postType || '';
    meta.dataset.pinned = info.pinned ? '1' : '0';
    meta.dataset.new = isNew ? '1' : '0';

    if (isNew) {
      meta.classList.add(`${SCRIPT_ID}__meta--new`);
    } else {
      meta.classList.remove(`${SCRIPT_ID}__meta--new`);
    }

    titleNode.textContent = info.displayTitle;
    titleNode.setAttribute('title', info.fullTitle || info.displayTitle);

    if (info.dateLabel) {
      dateNode.textContent = info.pinned ? `Pinned • ${info.dateLabel}` : info.dateLabel;
      dateNode.hidden = false;
    } else if (info.pinned) {
      dateNode.textContent = 'Pinned';
      dateNode.hidden = false;
    } else {
      dateNode.textContent = '';
      dateNode.hidden = true;
    }

    meta.setAttribute(
      'title',
      [info.fullTitle || info.displayTitle, info.pinned ? 'Pinned' : '', info.dateLabel].filter(Boolean).join('\n')
    );
  }

  function removeAllMeta() {
    document.querySelectorAll(`.${SCRIPT_ID}__meta`).forEach((node) => node.remove());
    document.querySelectorAll(`.${SCRIPT_ID}__host`).forEach((node) => node.classList.remove(`${SCRIPT_ID}__host`));
    document.getElementById(`${SCRIPT_ID}__new-count`)?.remove();
  }

  async function processPage() {
    if (!document.body) return;

    if (!isProfileLikePage()) {
      removeAllMeta();
      return;
    }

    await loadProfileData();

    const cards = document.querySelectorAll('[data-e2e="user-post-item-list"] [data-e2e="user-post-item"]');
    if (!cards.length) {
      updateNewCountDisplay(0);
      return;
    }

    let newCount = 0;
    let pageMaxDate = 0;

    cards.forEach((card) => {
      const info = getCardInfo(card);
      if (info) {
        // Photos never count as "new" content - only videos do.
        const isNew = info.postType !== 'photo' && info.timestamp > lastSeenMaxDate;
        if (isNew) newCount++;
        if (info.postType !== 'photo' && info.timestamp > pageMaxDate) pageMaxDate = info.timestamp;

        upsertMeta(info, isNew);
      }
    });

    if (pageMaxDate > sessionMaxDate) {
      sessionMaxDate = pageMaxDate;
      void saveProfileData();
    }

    updateNewCountDisplay(newCount);
  }

  function scheduleProcess(force = false) {
    if (processTimer && !force) return;
    if (processTimer) clearTimeout(processTimer);

    processTimer = window.setTimeout(() => {
      processTimer = null;
      processPage();
    }, force ? 0 : 120);
  }

  function handleUrlChange() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    scheduleProcess(true);
  }

  function installHistoryHooks() {
    const wrap = (methodName) => {
      const original = history[methodName];
      if (typeof original !== 'function') return;

      history[methodName] = function wrappedHistoryMethod(...args) {
        const result = original.apply(this, args);
        window.dispatchEvent(new Event(`${SCRIPT_ID}:locationchange`));
        return result;
      };
    };

    wrap('pushState');
    wrap('replaceState');

    window.addEventListener('popstate', () => window.dispatchEvent(new Event(`${SCRIPT_ID}:locationchange`)));
    window.addEventListener(`${SCRIPT_ID}:locationchange`, handleUrlChange);
  }

  function installObserver() {
    if (mutationObserver) {
      mutationObserver.disconnect();
    }

    mutationObserver = new MutationObserver((mutations) => {
      if (location.href !== lastUrl) {
        handleUrlChange();
        return;
      }

      for (const mutation of mutations) {
        if (mutation.addedNodes.length || mutation.removedNodes.length) {
          scheduleProcess();
          return;
        }
      }
    });

    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  function injectStyles() {
    if (document.getElementById(`${SCRIPT_ID}__styles`)) return;

    const style = document.createElement('style');
    style.id = `${SCRIPT_ID}__styles`;
    style.textContent = `
      .${SCRIPT_ID}__host {
        overflow: visible !important;
      }

      .${SCRIPT_ID}__meta {
        margin-top: 8px;
        padding: 0 2px 2px;
        line-height: 1.28;
        color: var(--ui-text-1, rgba(22, 24, 35, 1));
        font-family: inherit;
        user-select: text;
      }

      .${SCRIPT_ID}__title {
        font-size: 14px;
        font-weight: 700;
        color: var(--ui-text-1, rgba(22, 24, 35, 1));
        overflow-wrap: anywhere;
        word-break: break-word;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }

      .${SCRIPT_ID}__date {
        margin-top: 4px;
        font-size: 12px;
        font-weight: 400;
        color: var(--ui-text-2, rgba(22, 24, 35, 0.62));
      }

      .${SCRIPT_ID}__meta--new .${SCRIPT_ID}__title,
      .${SCRIPT_ID}__meta--new .${SCRIPT_ID}__date {
        color: yellow !important;
      }
    `;

    document.head.appendChild(style);
  }

  async function promptForMaxLength() {
    const response = window.prompt('Set maximum displayed title length:', String(settings.maxTitleLength));
    if (response === null) return;

    const newValue = clampNumber(response, 8, 200, settings.maxTitleLength);
    if (newValue === settings.maxTitleLength) return;

    settings.maxTitleLength = newValue;
    await saveSettings();
    scheduleProcess(true);
  }

  async function toggleHourFormat() {
    settings.hourFormat = settings.hourFormat === '12' ? '24' : '12';
    await saveSettings();
    scheduleProcess(true);
  }

  async function resetDefaults() {
    settings = { ...DEFAULT_SETTINGS };
    await saveSettings();
    scheduleProcess(true);
  }

  function registerMenuCommands() {
    gm.menu(
      `TikTok titles: switch to ${settings.hourFormat === '12' ? '24' : '12'}-hour time`,
      () => {
        void toggleHourFormat();
      }
    );

    gm.menu(`TikTok titles: set max title length (${settings.maxTitleLength})`, () => {
      void promptForMaxLength();
    });

    gm.menu('TikTok titles: reset defaults', () => {
      void resetDefaults();
    });
  }

  await loadSettings();
  injectStyles();
  registerMenuCommands();
  installHistoryHooks();
  installObserver();

  window.addEventListener('focus', () => scheduleProcess());
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduleProcess();
  });

  scheduleProcess(true);
})();
