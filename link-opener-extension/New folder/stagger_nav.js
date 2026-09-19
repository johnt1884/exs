// -----------------------------
// STAGGERED NAVIGATION & CLIPBOARD CONTROLLER
// -----------------------------
(async () => {
    'use strict';

    const CLIPBOARD_KEY = 'tmk_internal_clipboard';
    let pollInterval = null;

    function isContextValid() {
        try {
            return typeof chrome !== "undefined" && !!chrome.runtime && !!chrome.runtime.id && !!chrome.storage && !!chrome.storage.local;
        } catch (e) {
            return false;
        }
    }

    // --- Robust Messaging ---
    async function safeSendMessage(message) {
        if (!isContextValid()) return null;
        try {
            return await chrome.runtime.sendMessage(message);
        } catch (e) {
            return null;
        }
    }

    // --- UI Helpers ---
    function showNotification(msg, color = '#fff', duration = 3000) {
        let container = document.getElementById('tmk-notification-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'tmk-notification-container';
            Object.assign(container.style, {
                all: 'initial', position: 'fixed', bottom: '20px', right: '20px', zIndex: 2000000,
                maxWidth: '300px', fontSize: '14px', lineHeight: '1.3', fontFamily: 'Arial, sans-serif'
            });
            document.body.appendChild(container);
        }
        const note = document.createElement('div');
        Object.assign(note.style, {
            all: 'initial', display: 'block', padding: '10px 15px', background: 'rgba(0,0,0,0.85)', color: color,
            borderRadius: '6px', marginBottom: '10px', boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
            opacity: '0', transform: 'translateY(20px)', transition: 'opacity 0.3s ease, transform 0.3s ease',
            fontSize: '13px', lineHeight: '1.4', fontFamily: 'Arial, sans-serif', boxSizing: 'border-box'
        });
        note.textContent = msg;
        container.appendChild(note);
        requestAnimationFrame(() => { note.style.opacity = '1'; note.style.transform = 'translateY(0)'; });
        setTimeout(() => {
            note.style.opacity = '0'; note.style.transform = 'translateY(20px)';
            setTimeout(() => note.remove(), 300);
        }, duration);
    }

    // --- Clipboard Controller ---
    function createClipboardIcon(id) {
        const icon = document.createElement('div');
        icon.id = id;
        icon.title = 'Add Current URL to List';
        Object.assign(icon.style, {
            all: 'initial', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff', opacity: '0.7', transition: 'opacity 0.2s', pointerEvents: 'auto',
            width: '28px', height: '28px', boxSizing: 'border-box'
        });

        icon.innerHTML = `<svg width="22" height="22" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M14 10C14 8.89543 14.8954 8 16 8H32C33.1046 8 34 8.89543 34 10V12H14V10Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/>
            <path d="M40 20V41C40 42.1046 39.1046 43 38 43H10C8.89543 43 8 42.1046 8 41V14C8 12.8954 8.89543 12 10 12H14V16H34V12H38C39.1046 12 40 12.8954 40 14V17" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M16 25H32" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 33H32" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

        icon.onmouseover = () => icon.style.opacity = '1';
        icon.onmouseout = () => icon.style.opacity = '0.7';

        icon.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const url = location.href.split('?')[0];
            try {
                const current = JSON.parse(localStorage.getItem(CLIPBOARD_KEY) || '[]');
                if (!current.includes(url)) {
                    const merged = [...current, url];
                    localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(merged));
                    navigator.clipboard.writeText(merged.join('\n')).catch(() => {});
                    showNotification(`Added current video to list.\nTotal: ${merged.length}`, '#4ecdc4');
                } else {
                    showNotification("URL already in list.", "#ff6b6b");
                }
            } catch (err) { console.error("Clipboard icon failed", err); }
        };
        return icon;
    }

    // --- Injection Logic ---
    function injectVideoClipboardIcon() {
        if (!location.pathname.includes('/video/')) {
            const existing = document.getElementById('tmk-video-clipboard-icon-v2');
            if (existing) existing.remove();
            return;
        }
        
        const usernameTarget = document.querySelector('span[data-e2e="browse-username"]');
        const fallbackTarget = document.querySelector('div[class*="DivAvatarActionItemContainer"]') || 
                               document.querySelector('section[class*="SectionActionBarContainer"]');

        if (!usernameTarget && !fallbackTarget) return;

        let icon = document.getElementById('tmk-video-clipboard-icon-v2');
        const desiredParent = usernameTarget ? usernameTarget.parentElement : (fallbackTarget ? fallbackTarget.parentElement : null);
        
        if (icon) {
            if (icon.parentElement === desiredParent && document.body.contains(icon)) return;
            icon.remove();
        }

        const wrapper = document.createElement('span');
        Object.assign(wrapper.style, { display: 'inline-block', verticalAlign: 'middle', boxSizing: 'border-box' });
        
        icon = createClipboardIcon('tmk-video-clipboard-icon-v2');
        wrapper.appendChild(icon);

        if (usernameTarget) {
            wrapper.style.marginLeft = '8px';
            usernameTarget.insertAdjacentElement('afterend', wrapper);
        } else if (fallbackTarget) {
            wrapper.style.marginBottom = '10px';
            wrapper.style.display = 'block';
            fallbackTarget.parentNode.insertBefore(wrapper, fallbackTarget);
        }
    }

    function injectStoryOptions() {
        const isStoryViewer = !!document.querySelector('#stories-player > div.css-1dux0b3 > button');
        if (!isStoryViewer) {
            const existing = document.getElementById('tmk-story-options-v2');
            if (existing) existing.remove();
            return;
        }

        if (document.getElementById('tmk-story-options-v2')) return;

        const options = document.createElement('div');
        options.id = 'tmk-story-options-v2';
        Object.assign(options.style, {
            position: 'fixed', top: '4.5rem', right: '1rem', zIndex: 999999,
            display: 'flex', gap: '10px', alignItems: 'center', boxSizing: 'border-box'
        });

        const iconAppend = createClipboardIcon('tmk-story-append-icon');
        iconAppend.title = 'Add Current URL to List';
        iconAppend.onclick = (e) => {
            e.stopPropagation();
            const url = location.href.split('?')[0];
            const current = JSON.parse(localStorage.getItem(CLIPBOARD_KEY) || '[]');
            if (!current.includes(url)) {
                const merged = [...current, url];
                localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(merged));
                navigator.clipboard.writeText(merged.join('\n')).catch(() => {});
                showNotification(`Added current story to list.\nURL: ${url}\nTotal: ${merged.length}`, '#4ecdc4');
            } else {
                showNotification(`URL already in list.\nURL: ${url}\nTotal: ${current.length}`, '#ff6b6b');
            }
        };

        const iconClear = createClipboardIcon('tmk-story-clear-icon');
        iconClear.title = 'Clear List & Copy Current URL';
        iconClear.style.color = '#ff4d4d';
        iconClear.onclick = (e) => {
            e.stopPropagation();
            if (confirm('Are you sure you want to clear the current list and copy this URL?')) {
                const url = location.href.split('?')[0];
                localStorage.setItem(CLIPBOARD_KEY, JSON.stringify([url]));
                navigator.clipboard.writeText(url).catch(() => {});
                showNotification("Cleared list and copied current story.", "#4ecdc4");
            }
        };

        options.appendChild(iconAppend);
        options.appendChild(iconClear);
        document.body.appendChild(options);
    }

    // --- Staggered Navigation Logic ---
    function createForwardBtn() {
        if (document.getElementById("stagger-forward-btn")) return;
        const btn = document.createElement("button");
        btn.id = "stagger-forward-btn";
        btn.textContent = ">>";
        btn.title = "Progress to Next Link";
        Object.assign(btn.style, {
            all: "initial", position: "fixed", right: "20px", top: "50%", transform: "translateY(-50%)",
            zIndex: "999999", width: "50px", height: "50px", display: "flex",
            alignItems: "center", justifyContent: "center", fontSize: "20px",
            background: "#000", color: "#fff", border: "2px solid #fff",
            borderRadius: "50%", cursor: "pointer", opacity: "0.7", boxSizing: "border-box",
            fontFamily: "monospace"
        });

        btn.onclick = () => safeSendMessage({ type: "NEXT_STAGGERED" });
        document.body.appendChild(btn);
    }

    function createCounter(current, total) {
        let counter = document.getElementById("stagger-counter");
        if (counter) {
            counter.textContent = `${String(current).padStart(2, '0')}/${String(total).padStart(2, '0')}`;
            return;
        }
        counter = document.createElement("div");
        counter.id = "stagger-counter";
        counter.textContent = `${String(current).padStart(2, '0')}/${String(total).padStart(2, '0')}`;
        Object.assign(counter.style, {
            all: "initial", position: "fixed", top: "20px", right: "135px", zIndex: "999999",
            background: "rgba(0, 0, 0, 0.7)", color: "#fff", padding: "5px 10px",
            borderRadius: "5px", fontSize: "16px", fontWeight: "bold", fontFamily: "monospace",
            boxSizing: "border-box", display: "block"
        });
        document.body.appendChild(counter);
    }

    async function startStaggeredPolling() {
        if (pollInterval) clearInterval(pollInterval);
        if (!isContextValid()) return;

        const res = await chrome.storage.local.get(["automatic_load_enabled", "fast_mode_enabled", "staggered_scan_baselines"]);
        if (!res.automatic_load_enabled) return;

        const baselines = res.staggered_scan_baselines || {};
        const handleMatch = location.pathname.match(/^\/(@[^/]+)/);
        const handle = handleMatch ? handleMatch[1] : null;
        const baseline = handle ? (baselines[`tiktok_last_post:${handle}`] || 0) : Infinity;

        let pollCount = 0;
        pollInterval = setInterval(() => {
            if (!isContextValid()) { clearInterval(pollInterval); return; }
            pollCount++;
            
            const newCountElement = document.getElementById('tt-thumb-meta__new-count');
            if (newCountElement && parseInt(newCountElement.textContent) > 0) {
                clearInterval(pollInterval);
                safeSendMessage({ type: "PLAY_SOUND", sound: "new_videos" });
                return;
            }

            const links = document.querySelectorAll('a[href*="/video/"], a[href*="/photo/"]');
            let foundNew = false;
            for (const a of links) {
                const postIdMatch = a.href.match(/\/(?:video|photo)\/(\d{10,})/);
                if (postIdMatch) {
                    try {
                        const ts = Number(BigInt(postIdMatch[1]) >> 32n) * 1000;
                        if (ts > baseline) { foundNew = true; break; }
                    } catch(e) {}
                }
            }

            if (foundNew) {
                clearInterval(pollInterval);
                safeSendMessage({ type: "PLAY_SOUND", sound: "new_videos" });
                return;
            }

            const pollThreshold = res.fast_mode_enabled ? 1 : 3;
            if (pollCount >= pollThreshold && document.querySelectorAll('[data-e2e="user-post-item"]').length > 0) {
                clearInterval(pollInterval);
                const delay = res.fast_mode_enabled ? 200 : Math.floor(Math.random() * 2000) + 1000;
                setTimeout(() => safeSendMessage({ type: "NEXT_STAGGERED" }), delay);
            }
        }, 1000);
    }

    // --- Init ---
    function init() {
        if (!document.body) { setTimeout(init, 50); return; }

        let pending = false;
        const observer = new MutationObserver(() => {
            if (pending) return;
            pending = true;
            requestAnimationFrame(() => {
                pending = false;
                injectVideoClipboardIcon();
                injectStoryOptions();
            });
        });
        observer.observe(document.body, { childList: true, subtree: true });
        
        injectVideoClipboardIcon();
        injectStoryOptions();

        setInterval(() => {
            injectVideoClipboardIcon();
            injectStoryOptions();
        }, 1500);

        (async () => {
            const response = await safeSendMessage({ type: "CHECK_STAGGERED" });
            if (response && response.isStaggered) {
                createForwardBtn();
                createCounter(response.currentIndex, response.total);

                try {
                    const notify = localStorage.getItem('stagger_append_notify');
                    if (notify) {
                        const data = JSON.parse(notify);
                        localStorage.removeItem('stagger_append_notify');
                        showNotification(`Appended ${data.appended} link(s).\nTotal in memory: ${data.total}`, '#4ecdc4');
                    }
                } catch (e) {}

                startStaggeredPolling();
            }
        })();
    }

    init();
})();
