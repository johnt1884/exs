(async () => {
    'use strict';

    // --- Controller State ---
    const selectedLinks = new Set();
    const processedNodes = new WeakSet();
    const CLIPBOARD_KEY = 'tmk_internal_clipboard';
    let lastHandle = '';
    let lastUrl = location.href;

    // --- Helpers ---
    function getProfileHandle() {
        const match = location.pathname.match(/^\/(@[^/]+)/);
        return match ? match[1] : null;
    }

    function isProfilePage() {
        return location.pathname.startsWith('/@') &&
               !location.pathname.includes('/video/') &&
               !location.pathname.includes('/photo/') &&
               !location.pathname.includes('/live');
    }

    function syncStateOnNavigation() {
        const currentUrl = location.href;
        if (currentUrl === lastUrl) return;
        lastUrl = currentUrl;

        const handle = getProfileHandle();
        if (handle !== lastHandle) {
            lastHandle = handle;
            selectedLinks.clear();
            refreshMultiSelectUI();
        }
    }

    // --- UI Layer ---
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
            display: 'block', padding: '10px 15px', background: 'rgba(0,0,0,0.85)', color: color,
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

    function refreshMultiSelectUI() {
        try {
            let box = document.getElementById('tmk-multi-select-ui');
            if (selectedLinks.size === 0 || !isProfilePage()) {
                if (box) box.remove();
                return;
            }

            if (!box) {
                box = document.createElement('div');
                box.id = 'tmk-multi-select-ui';
                Object.assign(box.style, {
                    all: 'initial', position: 'fixed', top: '160px', right: '20px',
                    padding: '8px 12px', background: 'rgba(0,0,0,0.8)', color: '#fff',
                    fontSize: '12px', zIndex: 99999, borderRadius: '8px', boxShadow: '0 0 12px rgba(0,0,0,0.6)',
                    maxWidth: '200px', display: 'flex', flexDirection: 'column', gap: '6px',
                    fontFamily: 'Arial, sans-serif', boxSizing: 'border-box'
                });

                box.onclick = (e) => {
                    const action = e.target.dataset.action;
                    if (!action) return;
                    e.preventDefault();
                    e.stopPropagation();

                    if (action === 'copyClear') {
                        if (!confirm('Are you sure you want to clear memory and copy selected?')) return;
                        const arr = Array.from(selectedLinks);
                        localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(arr));
                        navigator.clipboard.writeText(arr.join('\n')).catch(() => {});
                        showNotification(`Copied ${arr.length} selected link(s)!\n(Memory cleared first)`, '#4ecdc4');
                    } else if (action === 'copyAppend') {
                        const current = JSON.parse(localStorage.getItem(CLIPBOARD_KEY) || '[]');
                        const merged = Array.from(new Set([...current, ...selectedLinks]));
                        localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(merged));
                        navigator.clipboard.writeText(merged.join('\n')).catch(() => {});
                        showNotification(`Appended ${selectedLinks.size} link(s).\nTotal in memory: ${merged.length}`, '#4ecdc4');
                    } else if (action === 'clearSelection') {
                        selectedLinks.clear();
                        document.querySelectorAll('.tmk-custom-checkbox').forEach(cb => cb.checked = false);
                        document.querySelectorAll('.tmk-row-select-checkbox').forEach(cb => cb.checked = false);
                        refreshMultiSelectUI();
                        showNotification('Selection cleared!', '#95e1d3');
                    } else if (action === 'clearMemory') {
                        if (!confirm('Are you sure you want to clear memory?')) return;
                        localStorage.removeItem(CLIPBOARD_KEY);
                        showNotification('Internal clipboard cleared!', '#95e1d3');
                    }
                };

                document.body.appendChild(box);
            }

            box.innerHTML = `
                <a href="#" data-action="copyClear" style="color:#0ff; text-decoration:none; display:block; font-size:11px;">Copy Selected (Clear Memory)</a>
                <a href="#" data-action="copyAppend" style="color:#ff0; text-decoration:none; display:block; font-size:11px;">Copy Selected (Append)</a>
                <a href="#" data-action="clearSelection" style="color:#f80; text-decoration:none; display:block; font-size:11px;">Clear Selection</a>
                <a href="#" data-action="clearMemory" style="color:#f44; text-decoration:none; display:block; font-size:11px;">Clear Memory</a>
                <span style="font-size:10px; opacity:0.8; margin-top:2px;">Selected: ${selectedLinks.size}</span>
            `;
        } catch (e) { console.error("Tiktok UI: refreshMultiSelectUI failed", e); }
    }

    // --- Injection Layer ---
    function injectIntoVideoCard(card) {
        try {
            const existingCb = card.querySelector('.tmk-custom-checkbox');
            if (existingCb && processedNodes.has(card)) {
                const a = card.querySelector('a[href*="/video/"], a[href*="/photo/"]');
                if (a) {
                    const href = a.href.split('?')[0];
                    existingCb.checked = selectedLinks.has(href);
                }
                return;
            }

            processedNodes.add(card);
            if (existingCb) existingCb.parentElement.remove();
            const existingRowCb = card.querySelector('.tmk-row-select-checkbox');
            if (existingRowCb) existingRowCb.parentElement.remove();

            const a = card.querySelector('a[href*="/video/"], a[href*="/photo/"]');
            if (!a) return;

            const href = a.href.split('?')[0];
            if (getComputedStyle(card).position === 'static') card.style.position = 'relative';

            // Individual Checkbox (Top-Left)
            const leftWrapper = document.createElement('span');
            Object.assign(leftWrapper.style, { position: 'absolute', top: '5px', left: '5px', zIndex: '100' });
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'tmk-custom-checkbox';
            cb.style.cssText = 'transform: scale(1.3) !important; cursor: pointer !important; width: 14px !important; height: 14px !important; margin: 0 !important;';
            cb.checked = selectedLinks.has(href);
            ['click','mousedown','mouseup'].forEach(evt => cb.addEventListener(evt, e => e.stopPropagation(), { capture: true }));
            cb.addEventListener('change', () => {
                if (cb.checked) selectedLinks.add(href);
                else selectedLinks.delete(href);
                refreshMultiSelectUI();
            });
            leftWrapper.appendChild(cb);
            card.appendChild(leftWrapper);

            // Row Selection Checkbox (Top-Right)
            const rightWrapper = document.createElement('span');
            Object.assign(rightWrapper.style, { position: 'absolute', top: '5px', right: '5px', zIndex: '100' });
            const rowCb = document.createElement('input');
            rowCb.type = 'checkbox';
            rowCb.className = 'tmk-row-select-checkbox';
            rowCb.style.cssText = 'transform: scale(1.3) !important; cursor: pointer !important; width: 14px !important; height: 14px !important; margin: 0 !important;';
            ['click','mousedown','mouseup'].forEach(evt => rowCb.addEventListener(evt, e => e.stopPropagation(), { capture: true }));
            rowCb.addEventListener('change', () => {
                const myRect = card.getBoundingClientRect();
                const myTop = myRect.top + window.scrollY;
                const myHeight = myRect.height;
                
                const allCards = document.querySelectorAll('[class*="DivItemContainer"], [data-e2e="user-post-item"]');
                allCards.forEach(sib => {
                    const sibRect = sib.getBoundingClientRect();
                    const sibTop = sibRect.top + window.scrollY;
                    // Improved row detection: overlap check
                    if (Math.abs(sibTop - myTop) < myHeight / 2) {
                        const sibA = sib.querySelector('a[href*="/video/"], a[href*="/photo/"]');
                        const sibCb = sib.querySelector('.tmk-custom-checkbox');
                        const sibRowCb = sib.querySelector('.tmk-row-select-checkbox');
                        if (sibA && sibCb) {
                            const sibHref = sibA.href.split('?')[0];
                            sibCb.checked = rowCb.checked;
                            if (rowCb.checked) selectedLinks.add(sibHref);
                            else selectedLinks.delete(sibHref);
                        }
                        if (sibRowCb) sibRowCb.checked = rowCb.checked;
                    }
                });
                refreshMultiSelectUI();
            });
            rightWrapper.appendChild(rowCb);
            card.appendChild(rightWrapper);
        } catch (e) { console.error("Tiktok UI: injectIntoVideoCard failed", e); }
    }

    // --- Initialization ---
    function init() {
        if (!document.body) { setTimeout(init, 50); return; }

        let pending = false;
        const observer = new MutationObserver(() => {
            if (pending) return;
            pending = true;
            requestAnimationFrame(() => {
                pending = false;
                syncStateOnNavigation();
                if (isProfilePage()) {
                    document.querySelectorAll('[class*="DivItemContainer"], [data-e2e="user-post-item"]').forEach(injectIntoVideoCard);
                }
            });
        });

        observer.observe(document.body, { childList: true, subtree: true });

        setInterval(() => {
            syncStateOnNavigation();
            if (isProfilePage()) {
                document.querySelectorAll('[class*="DivItemContainer"], [data-e2e="user-post-item"]').forEach(injectIntoVideoCard);
            }
        }, 1500);
    }

    init();
})();
