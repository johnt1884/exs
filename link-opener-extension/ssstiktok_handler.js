(async () => {
    'use strict';

    const CLIPBOARD_KEY = 'tmk_internal_clipboard';
    const SEEN_IDS_KEY = 'tmk_seen_video_ids';

    function isContextValid() {
        try {
            return typeof chrome !== "undefined" && !!chrome.runtime && !!chrome.runtime.id &&
                   !!chrome.storage && !!chrome.storage.local;
        } catch (e) {
            return false;
        }
    }

    function showNotification(msg, color = '#fff', duration = 3000) {
        let container = document.getElementById('tmk-notification-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'tmk-notification-container';
            Object.assign(container.style, {
                position: 'fixed', bottom: '20px', right: '20px', zIndex: 999999,
                maxWidth: '300px', fontSize: '14px', lineHeight: '1.3', pointerEvents: 'none'
            });
            document.body.appendChild(container);
        }
        const note = document.createElement('div');
        Object.assign(note.style, {
            padding: '10px 15px', background: `rgba(0,0,0,0.85)`, color: color,
            borderRadius: '6px', marginBottom: '10px', boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
            opacity: '0', transform: 'translateY(20px)', transition: 'opacity 0.3s ease, transform 0.3s ease',
            pointerEvents: 'auto', whiteSpace: 'pre-wrap'
        });
        note.textContent = msg;
        container.appendChild(note);
        requestAnimationFrame(() => {
            note.style.opacity = '1';
            note.style.transform = 'translateY(0)';
        });
        setTimeout(() => {
            note.style.opacity = '0';
            note.style.transform = 'translateY(20px)';
            setTimeout(() => note.remove(), 300);
        }, duration);
    }

    // Stored in chrome.storage.local (shared across all domains the
    // extension runs on - tiktok.com, ssstiktok.dev) instead of
    // localStorage, which is per-origin and would otherwise keep the two
    // sites' lists completely separate.
    async function getInternalClipboard() {
        if (!isContextValid()) return [];
        try {
            const res = await chrome.storage.local.get(CLIPBOARD_KEY);
            return res[CLIPBOARD_KEY] || [];
        } catch (e) { return []; }
    }

    async function saveInternalClipboard(list) {
        if (isContextValid()) {
            try {
                await chrome.storage.local.set({ [CLIPBOARD_KEY]: list });
            } catch (e) {}
        }
        navigator.clipboard.writeText(list.join('\n')).catch(() => {});
    }

    let currentUsername = '';

    async function handleAutoSearch() {
        if (!location.hash.startsWith('#username=')) return;
        const username = location.hash.split('=')[1];
        if (!username) return;

        currentUsername = username;

        const input = document.getElementById('s_input');
        const form = document.getElementById('search-form');
        const btn = form ? form.querySelector('button') : null;

        if (input && btn) {
            input.value = username;
            // Clear hash so we don't search again on reload
            history.replaceState(null, null, ' ');
            btn.click();
        }
    }

    let selectedUrls = new Set();

    function updateMultiSelect() {
        let menu = document.getElementById('tmk-ssstiktok-menu');
        if (selectedUrls.size === 0) {
            if (menu) menu.remove();
            return;
        }

        if (!menu) {
            menu = document.createElement('div');
            menu.id = 'tmk-ssstiktok-menu';
            Object.assign(menu.style, {
                position: 'fixed', top: '20px', right: '20px', zIndex: 999999,
                background: 'rgba(0,0,0,0.85)', padding: '15px', borderRadius: '8px',
                color: '#fff', fontSize: '14px', boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
                display: 'flex', flexDirection: 'column', gap: '10px'
            });
            document.body.appendChild(menu);
        }

        menu.innerHTML = `
            <div style="font-weight:bold;">Selected: ${selectedUrls.size}</div>
            <a href="#" id="tmk-ss-append" style="color:#4ecdc4; text-decoration:none;">Copy Selected (Append)</a>
            <a href="#" id="tmk-ss-clear" style="color:#00f2ea; text-decoration:none;">Copy Selected (Clear)</a>
        `;

        menu.querySelector('#tmk-ss-append').onclick = async (e) => {
            e.preventDefault();
            const current = await getInternalClipboard();
            const next = Array.from(new Set([...current, ...selectedUrls]));
            await saveInternalClipboard(next);
            showNotification(`Appended ${selectedUrls.size} items.\nTotal: ${next.length}`, '#4ecdc4');
        };

        menu.querySelector('#tmk-ss-clear').onclick = async (e) => {
            e.preventDefault();
            const next = Array.from(selectedUrls);
            await saveInternalClipboard(next);
            showNotification(`Cleared and saved ${selectedUrls.size} items.`, '#00f2ea');
        };
    }

    async function injectControls() {
        const dlLinks = document.querySelectorAll('a.pro-dl-link');
        
        // Try multiple ways to get the username
        let username = currentUsername;
        if (!username) {
            const usernameLabel = document.querySelector('.profile-name');
            if (usernameLabel) username = usernameLabel.textContent.trim().replace('@', '');
        }
        if (!username) {
            const input = document.getElementById('s_input');
            if (input && input.value && !input.value.includes('http')) {
                username = input.value.trim();
            }
        }

        const res = await chrome.storage.local.get(SEEN_IDS_KEY);
        const seenIds = new Set(res[SEEN_IDS_KEY] || []);
        let updatedSeen = false;

        dlLinks.forEach(link => {
            if (link.dataset.tmkProcessed) return;
            link.dataset.tmkProcessed = "true";

            const fileName = link.getAttribute('data-name') || '';
            const idMatch = fileName.match(/_(\d+)\.mp4/);
            const videoId = idMatch ? idMatch[1] : null;
            if (!videoId) return;

            const tiktokUrl = `https://www.tiktok.com/@user/video/${videoId}`; // fallback if username not found
            const finalUrl = username ? `https://www.tiktok.com/@${username}/video/${videoId}` : tiktokUrl;

            // New video detection
            if (!seenIds.has(videoId)) {
                link.style.outline = '3px solid yellow';
                seenIds.add(videoId);
                updatedSeen = true;
            }

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.style.marginRight = '8px';
            cb.style.transform = 'scale(1.5)';
            cb.style.verticalAlign = 'middle';
            
            cb.onchange = () => {
                if (cb.checked) selectedUrls.add(finalUrl);
                else selectedUrls.delete(finalUrl);
                updateMultiSelect();
            };

            link.parentNode.insertBefore(cb, link);
        });

        if (updatedSeen) {
            chrome.storage.local.set({ [SEEN_IDS_KEY]: Array.from(seenIds) });
        }
    }

    handleAutoSearch();
    const observer = new MutationObserver(injectControls);
    observer.observe(document.body, { childList: true, subtree: true });
    injectControls();

})();
