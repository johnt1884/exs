// -----------------------------
// STAGGERED NAVIGATION
// -----------------------------
(async () => {
    'use strict';

    // ssstiktok.dev pages get forward/back/counter nav only (no automatic
    // polling / pause / fast-mode / new-video buttons, since those rely on
    // TikTok-specific page signals that don't exist there).
    const isTikTokPage = location.hostname.endsWith('tiktok.com');

    // -----------------------------
    // FALSE-POSITIVE DIAGNOSTIC LOG
    // -----------------------------
    // Every automatic-load decision on a profile page (stop for "new
    // content", or advance because nothing new was found) gets logged here
    // - not just the ones that turn out wrong - so that when a false
    // positive does happen, there's a history of prior passes over the same
    // profile to compare against (e.g. to see the baseline drifting between
    // passes). The "Mark False Positive" button just tags whichever entry
    // was wrong; it doesn't create entries itself.
    const FP_LOG_KEY = 'tmk_fp_log';
    const FP_LOG_MAX = 1000;

    // Deterministic, one-way. Same profile always maps to the same short
    // pseudonymous ID across log entries (useful for spotting patterns),
    // but the real handle is never written to storage or the export.
    function anonymizeHandle(handle) {
        if (!handle) return 'unknown';
        let h = 0;
        for (let i = 0; i < handle.length; i++) {
            h = (Math.imul(31, h) + handle.charCodeAt(i)) | 0;
        }
        return 'user_' + Math.abs(h).toString(36);
    }

    function anonymizeUrl(url, handle, anonHandle) {
        if (!url || !handle) return url;
        return url.split(handle).join(anonHandle);
    }

    let lastLoggedEntryId = null;

    async function appendFpLog(entry) {
        if (!isContextValid()) return null;
        try {
            const res = await chrome.storage.local.get(FP_LOG_KEY);
            const log = res[FP_LOG_KEY] || [];
            entry.id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            log.push(entry);
            while (log.length > FP_LOG_MAX) log.shift();
            await chrome.storage.local.set({ [FP_LOG_KEY]: log });
            return entry.id;
        } catch (e) {
            return null;
        }
    }

    async function markFpLogEntry(id, value) {
        if (!isContextValid() || !id) return false;
        try {
            const res = await chrome.storage.local.get(FP_LOG_KEY);
            const log = res[FP_LOG_KEY] || [];
            const idx = log.findIndex(e => e.id === id);
            if (idx === -1) return false;
            log[idx].markedFalsePositive = value;
            await chrome.storage.local.set({ [FP_LOG_KEY]: log });
            return true;
        } catch (e) {
            return false;
        }
    }

    // Builds one diagnostic snapshot of "why does the page think this or
    // that right now" and logs it. Called at every automatic-load decision
    // point (stop or advance).
    async function logPassSnapshot(outcome, details) {
        const handleMatch = location.pathname.match(/^\/(@[^/]+)/);
        const handle = handleMatch ? handleMatch[1] : null;
        const anon = anonymizeHandle(handle);
        const anonUrl = (u) => anonymizeUrl(u, handle, anon);

        // Live max timestamp actually visible on the page right now,
        // regardless of the baseline comparison - useful for correlating
        // across passes even on runs where nothing triggered.
        let liveMax = 0;
        let videoLinksSeen = 0;
        document.querySelectorAll('a[href*="/video/"]').forEach(a => {
            videoLinksSeen++;
            const m = a.href.match(/\/video\/(\d{10,})/);
            if (m) {
                try {
                    const ts = Number(BigInt(m[1]) >> 32n) * 1000;
                    if (ts > liveMax) liveMax = ts;
                } catch (e) {}
            }
        });

        const badgeCandidates = [];
        document.querySelectorAll('.tt-thumb-meta__meta--new').forEach(meta => {
            const host = meta.closest('.tt-thumb-meta__host');
            const a = host ? host.querySelector('a[href]') : null;
            if (!a) return;
            const m = a.href.match(/\/video\/(\d{10,})/);
            let ts = null;
            if (m) { try { ts = Number(BigInt(m[1]) >> 32n) * 1000; } catch (e) {} }
            badgeCandidates.push({
                url: anonUrl(a.href.split('?')[0]),
                date: ts ? new Date(ts).toISOString() : null,
                postType: meta.dataset.postType || null
            });
        });

        const entry = {
            ts: Date.now(),
            loggedAt: new Date().toISOString(),
            profile: anon,
            outcome, // 'stopped_error_text' | 'stopped_badge' | 'stopped_scrape' | 'advanced_no_new' | 'advanced_timeout'
            baseline: (details.baseline && details.baseline !== Infinity) ? details.baseline : null,
            baselineDate: (details.baseline && details.baseline !== Infinity) ? new Date(details.baseline).toISOString() : null,
            liveMax: liveMax || null,
            liveMaxDate: liveMax ? new Date(liveMax).toISOString() : null,
            videoLinksSeen,
            badgeText: details.badgeText || null,
            scrapeCandidates: (details.scrapeCandidates || []).map(c => ({
                url: anonUrl(c.url),
                date: new Date(c.ts).toISOString()
            })),
            badgeCandidates,
            markedFalsePositive: null
        };

        lastLoggedEntryId = await appendFpLog(entry);
        updateFpButtonState();
    }

    function createFpButton() {
        if (!isContextValid() || document.getElementById('stagger-fp-btn')) return null;
        const btn = document.createElement('button');
        btn.id = 'stagger-fp-btn';
        btn.textContent = 'Mark FP';
        btn.title = 'Mark the last automatic-load decision on this page as a false positive';
        btn.style.position = 'fixed';
        // Moved off the top-left corner and shrunk, in case something else
        // on the page was landing stray clicks there - see the confirm()
        // below for the main defense either way.
        btn.style.bottom = '20px';
        btn.style.left = '20px';
        btn.style.top = 'auto';
        btn.style.zIndex = '999999';
        btn.style.padding = '6px 10px';
        btn.style.background = '#000';
        btn.style.color = '#fff';
        btn.style.border = '2px solid #ff6b6b';
        btn.style.borderRadius = '6px';
        btn.style.cursor = 'pointer';
        btn.style.fontSize = '12px';
        btn.style.opacity = '0.35';
        btn.disabled = true;

        btn.onclick = async () => {
            if (!lastLoggedEntryId || btn.disabled) return;
            // Require an explicit confirmation - a stray/accidental click
            // landing on the button can satisfy a click, but a native
            // confirm() dialog needs a second, separate deliberate action
            // to actually mark anything.
            if (!confirm('Mark the automatic-load decision on THIS page as a false positive?')) return;
            btn.disabled = true;
            const ok = await markFpLogEntry(lastLoggedEntryId, true);
            btn.textContent = ok ? 'Marked \u2713' : 'Mark FP';
            btn.style.borderColor = ok ? '#4ecdc4' : '#ff6b6b';
            btn.style.opacity = ok ? '1' : '0.35';
            if (!ok) btn.disabled = false;
        };

        document.body.appendChild(btn);
        return btn;
    }

    function updateFpButtonState() {
        let btn = document.getElementById('stagger-fp-btn');
        if (!btn) btn = createFpButton();
        if (!btn) return;
        if (lastLoggedEntryId) {
            btn.disabled = false;
            btn.textContent = 'Mark FP';
            btn.style.borderColor = '#ff6b6b';
            btn.style.opacity = '1';
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

    // -----------------------------
    // SHARED CLIPBOARD (cross-domain)
    // -----------------------------
    // On tiktok.com, the "TikTok Video Counter + Multi-Select" userscript
    // also keeps a clipboard, in localStorage (page-scoped to tiktok.com).
    // We merge with it there so both sides see the same list. On
    // ssstiktok.dev there's no such userscript, so we just use
    // chrome.storage.local (shared across all domains the extension runs
    // on) directly.
    const CLIPBOARD_KEY = 'tmk_internal_clipboard';

    async function appendToInternalClipboard(urls) {
        let fromPage = [];
        if (isTikTokPage) {
            try {
                const raw = localStorage.getItem(CLIPBOARD_KEY);
                fromPage = raw ? JSON.parse(raw) : [];
            } catch (e) {}
        }
        const res = await chrome.storage.local.get(CLIPBOARD_KEY);
        const fromExt = res[CLIPBOARD_KEY] || [];

        const merged = Array.from(new Set([...fromPage, ...fromExt, ...urls]));
        await chrome.storage.local.set({ [CLIPBOARD_KEY]: merged });
        if (isTikTokPage) {
            try { localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(merged)); } catch (e) {}
        }
        navigator.clipboard.writeText(merged.join('\n')).catch(() => {});
        return merged;
    }

    async function setStaggerAppendNotify(appended, total) {
        await chrome.storage.local.set({
            stagger_append_notify: { appended, total }
        });
    }

    function showNotification(msg, color = '#fff', duration = 3000) {
        let container = document.getElementById('tmk-notification-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'tmk-notification-container';
            Object.assign(container.style, {
                position: 'fixed',
                bottom: '20px',
                right: '20px',
                zIndex: 999999,
                maxWidth: '300px',
                fontSize: '14px',
                lineHeight: '1.3'
            });
            document.body.appendChild(container);
        }
        const note = document.createElement('div');
        Object.assign(note.style, {
            padding: '10px 15px',
            background: `rgba(0,0,0,0.85)`,
            color: color,
            borderRadius: '6px',
            marginBottom: '10px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
            opacity: '0',
            transform: 'translateY(20px)',
            transition: 'opacity 0.3s ease, transform 0.3s ease'
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

    function createForwardBtn() {
        if (!isContextValid()) return;
        const btn = document.createElement("button");
        btn.id = "stagger-forward-btn";
        btn.textContent = ">>";
        btn.title = "Progress to Next Link";
        btn.style.position = "fixed";
        btn.style.right = "20px";
        btn.style.top = "50%";
        btn.style.transform = "translateY(-50%)";
        btn.style.zIndex = "999999";
        btn.style.width = "50px";
        btn.style.height = "50px";
        btn.style.minWidth = "50px";
        btn.style.minHeight = "50px";
        btn.style.display = "flex";
        btn.style.alignItems = "center";
        btn.style.justifyContent = "center";
        btn.style.fontSize = "20px";
        btn.style.background = "#000";
        btn.style.color = "#fff";
        btn.style.border = "2px solid #fff";
        btn.style.borderRadius = "50%";
        btn.style.boxSizing = "border-box";
        btn.style.cursor = "pointer";
        btn.style.opacity = "0.7";
        btn.style.transition = "opacity 0.2s, color 0.2s, border-color 0.2s";

        btn.onmouseover = () => btn.style.opacity = "1";
        btn.onmouseout = () => btn.style.opacity = "0.7";

        // Color/click state is driven ONLY by our own tracked selection
        // (.tmk-video-checkbox). We used to also honor an external
        // userscript's .tmk-custom-checkbox here, but that class can get
        // checked by logic outside our control (e.g. its own "new item"
        // auto-marking), which made this button randomly turn yellow and
        // append things the user never selected. Keeping it strictly to our
        // own checkbox makes the state fully deterministic.
        function updateState() {
            const selected = document.querySelectorAll(".tmk-video-checkbox:checked");
            if (selected.length > 0) {
                btn.style.color = "yellow";
                btn.style.borderColor = "yellow";
                btn.title = "Add Link/s to List and Progress to Next Link";
            } else {
                btn.style.color = "#fff";
                btn.style.borderColor = "#fff";
                btn.title = "Progress to Next Link";
            }
        }

        // Poll for selection state since we can't easily listen to changes in another script's injected checkboxes
        const statePoll = setInterval(() => {
            if (!isContextValid()) {
                clearInterval(statePoll);
                return;
            }
            updateState();
        }, 500);

        btn.onclick = async () => {
            if (!isContextValid()) return;
            const selected = document.querySelectorAll(".tmk-video-checkbox:checked");
            if (selected.length > 0) {
                const urls = Array.from(selected).map(cb => {
                    const card = cb.closest('[data-e2e="user-post-item"]');
                    const a = card ? card.querySelector('a[href]') : null;
                    return a ? a.href.split('?')[0] : null;
                }).filter(Boolean);

                if (urls.length > 0) {
                    try {
                        const merged = await appendToInternalClipboard(urls);
                        await setStaggerAppendNotify(urls.length, merged.length);
                    } catch (e) {
                        console.error("Stagger Nav: Failed to append to clipboard", e);
                    }
                }

                // This is a terminal action for the page (the tab closes
                // right after) - clear the selection now, same as "Copy
                // Selected (Append)" does, so it isn't still checked (and
                // this button isn't still yellow) next time this profile
                // comes up in a staggered run.
                selected.forEach(cb => {
                    cb.checked = false;
                    cb.dispatchEvent(new Event('change'));
                });
            }
            if (isContextValid()) {
                chrome.runtime.sendMessage({ type: "NEXT_STAGGERED" });
            }
        };

        document.body.appendChild(btn);

        if (!isTikTokPage) return;

        // Pause/Play button
        const pauseBtn = document.createElement("button");
        pauseBtn.id = "stagger-pause-btn";
        pauseBtn.title = "Pause/Resume Automatic Link Progression";
        pauseBtn.style.position = "fixed";
        pauseBtn.style.right = "20px";
        pauseBtn.style.top = "calc(50% + 60px)";
        pauseBtn.style.transform = "translateY(-50%)";
        pauseBtn.style.zIndex = "999999";
        pauseBtn.style.width = "50px";
        pauseBtn.style.height = "50px";
        pauseBtn.style.minWidth = "50px";
        pauseBtn.style.minHeight = "50px";
        pauseBtn.style.display = "flex";
        pauseBtn.style.alignItems = "center";
        pauseBtn.style.justifyContent = "center";
        pauseBtn.style.fontSize = "20px";
        pauseBtn.style.background = "#000";
        pauseBtn.style.color = "#fff";
        pauseBtn.style.border = "2px solid #fff";
        pauseBtn.style.borderRadius = "50%";
        pauseBtn.style.boxSizing = "border-box";
        pauseBtn.style.cursor = "pointer";
        pauseBtn.style.opacity = "0.7";
        pauseBtn.style.transition = "opacity 0.2s";

        const updatePauseBtn = (enabled) => {
            pauseBtn.textContent = enabled ? "II" : "▶";
        };

        if (isContextValid()) {
            chrome.storage.local.get("automatic_load_enabled", (res) => {
                updatePauseBtn(res.automatic_load_enabled);
            });
        }

        pauseBtn.onclick = () => {
            if (isContextValid()) {
                chrome.storage.local.get("automatic_load_enabled", (res) => {
                    const newState = !res.automatic_load_enabled;
                    chrome.storage.local.set({ "automatic_load_enabled": newState });
                });
            }
        };

        if (isContextValid()) {
            chrome.storage.onChanged.addListener((changes) => {
                if (changes.automatic_load_enabled) {
                    updatePauseBtn(changes.automatic_load_enabled.newValue);
                }
            });
        }

        document.body.appendChild(pauseBtn);

        // Fast Mode toggle button
        const fastBtn = document.createElement("button");
        fastBtn.id = "stagger-fast-btn";
        fastBtn.title = "Toggle Fast Mode";
        fastBtn.style.position = "fixed";
        fastBtn.style.right = "20px";
        fastBtn.style.top = "calc(50% - 60px)";
        fastBtn.style.transform = "translateY(-50%)";
        fastBtn.style.zIndex = "999999";
        fastBtn.style.width = "50px";
        fastBtn.style.height = "50px";
        fastBtn.style.minWidth = "50px";
        fastBtn.style.minHeight = "50px";
        fastBtn.style.display = "flex";
        fastBtn.style.alignItems = "center";
        fastBtn.style.justifyContent = "center";
        fastBtn.style.fontSize = "20px";
        fastBtn.style.background = "#000";
        fastBtn.style.color = "#fff";
        fastBtn.style.border = "2px solid #fff";
        fastBtn.style.borderRadius = "50%";
        fastBtn.style.boxSizing = "border-box";
        fastBtn.style.cursor = "pointer";
        fastBtn.style.opacity = "0.7";
        fastBtn.style.transition = "opacity 0.2s, color 0.2s, border-color 0.2s";

        const updateFastBtn = (enabled) => {
            fastBtn.textContent = "F";
            if (enabled) {
                fastBtn.style.color = "#4ecdc4";
                fastBtn.style.borderColor = "#4ecdc4";
            } else {
                fastBtn.style.color = "#fff";
                fastBtn.style.borderColor = "#fff";
            }
        };

        if (isContextValid()) {
            chrome.storage.local.get("fast_mode_enabled", (res) => {
                updateFastBtn(res.fast_mode_enabled);
            });
        }

        fastBtn.onclick = () => {
            if (isContextValid()) {
                chrome.storage.local.get("fast_mode_enabled", (res) => {
                    const newState = !res.fast_mode_enabled;
                    chrome.storage.local.set({ "fast_mode_enabled": newState });
                });
            }
        };

        if (isContextValid()) {
            chrome.storage.onChanged.addListener((changes) => {
                if (changes.fast_mode_enabled) {
                    updateFastBtn(changes.fast_mode_enabled.newValue);
                }
            });
        }

        document.body.appendChild(fastBtn);

        // Second yellow >> button (only lit up while new VIDEOS are present).
        // Photos are intentionally excluded from "new" detection - they use
        // /photo/ in their URL instead of /video/.
        const hasNewVideos = async () => {
            if (!isContextValid()) return false;
            // 1. Check userscript element (external signal - not under our control,
            // so we can't guarantee it excludes photos, but it's still useful as
            // a quick first check).
            const newCountElement = document.getElementById('tt-thumb-meta__new-count');
            if (newCountElement && parseInt(newCountElement.textContent) > 0) return true;

            // 2. Check baselines directly (robust fallback, video-only)
            const res = await chrome.storage.local.get("staggered_scan_baselines");
            const baselines = res.staggered_scan_baselines || {};
            const handleMatch = location.pathname.match(/^\/(@[^/]+)/);
            const handle = handleMatch ? handleMatch[1] : null;
            // A missing entry means this profile has never been scanned
            // before (tiktok_meta.js only ever stores a value > 0) - not
            // that its baseline is 0. Treating "never scanned" as 0 would
            // make every video on it look newer than the baseline and
            // false-positive on the very first pass.
            const rawBaseline = handle ? baselines[`tiktok_last_post:${handle}`] : null;
            const baseline = rawBaseline ? rawBaseline : Infinity;

            const links = document.querySelectorAll('a[href*="/video/"]');
            for (const a of links) {
                const postIdMatch = a.href.match(/\/video\/(\d{10,})/);
                if (postIdMatch) {
                    try {
                        const ts = Number(BigInt(postIdMatch[1]) >> 32n) * 1000;
                        if (ts > baseline) return true;
                    } catch(e) {}
                }
            }
            return false;
        };

        const createNewFwdBtn = () => {
            if (document.getElementById('stagger-forward-new-btn')) return;
            const btnNew = document.createElement("button");
            btnNew.id = "stagger-forward-new-btn";
            btnNew.textContent = ">>";
            btnNew.title = "Add Link/s of NEW Videos to List and Progress to Next Link";
            btnNew.style.position = "fixed";
            btnNew.style.right = "20px";
            btnNew.style.top = "calc(50% + 120px)";
            btnNew.style.transform = "translateY(-50%)";
            btnNew.style.zIndex = "999999";
            btnNew.style.width = "50px";
            btnNew.style.height = "50px";
            btnNew.style.minWidth = "50px";
            btnNew.style.minHeight = "50px";
            btnNew.style.display = "flex";
            btnNew.style.alignItems = "center";
            btnNew.style.justifyContent = "center";
            btnNew.style.fontSize = "20px";
            btnNew.style.background = "#000";
            btnNew.style.color = "yellow";
            btnNew.style.border = "2px solid yellow";
            btnNew.style.borderRadius = "50%";
            btnNew.style.boxSizing = "border-box";
            btnNew.style.cursor = "pointer";
            btnNew.style.opacity = "0.7";
            btnNew.style.transition = "opacity 0.2s";

            btnNew.onmouseover = () => btnNew.style.opacity = "1";
            btnNew.onmouseout = () => btnNew.style.opacity = "0.7";

            btnNew.onclick = async () => {
                const newMetas = document.querySelectorAll('.tt-thumb-meta__meta--new');
                const urls = [];
                newMetas.forEach(meta => {
                    const host = meta.closest('.tt-thumb-meta__host');
                    const a = host ? host.querySelector('a[href]') : null;
                    if (!a) return;
                    const url = a.href.split('?')[0];
                    if (!/\/video\//.test(url)) return; // videos only, never photos
                    urls.push(url);

                    // If this item's checkbox happens to be checked (e.g. via
                    // the "X new" badge), clear it - same reasoning as the
                    // top button: this is a terminal action for the page, so
                    // don't leave anything selected for next time.
                    const card = host ? (host.closest('[data-e2e="user-post-item"]') || host) : null;
                    const cb = card ? card.querySelector('.tmk-video-checkbox') : null;
                    if (cb && cb.checked) {
                        cb.checked = false;
                        cb.dispatchEvent(new Event('change'));
                    }
                });

                if (urls.length > 0 && isContextValid()) {
                    try {
                        const merged = await appendToInternalClipboard(urls);
                        await setStaggerAppendNotify(urls.length, merged.length);
                    } catch (e) {}
                }
                if (isContextValid()) {
                    chrome.runtime.sendMessage({ type: "NEXT_STAGGERED" });
                }
            };

            document.body.appendChild(btnNew);
        };

        // The userscript (TikTok Title & Precise Date Display) already owns
        // click behavior for its own "X new" badge - it checks the matching
        // .tmk-video-checkbox for each new item and (as of its v0.2.1)
        // skips photos. We don't duplicate that here anymore; we did
        // previously, which meant two handlers fired on one click.

        // Keep checking indefinitely (not just for a short window after load)
        // so the button reflects new content that appears later, e.g. via
        // infinite scroll or after advancing to a new profile.
        const checkNew = setInterval(async () => {
            if (!isContextValid()) {
                clearInterval(checkNew);
                return;
            }
            if (await hasNewVideos()) {
                createNewFwdBtn();
            } else {
                const existing = document.getElementById('stagger-forward-new-btn');
                if (existing) existing.remove();
            }
        }, 1000);
    }

    function createBackBtn(hasPrevious) {
        if (!isContextValid()) return;
        const btn = document.createElement("button");
        btn.id = "stagger-back-btn";
        btn.textContent = "<<";
        btn.title = hasPrevious ? "Go to Previous Link" : "No previous link";
        btn.style.position = "fixed";
        btn.style.right = "80px";
        btn.style.top = "50%";
        btn.style.transform = "translateY(-50%)";
        btn.style.zIndex = "999999";
        btn.style.width = "50px";
        btn.style.height = "50px";
        btn.style.minWidth = "50px";
        btn.style.minHeight = "50px";
        btn.style.display = "flex";
        btn.style.alignItems = "center";
        btn.style.justifyContent = "center";
        btn.style.fontSize = "20px";
        btn.style.background = "#000";
        btn.style.color = "#fff";
        btn.style.border = "2px solid #fff";
        btn.style.borderRadius = "50%";
        btn.style.boxSizing = "border-box";
        btn.style.cursor = hasPrevious ? "pointer" : "default";
        btn.style.opacity = hasPrevious ? "0.7" : "0.3";
        btn.style.transition = "opacity 0.2s";
        btn.disabled = !hasPrevious;

        if (hasPrevious) {
            btn.onmouseover = () => btn.style.opacity = "1";
            btn.onmouseout = () => btn.style.opacity = "0.7";
        }

        btn.onclick = () => {
            if (!isContextValid() || btn.disabled) return;
            chrome.runtime.sendMessage({ type: "PREV_STAGGERED" });
        };

        document.body.appendChild(btn);
    }

    function createCounter(current, total) {
        if (document.getElementById("stagger-counter")) return;

        const counter = document.createElement("div");
        counter.id = "stagger-counter";
        counter.textContent = `${String(current).padStart(2, '0')}/${String(total).padStart(2, '0')}`;
        counter.style.position = "fixed";
        counter.style.top = "20px";
        counter.style.right = "135px";
        counter.style.zIndex = "999999";
        counter.style.background = "rgba(0, 0, 0, 0.7)";
        counter.style.color = "#fff";
        counter.style.padding = "5px 10px";
        counter.style.borderRadius = "5px";
        counter.style.fontSize = "16px";
        counter.style.fontWeight = "bold";
        counter.style.fontFamily = "monospace";
        document.body.appendChild(counter);
    }


    let response;
    if (isContextValid()) {
        try {
            response = await chrome.runtime.sendMessage({ type: "CHECK_STAGGERED" });
        } catch (e) {
            console.warn("Stagger Nav: Failed to send initial CHECK_STAGGERED message", e);
        }
    }
    
    if (response && response.isStaggered) {
        createForwardBtn();
        createBackBtn(!!response.hasPrevious);
        if (isTikTokPage) createFpButton();
        if (response.total) {
            createCounter(response.currentIndex, response.total);
        }

        // Check for pending notification
        try {
            const notifyRes = await chrome.storage.local.get('stagger_append_notify');
            const data = notifyRes.stagger_append_notify;
            if (data) {
                await chrome.storage.local.remove('stagger_append_notify');
                showNotification(`Appended ${data.appended} link(s).\nTotal in memory: ${data.total}`, '#4ecdc4');
            }
        } catch (e) {}

        // -----------------------------
        // AUTOMATION LOGIC
        // -----------------------------
        let pollInterval = null;

        async function startPolling() {
            if (pollInterval) clearInterval(pollInterval);
            if (!isContextValid() || !isTikTokPage) return;

            const res = await chrome.storage.local.get(["automatic_load_enabled", "fast_mode_enabled", "staggered_scan_baselines"]);
            if (!res.automatic_load_enabled) return;

            console.log("Staggered Navigation: Automatic Load is enabled.");
            
            const baselines = res.staggered_scan_baselines || {};
            const handleMatch = location.pathname.match(/^\/(@[^/]+)/);
            const handle = handleMatch ? handleMatch[1] : null;
            // Same reasoning as in hasNewVideos(): a missing entry means
            // "never scanned before", not "baseline is 0".
            const rawBaseline = handle ? baselines[`tiktok_last_post:${handle}`] : null;
            const baseline = rawBaseline ? rawBaseline : Infinity;

            let pollCount = 0;
            const maxPolls = 10;

            pollInterval = setInterval(async () => {
                if (!isContextValid()) {
                    clearInterval(pollInterval);
                    return;
                }
                pollCount++;
                
                // 1. Check for "Something went wrong" (case-insensitive) as a "hit"
                // This is a page-load failure signal, not a content check, so it
                // still fires immediately regardless of threshold.
                const pageText = document.body.innerText;
                if (pageText && /Something went wrong/i.test(pageText)) {
                    console.log("Staggered Navigation: 'Something went wrong' detected! Stopping automation.");
                    clearInterval(pollInterval);
                    await logPassSnapshot('stopped_error_text', { baseline });
                    if (isContextValid()) {
                        chrome.runtime.sendMessage({ type: "PLAY_SOUND", sound: "new_videos" });
                    }
                    return;
                }

                // Give the page (and the userscript's own "new" detection,
                // which needs a moment to compute and render) a beat before
                // either "new content" check below runs. Without this, our
                // fallback scrape can win a race against the userscript on
                // literally the first tick, stopping the page before the
                // userscript has rendered anything - which then looks like
                // "it beeped but nothing is actually shown as new".
                const pollThreshold = res.fast_mode_enabled ? 1 : 3;
                if (pollCount < pollThreshold) {
                    return;
                }

                // 2. Check for the userscript element as a primary signal
                const newCountElement = document.getElementById('tt-thumb-meta__new-count');
                if (newCountElement && parseInt(newCountElement.textContent) > 0) {
                    console.log("Staggered Navigation: New videos found via userscript signal! Stopping automation.");
                    clearInterval(pollInterval);
                    await logPassSnapshot('stopped_badge', { baseline, badgeText: newCountElement.textContent });
                    chrome.runtime.sendMessage({ type: "PLAY_SOUND", sound: "new_videos" });
                    return;
                }

                // 3. Direct scraping fallback to ensure robustness (videos only, never photos)
                const links = document.querySelectorAll('a[href*="/video/"]');
                const scrapeCandidates = [];
                for (const a of links) {
                    const postIdMatch = a.href.match(/\/video\/(\d{10,})/);
                    if (postIdMatch) {
                        try {
                            const ts = Number(BigInt(postIdMatch[1]) >> 32n) * 1000;
                            if (ts > baseline) {
                                scrapeCandidates.push({ url: a.href.split('?')[0], ts });
                            }
                        } catch(e) {}
                    }
                }

                if (scrapeCandidates.length > 0) {
                    console.log("Staggered Navigation: New videos found via direct scraping! Stopping automation.");
                    clearInterval(pollInterval);
                    await logPassSnapshot('stopped_scrape', { baseline, scrapeCandidates });
                    if (isContextValid()) {
                        chrome.runtime.sendMessage({ type: "PLAY_SOUND", sound: "new_videos" });
                    }
                    return;
                }

                // Continue polling if no videos yet or we haven't given the userscript long enough
                if (document.querySelectorAll('[data-e2e="user-post-item"]').length > 0) {
                    console.log(`Staggered Navigation: No new content found after ${pollThreshold}s of active content. Advancing.`);
                    clearInterval(pollInterval);
                    await logPassSnapshot('advanced_no_new', { baseline });
                    const delay = res.fast_mode_enabled ? 200 : Math.floor(Math.random() * 2000) + 1000;
                    setTimeout(() => {
                        if (isContextValid()) {
                            chrome.runtime.sendMessage({ type: "NEXT_STAGGERED" });
                        }
                    }, delay);
                } else if (pollCount >= maxPolls) {
                    console.log("Staggered Navigation: No new content found after timeout. Advancing.");
                    clearInterval(pollInterval);
                    await logPassSnapshot('advanced_timeout', { baseline });
                    const delay = res.fast_mode_enabled ? 200 : Math.floor(Math.random() * 2000) + 1000;
                    setTimeout(() => {
                        if (isContextValid()) {
                            chrome.runtime.sendMessage({ type: "NEXT_STAGGERED" });
                        }
                    }, delay);
                }
            }, 1000);
        }

        startPolling();

        if (isContextValid()) {
            chrome.storage.onChanged.addListener((changes) => {
                if (changes.automatic_load_enabled || changes.fast_mode_enabled) {
                    if ((changes.automatic_load_enabled && changes.automatic_load_enabled.newValue) ||
                        (changes.fast_mode_enabled)) {
                        startPolling();
                    } else {
                        if (pollInterval) clearInterval(pollInterval);
                    }
                }
            });
        }
    }
})();
