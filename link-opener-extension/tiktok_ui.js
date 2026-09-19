(async () => {
    'use strict';

    const CLIPBOARD_KEY = 'tmk_internal_clipboard';
    const SELECTED_VIDEOS_PREFIX = 'tmk_selected_videos:';

    function isContextValid() {
        try {
            return typeof chrome !== "undefined" && !!chrome.runtime && !!chrome.runtime.id;
        } catch (e) {
            return false;
        }
    }

    // ------------------ Notification System ------------------
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

    // ------------------ Clipboard Helpers ------------------
    // The "TikTok Video Counter + Multi-Select" userscript keeps its own
    // clipboard in localStorage (page-scoped, so only visible on
    // tiktok.com). ssstiktok.dev can't see that at all (different origin),
    // so we also keep a copy in chrome.storage.local and merge the two
    // every time - whichever side has the most recent additions "wins" and
    // both stores get resynced to match.
    async function getInternalClipboard() {
        let fromPage = [];
        try {
            const raw = localStorage.getItem(CLIPBOARD_KEY);
            fromPage = raw ? JSON.parse(raw) : [];
        } catch (e) {}

        let fromExt = [];
        if (isContextValid()) {
            try {
                const res = await chrome.storage.local.get(CLIPBOARD_KEY);
                fromExt = res[CLIPBOARD_KEY] || [];
            } catch (e) {}
        }

        const merged = Array.from(new Set([...fromPage, ...fromExt]));
        if (merged.length !== fromPage.length) {
            try { localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(merged)); } catch (e) {}
        }
        if (isContextValid() && merged.length !== fromExt.length) {
            try { await chrome.storage.local.set({ [CLIPBOARD_KEY]: merged }); } catch (e) {}
        }
        return merged;
    }

    async function saveInternalClipboard(list) {
        try { localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(list)); } catch (e) {}
        if (isContextValid()) {
            try {
                await chrome.storage.local.set({ [CLIPBOARD_KEY]: list });
            } catch (e) {}
        }
        navigator.clipboard.writeText(list.join('\n')).catch(() => {});
    }

    // ------------------ Selection State ------------------
    // Persisted per-profile so it survives page reopen/refresh. It's only
    // ever cleared by "Deselect All" or one of the "Copy Selected" actions
    // below - never by navigation or a reload.
    let selectedLinks = new Set();
    let currentSelectionHandle = null;

    async function loadSelectionForHandle(handle) {
        currentSelectionHandle = handle;
        selectedLinks = new Set();
        if (!handle || !isContextValid()) return;
        try {
            const key = SELECTED_VIDEOS_PREFIX + handle;
            const res = await chrome.storage.local.get(key);
            selectedLinks = new Set(res[key] || []);
        } catch (e) {
            console.warn("Link Batch Opener: Failed to load selected videos.", e);
        }
    }

    async function persistSelection() {
        if (!currentSelectionHandle || !isContextValid()) return;
        try {
            const key = SELECTED_VIDEOS_PREFIX + currentSelectionHandle;
            await chrome.storage.local.set({ [key]: Array.from(selectedLinks) });
        } catch (e) {
            console.warn("Link Batch Opener: Failed to persist selected videos.", e);
        }
    }

    // Re-syncs already-rendered checkboxes against selectedLinks. Needed
    // after loadSelectionForHandle resolves, in case cards for the new
    // profile were already injected (unchecked) while the load was pending.
    function restoreCheckedState() {
        document.querySelectorAll('.tmk-video-checkbox').forEach(cb => {
            const card = cb.closest('[data-e2e="user-post-item"]');
            const link = card ? card.querySelector('a[href*="/video/"], a[href*="/photo/"]') : null;
            const videoUrl = link ? link.href.split('?')[0] : null;
            if (videoUrl) cb.checked = selectedLinks.has(videoUrl);
        });
    }

    function clearSelection() {
        selectedLinks.clear();
        document.querySelectorAll('.tmk-video-checkbox, .tmk-row-checkbox').forEach(cb => cb.checked = false);
        persistSelection();
    }

    function updateMultiSelectMenu() {
        let menu = document.getElementById('tmk-multi-select-menu');
        if (selectedLinks.size === 0) {
            if (menu) menu.remove();
            return;
        }

        if (!menu) {
            menu = document.createElement('div');
            menu.id = 'tmk-multi-select-menu';
            Object.assign(menu.style, {
                position: 'fixed', top: '80px', right: '20px', zIndex: 100001,
                background: 'rgba(0,0,0,0.85)', padding: '15px', borderRadius: '8px',
                color: '#fff', fontSize: '14px', boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
                display: 'flex', flexDirection: 'column', gap: '10px', width: '220px'
            });
            document.body.appendChild(menu);
        }

        menu.innerHTML = `
            <div style="font-weight:bold; border-bottom:1px solid #444; padding-bottom:5px;">
                Selected: ${selectedLinks.size}
            </div>
            <a href="#" id="tmk-copy-append" style="color:#4ecdc4; text-decoration:none;">Copy Selected (Append)</a>
            <a href="#" id="tmk-copy-clear" style="color:#00f2ea; text-decoration:none;">Copy Selected (Clear Memory)</a>
            <a href="#" id="tmk-deselect-all" style="color:#ff6b6b; text-decoration:none;">Deselect All</a>
        `;

        menu.querySelector('#tmk-copy-append').onclick = async (e) => {
            e.preventDefault();
            const current = await getInternalClipboard();
            const next = Array.from(new Set([...current, ...selectedLinks]));
            await saveInternalClipboard(next);
            const count = selectedLinks.size;
            clearSelection();
            showNotification(`Appended ${count} links.\nTotal: ${next.length}`, '#4ecdc4');
            updateMultiSelectMenu();
        };

        menu.querySelector('#tmk-copy-clear').onclick = async (e) => {
            e.preventDefault();
            if (confirm('Clear internal clipboard and save these ' + selectedLinks.size + ' links?')) {
                const next = Array.from(selectedLinks);
                await saveInternalClipboard(next);
                const count = selectedLinks.size;
                clearSelection();
                showNotification(`Cleared and saved ${count} links.`, '#00f2ea');
                updateMultiSelectMenu();
            }
        };

        menu.querySelector('#tmk-deselect-all').onclick = (e) => {
            e.preventDefault();
            clearSelection();
            updateMultiSelectMenu();
        };
    }

    // ------------------ Profile Page Checkboxes ------------------
    function injectCheckboxes() {
        if (!location.pathname.startsWith('/@') || /\/(video|photo)\//.test(location.pathname)) return;

        const videoCards = document.querySelectorAll('[data-e2e="user-post-item"]');
        videoCards.forEach(card => {
            if (card.dataset.tmkProcessed) return;
            card.dataset.tmkProcessed = "true";

            const link = card.querySelector('a[href*="/video/"], a[href*="/photo/"]');
            if (!link) return;

            const videoUrl = link.href.split('?')[0];
            const isPhoto = /\/photo\//.test(link.href);

            card.style.position = 'relative';
            if (isPhoto) {
                // Visually flag photo posts (as opposed to videos) with a red
                // outline. We use a separate overlay element rather than
                // styling `card` directly - TikTok's own React re-renders
                // periodically reset the card's style/attributes, which was
                // wiping out a directly-applied outline shortly after it
                // appeared. An appended child (like our checkbox below,
                // which already persists fine) isn't touched by that.
                const flag = document.createElement('div');
                flag.className = 'tmk-photo-flag';
                flag.style.position = 'absolute';
                flag.style.inset = '0';
                flag.style.border = '3px solid red';
                flag.style.boxSizing = 'border-box';
                flag.style.pointerEvents = 'none';
                flag.style.zIndex = '2';
                card.appendChild(flag);
            }

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'tmk-video-checkbox';
            Object.assign(cb.style, {
                position: 'absolute', top: '10px', left: '10px', zIndex: '10',
                transform: 'scale(2)', cursor: 'pointer'
            });

            cb.checked = selectedLinks.has(videoUrl);

            cb.addEventListener('change', (e) => {
                if (cb.checked) selectedLinks.add(videoUrl);
                else selectedLinks.delete(videoUrl);
                persistSelection();
                updateMultiSelectMenu();
            });

            // Prevent link navigation when clicking checkbox
            cb.onclick = (e) => e.stopPropagation();

            card.appendChild(cb);

            // Row Selection Checkbox (Top-Right)
            const rowCb = document.createElement('input');
            rowCb.type = 'checkbox';
            rowCb.className = 'tmk-row-checkbox';
            rowCb.title = 'Select entire row';
            Object.assign(rowCb.style, {
                position: 'absolute', top: '10px', right: '10px', zIndex: '10',
                transform: 'scale(2)', cursor: 'pointer'
            });

            rowCb.addEventListener('change', () => {
                const rect = card.getBoundingClientRect();
                const currentTop = rect.top + window.scrollY;
                
                const allCards = document.querySelectorAll('[data-e2e="user-post-item"]');
                allCards.forEach(c => {
                    const cRect = c.getBoundingClientRect();
                    const cTop = cRect.top + window.scrollY;
                    
                    if (Math.abs(cTop - currentTop) < 10) { // Same row threshold
                        const innerCb = c.querySelector('.tmk-video-checkbox');
                        const innerLink = c.querySelector('a[href*="/video/"], a[href*="/photo/"]');
                        if (innerCb && innerLink) {
                            const url = innerLink.href.split('?')[0];
                            innerCb.checked = rowCb.checked;
                            if (rowCb.checked) selectedLinks.add(url);
                            else selectedLinks.delete(url);
                        }
                        
                        const innerRowCb = c.querySelector('.tmk-row-checkbox');
                        if (innerRowCb) innerRowCb.checked = rowCb.checked;
                    }
                });
                persistSelection();
                updateMultiSelectMenu();
            });

            rowCb.onclick = (e) => e.stopPropagation();
            card.appendChild(rowCb);
        });
    }

    // ------------------ Video Page Icon ------------------
    function injectVideoClipboardIcon() {
        const isVideoPage = /\/@.+?\/(video|photo)\/\d+/.test(location.pathname);
        if (!isVideoPage) return;

        if (document.getElementById('tmk-extension-video-icon')) return;

        // Priority 1: After username
        // Selector for username link in the header/description area
        const userLinkSelector = 'a[class*="StyledLink"][href^="/@"][data-e2e="browse-username"], a[class*="StyledLink"][href^="/@"]:has([data-e2e="browse-username"])';
        let target = document.querySelector(userLinkSelector);
        
        // Fallback for target A: looking for the link matching the pattern in the request
        if (!target) {
            target = Array.from(document.querySelectorAll('a[class*="StyledLink"]'))
                .find(a => a.getAttribute('href')?.startsWith('/@') && a.textContent.trim().length > 0);
        }

        const icon = createClipboardIcon('tmk-extension-video-icon');

        if (target) {
            // Add after the text username
            target.parentNode.insertBefore(icon, target.nextSibling);
            icon.style.marginLeft = '8px';
            icon.style.display = 'inline-flex';
            icon.style.verticalAlign = 'middle';
        } else {
            // Priority 2: Fallback location
            const fallbackTarget = document.querySelector('#one-column-item-0 > div > section[class*="SectionActionBarContainer"] > div[class*="DivAvatarActionItemContainer"]');
            if (fallbackTarget) {
                icon.style.marginBottom = '12px';
                fallbackTarget.parentNode.insertBefore(icon, fallbackTarget);
            }
        }
    }

    async function autoCollectStories() {
        let addedCount = 0;
        const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

        while (true) {
            const url = location.href.split('?')[0];
            if (url.includes('video')) {
                const current = await getInternalClipboard();
                if (!current.includes(url)) {
                    const next = [...current, url];
                    await saveInternalClipboard(next);
                    addedCount++;
                }
            }

            // Find the "next story" button based on user-provided characteristics
            const nextButton = document.querySelector('button[class*="action-item"][style*="inset-inline-end: -3rem"]');

            if (nextButton && nextButton.getAttribute('aria-disabled') !== 'true') {
                nextButton.click();
                // Wait for navigation and DOM update
                await sleep(1000);
            } else {
                break;
            }
        }
        showNotification(`Auto-collection finished.\nAdded ${addedCount} new URLs.`, '#ffcc00');
    }

    function createClipboardIcon(id, type = 'append') {
        const icon = document.createElement('div');
        icon.id = id;
        
        let title = 'Add Current URL to List';
        let color = '#fff';
        if (type === 'clear') {
            title = 'Clear List & Copy Current URL';
            color = '#ff4d4f';
        } else if (type === 'auto') {
            title = 'Auto-collect Stories';
            color = '#ffcc00';
        }

        icon.title = title;
        Object.assign(icon.style, {
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: color, opacity: '0.7', transition: 'opacity 0.2s'
        });

        icon.innerHTML = `
            <svg width="24" height="24" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M14 10C14 8.89543 14.8954 8 16 8H32C33.1046 8 34 8.89543 34 10V12H14V10Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/>
                <path d="M40 20V41C40 42.1046 39.1046 43 38 43H10C8.89543 43 8 42.1046 8 41V14C8 12.8954 8.89543 12 10 12H14V16H34V12H38C39.1046 12 40 12.8954 40 14V17" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M16 25H32" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M16 33H32" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
        `;

        icon.onmouseover = () => icon.style.opacity = '1';
        icon.onmouseout = () => icon.style.opacity = '0.7';

        icon.onclick = async (e) => {
            e.stopPropagation();
            const url = location.href.split('?')[0];
            if (type === 'clear') {
                if (confirm('Are you sure you want to clear the current list and copy ONLY this URL?')) {
                    await saveInternalClipboard([url]);
                    showNotification(`Cleared list and copied current URL:\n${url}\nTotal: 1`, '#ff4d4f');
                }
            } else if (type === 'auto') {
                autoCollectStories();
            } else {
                const current = await getInternalClipboard();
                if (!current.includes(url)) {
                    const next = [...current, url];
                    await saveInternalClipboard(next);
                    showNotification(`Added current URL to list:\n${url}\nTotal: ${next.length}`, '#4ecdc4');
                } else {
                    showNotification(`URL already in list.\nTotal: ${current.length}`, '#ffbb00');
                }
            }
        };
        return icon;
    }

    // ------------------ Story Viewer ------------------
    function injectStoryIcons() {
        const isStory = !!document.querySelector('#stories-player > div.css-1dux0b3 > button');
        if (!isStory) {
            const container = document.getElementById('tmk-story-icon-container');
            if (container) container.remove();
            return;
        }

        if (document.getElementById('tmk-story-icon-container')) return;

        const exitBtn = document.querySelector('button[aria-label="exit"]');
        if (!exitBtn) return;

        const container = document.createElement('div');
        container.id = 'tmk-story-icon-container';
        Object.assign(container.style, {
            position: 'fixed', top: '70px', right: '20px', zIndex: 999999,
            display: 'flex', gap: '15px', background: 'rgba(0,0,0,0.3)', padding: '8px', borderRadius: '8px'
        });

        const standardIcon = createClipboardIcon('tmk-story-append-icon', 'append');
        const redIcon = createClipboardIcon('tmk-story-clear-icon', 'clear');
        const autoIcon = createClipboardIcon('tmk-story-auto-icon', 'auto');

        container.appendChild(standardIcon);
        container.appendChild(redIcon);
        container.appendChild(autoIcon);
        document.body.appendChild(container);
    }

    // ------------------ Extension Icon Handler ------------------
    if (isContextValid()) {
        chrome.runtime.onMessage.addListener((message) => {
            if (message.type === "ACTION_CLICKED") {
                (async () => {
                    const url = location.href.split('?')[0];
                    const current = await getInternalClipboard();
                    if (!current.includes(url)) {
                        const next = [...current, url];
                        await saveInternalClipboard(next);
                        showNotification(`Added current URL to list:\n${url}\nTotal: ${next.length}`, '#4ecdc4');
                    } else {
                        showNotification(`URL already in list.\nTotal: ${current.length}`, '#ffbb00');
                    }
                })();
            }
        });
    }

    // ------------------ Initialization ------------------
    {
        const initialMatch = location.pathname.match(/^\/(@[^/]+)/);
        await loadSelectionForHandle(initialMatch ? initialMatch[1] : null);
    }

    const mainObserver = new MutationObserver(() => {
        injectCheckboxes();
        injectVideoClipboardIcon();
        injectStoryIcons();
    });

    mainObserver.observe(document.body, { childList: true, subtree: true });

    // ------------------ Leave Confirmation ------------------
    window.addEventListener('click', (e) => {
        if (selectedLinks.size === 0) return;

        const anchor = e.target.closest('a');
        if (!anchor) return;

        const href = anchor.getAttribute('href');
        if (!href || href === '#' || href.startsWith('javascript:')) return;

        // Don't block our own menu links or the extension bar
        if (e.target.closest('#tmk-multi-select-menu, #link-batch-opener-bar')) return;

        // Determine if this is truly an external navigation or a video card click
        // TikTok video cards are wrapped in an anchor that navigates to /video/id
        const isInternalVideoLink = /\/@.+?\/(video|photo)\/\d+/.test(href);
        const card = anchor.closest('[data-e2e="user-post-item"]');

        // If it's an internal video link on the SAME profile page, we might want to toggle instead of navigate
        if (card && isInternalVideoLink) {
             // Let the native click proceed IF they confirm, otherwise toggle
             if (!confirm('You have videos selected. Are you sure you want to view this video? (This will leave the profile page)')) {
                e.preventDefault();
                e.stopImmediatePropagation();

                const cb = card.querySelector('.tmk-video-checkbox');
                if (cb) {
                    cb.checked = !cb.checked;
                    cb.dispatchEvent(new Event('change'));
                }
             }
             return;
        }

        // External navigation or other link (e.g. profile logo, another user)
        if (!confirm('You have videos selected. Are you sure you want to leave this page?')) {
            e.preventDefault();
            e.stopImmediatePropagation();
        }
    }, true); // Capture phase to preempt other handlers

    // Initial run
    injectCheckboxes();
    injectVideoClipboardIcon();
    injectStoryIcons();

    // Load the (persisted) selection for the new profile on SPA navigation.
    // Selection is never cleared just by navigating away and back - only by
    // Deselect All or one of the Copy Selected actions.
    let lastHandle = currentSelectionHandle;
    setInterval(async () => {
        const match = location.pathname.match(/^\/(@[^/]+)/);
        const currentHandle = match ? match[1] : null;
        if (currentHandle !== lastHandle) {
            lastHandle = currentHandle;
            await loadSelectionForHandle(currentHandle);
            restoreCheckedState();
            updateMultiSelectMenu();
        }
    }, 1000);

})();
