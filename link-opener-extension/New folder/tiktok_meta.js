(async () => {
    'use strict';

    function getProfileHandle() {
        const match = location.pathname.match(/^\/(@[^/]+)/);
        return match ? match[1] : null;
    }

    function deriveDateFromPostId(postId) {
        if (!postId) return null;
        try {
            const seconds = Number(BigInt(postId) >> 32n);
            if (!Number.isFinite(seconds)) return null;
            if (seconds < 1420070400 || seconds > 2524608000) return null;
            return seconds * 1000;
        } catch (error) {
            return null;
        }
    }

    function isContextValid() {
        try {
            return typeof chrome !== "undefined" && 
                   !!chrome.runtime && 
                   !!chrome.runtime.id && 
                   !!chrome.storage && 
                   !!chrome.storage.local;
        } catch (e) {
            return false;
        }
    }

    function processPage() {
        if (!isContextValid()) return;
        try {
            const handle = getProfileHandle();
            if (!handle) return;

            const cards = document.querySelectorAll('[data-e2e="user-post-item-list"] [data-e2e="user-post-item"]');
        let maxTimestamp = 0;

        cards.forEach(card => {
            const link = card.querySelector('a[href]');
            if (!link) return;
            const postIdMatch = link.href.match(/\/(?:video|photo)\/(\d{10,})/);
            if (postIdMatch) {
                const ts = deriveDateFromPostId(postIdMatch[1]);
                if (ts && ts > maxTimestamp) {
                    maxTimestamp = ts;
                }
            }
        });

            if (maxTimestamp > 0) {
                const key = `tiktok_last_post:${handle}`;
                if (isContextValid()) {
                    chrome.storage.local.set({ [key]: maxTimestamp });
                }
            }
        } catch (e) {
            console.warn("Tiktok Meta: processPage failed", e);
        }
    }

    const observer = new MutationObserver(() => {
        if (!isContextValid()) {
            observer.disconnect();
            return;
        }
        processPage();
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    processPage();
})();
