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

    // Serializes every baseline read-modify-write through one queue, so
    // overlapping processPage() calls (very possible - see below) can't
    // race each other: call A reads 100, call B also reads 100 before A's
    // write lands, A writes 150, then B (still holding its stale read of
    // 100) writes 120 on top of it - silently regressing the baseline.
    // Chaining through this promise makes each write wait for the previous
    // one to fully finish before it reads anything.
    let writeQueue = Promise.resolve();

    function bumpBaseline(key, maxTimestamp) {
        writeQueue = writeQueue.then(async () => {
            if (!isContextValid()) return;
            try {
                const res = await chrome.storage.local.get(key);
                const existing = res[key] || 0;
                if (maxTimestamp > existing) {
                    await chrome.storage.local.set({ [key]: maxTimestamp });
                }
            } catch (e) {}
        }).catch(() => {});
    }

    function processPage() {
        if (!isContextValid()) return;
        try {
            const handle = getProfileHandle();
            if (!handle) return;

            const cards = document.querySelectorAll('[data-e2e="user-post-item"]');
            let maxTimestamp = 0;

            cards.forEach(card => {
                const link = card.querySelector('a[href]');
                if (!link) return;
                // Only videos count towards "new content" detection - photos
                // (URLs contain /photo/ instead of /video/) are excluded.
                const postIdMatch = link.href.match(/\/video\/(\d{10,})/);
                if (postIdMatch) {
                    const ts = deriveDateFromPostId(postIdMatch[1]);
                    if (ts && ts > maxTimestamp) {
                        maxTimestamp = ts;
                    }
                }
            });

            if (maxTimestamp > 0) {
                // Only ever moves the stored baseline forward (see
                // bumpBaseline). processPage() can fire many times in quick
                // succession while the grid is still loading/virtualizing,
                // and may only see a partial set of cards on any given
                // call - never regress on a lower reading from an
                // incomplete scan.
                bumpBaseline(`tiktok_last_post:${handle}`, maxTimestamp);
            }
        } catch (e) {
            console.warn("Tiktok Meta: processPage failed", e);
        }
    }

    // Debounced: the DOM can mutate many times per second while a profile
    // grid loads/virtualizes, and calling processPage() on every single one
    // both wastes work and widens the window for the read-modify-write race
    // above. Collapse bursts of mutations into one call, ~150ms after they
    // settle down.
    let scheduleTimer = null;
    function scheduleProcess() {
        if (scheduleTimer) clearTimeout(scheduleTimer);
        scheduleTimer = setTimeout(() => {
            scheduleTimer = null;
            processPage();
        }, 150);
    }

    const observer = new MutationObserver(() => {
        if (!isContextValid()) {
            observer.disconnect();
            return;
        }
        scheduleProcess();
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    processPage();
})();
