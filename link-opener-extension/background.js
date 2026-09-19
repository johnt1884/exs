// -----------------------------
// CONFIG (smarter + human-like)
// -----------------------------
const BATCH_SIZE = 3;

const MIN_DELAY = 2000;
const MAX_DELAY = 6000;

const MIN_BATCH_DELAY = 8000;
const MAX_BATCH_DELAY = 20000;

const LONG_PAUSE_EVERY = 20;
const LONG_PAUSE_MIN = 30000;
const LONG_PAUSE_MAX = 90000;

// -----------------------------
// UTIL
// -----------------------------
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function rand(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Chrome throws "Tabs cannot be edited right now (user may be dragging a
// tab)" transiently - not just for literal manual dragging, but also when
// tab create/remove calls happen in quick succession (which the staggered
// flow does constantly: close one tab, open the next). It normally clears
// within a few hundred ms, so retry a few times instead of letting the
// whole operation - and the staggered queue's state persistence right
// after it - fail outright.
async function withTabRetry(fn, retries = 5, delayMs = 400) {
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            return await fn();
        } catch (e) {
            const msg = (e && e.message) || String(e);
            if (/dragging a tab|cannot be edited right now/i.test(msg) && attempt < retries - 1) {
                await sleep(delayMs);
                continue;
            }
            throw e;
        }
    }
}

// -----------------------------
// CORE LOGIC
// -----------------------------
function transformSpecialUrl(url) {
    const decodedUrl = decodeURIComponent(url);
    // Only TikTok profile links get redirected through ssstiktok.dev.
    // " #" links on other domains are opened/staggered as-is, using the
    // same system as any other link.
    if (decodedUrl.includes(" #") && /tiktok\.com/i.test(decodedUrl)) {
        const match = decodedUrl.match(/@([^\/ #]+)/);
        if (match) {
            const username = match[1];
            return `https://ssstiktok.dev/#username=${username}`;
        }
    }
    return url;
}

async function openTabsSmart(urls) {
    urls = urls.map(transformSpecialUrl);

    const [currentTab] = await chrome.tabs.query({
        active: true,
        currentWindow: true
    });

    let openedCount = 0;

    for (let i = 0; i < urls.length; i += BATCH_SIZE) {
        const batch = urls.slice(i, i + BATCH_SIZE);

        for (const url of batch) {
            try {
                const tab = await chrome.tabs.create({
                    url: url,
                    active: false
                });

                chrome.tabs.update(tab.id, {
                    autoDiscardable: false
                });

                openedCount++;

                // human-like delay
                await sleep(rand(MIN_DELAY, MAX_DELAY));

            } catch (err) {
                console.warn("Tab open failed:", err);

                // backoff if something weird happens
                await sleep(rand(15000, 40000));
            }
        }

        // long pause every X tabs (very important)
        if (openedCount % LONG_PAUSE_EVERY === 0) {
            await sleep(rand(LONG_PAUSE_MIN, LONG_PAUSE_MAX));
        }

        // batch delay
        if (i + BATCH_SIZE < urls.length) {
            await sleep(rand(MIN_BATCH_DELAY, MAX_BATCH_DELAY));
        }
    }

}

// -----------------------------
// STAGGERED LOGIC
// -----------------------------
let staggeredQueue = [];
let staggeredHistory = []; // URLs already visited, in order; last entry is the current one
let currentStaggeredTabId = null;
let staggeredOpenerTabId = null;

async function startStaggered(urls, openerTabId) {
    if (!urls || urls.length === 0) return;
    
    urls = urls.map(transformSpecialUrl);

    const total = urls.length;
    const currentIndex = 1;
    staggeredQueue = [...urls];
    staggeredHistory = [];
    staggeredOpenerTabId = openerTabId;
    const nextUrl = staggeredQueue.shift();
    staggeredHistory.push(nextUrl);

    let tab;
    try {
        tab = await withTabRetry(() => chrome.tabs.create({ url: nextUrl, active: false }));
    } catch (e) {
        console.warn("Staggered: failed to open first tab", e);
        return; // nothing was persisted yet, so state is untouched - safe to just stop
    }
    currentStaggeredTabId = tab.id;
    
    // Save queue state in case background is suspended (though it's a service worker)
    await chrome.storage.local.set({ 
        staggeredQueue, 
        staggeredHistory,
        currentStaggeredTabId,
        staggeredOpenerTabId,
        staggeredTotal: total,
        staggeredCurrentIndex: currentIndex
    });
}

async function nextStaggered(senderTabId) {
    // Reload state in case background script was suspended
    const data = await chrome.storage.local.get(['staggeredQueue', 'staggeredHistory', 'currentStaggeredTabId', 'staggeredOpenerTabId', 'staggeredTotal', 'staggeredCurrentIndex']);
    staggeredQueue = data.staggeredQueue || [];
    staggeredHistory = data.staggeredHistory || [];
    currentStaggeredTabId = data.currentStaggeredTabId;
    staggeredOpenerTabId = data.staggeredOpenerTabId;
    let total = data.staggeredTotal || 0;
    let currentIndex = data.staggeredCurrentIndex || 0;

    // Reliability: Close the tab that triggered the next (usually currentStaggeredTabId)
    // If senderTabId is provided (automatic mode from content script), we close that specific tab.
    const tabToClose = senderTabId || currentStaggeredTabId;

    let wasActive = false;
    if (tabToClose) {
        try {
            const tab = await chrome.tabs.get(tabToClose);
            wasActive = tab.active;
            await withTabRetry(() => chrome.tabs.remove(tabToClose));
        } catch (e) {
            console.warn("Could not remove tab:", e);
        }
    }

    if (staggeredQueue.length > 0) {
        const nextUrl = staggeredQueue[0];
        let tab;
        try {
            // If the user was looking at the tab we just closed, they likely want to stay in the flow.
            // Otherwise, open in background.
            tab = await withTabRetry(() => chrome.tabs.create({ url: nextUrl, active: wasActive }));
        } catch (e) {
            console.warn("Staggered: failed to open next tab, will retry on next NEXT_STAGGERED call", e);
            // Don't shift the queue or touch currentStaggeredTabId - persist
            // exactly what we reloaded above so nothing is lost, and leave
            // the URL at the front of the queue so the next attempt (the
            // person clicking forward again, or the automation's own retry)
            // picks up from the same spot instead of skipping it.
            await chrome.storage.local.set({ staggeredQueue, staggeredHistory, currentStaggeredTabId: null, staggeredCurrentIndex: currentIndex });
            return;
        }
        currentIndex++;
        staggeredQueue.shift();
        staggeredHistory.push(nextUrl);
        currentStaggeredTabId = tab.id;
    } else {
        currentStaggeredTabId = null;
        if (staggeredOpenerTabId) {
            chrome.tabs.sendMessage(staggeredOpenerTabId, { type: "STAGGERED_FINISHED" }).catch(() => {});
        }
    }

    await chrome.storage.local.set({ 
        staggeredQueue, 
        staggeredHistory,
        currentStaggeredTabId,
        staggeredCurrentIndex: currentIndex
    });
}

async function prevStaggered(senderTabId) {
    // Reload state in case background script was suspended
    const data = await chrome.storage.local.get(['staggeredQueue', 'staggeredHistory', 'currentStaggeredTabId', 'staggeredOpenerTabId', 'staggeredTotal', 'staggeredCurrentIndex']);
    staggeredQueue = data.staggeredQueue || [];
    staggeredHistory = data.staggeredHistory || [];
    currentStaggeredTabId = data.currentStaggeredTabId;
    staggeredOpenerTabId = data.staggeredOpenerTabId;
    let total = data.staggeredTotal || 0;
    let currentIndex = data.staggeredCurrentIndex || 0;

    // Nothing to go back to
    if (staggeredHistory.length <= 1) return;

    const tabToClose = senderTabId || currentStaggeredTabId;

    let wasActive = false;
    if (tabToClose) {
        try {
            const tab = await chrome.tabs.get(tabToClose);
            wasActive = tab.active;
            await withTabRetry(() => chrome.tabs.remove(tabToClose));
        } catch (e) {
            console.warn("Could not remove tab:", e);
        }
    }

    // Pull the current URL off history and put it back at the front of the
    // queue, so pressing forward again will simply revisit it.
    const currentUrl = staggeredHistory[staggeredHistory.length - 1];
    const prevUrl = staggeredHistory[staggeredHistory.length - 2];

    let tab;
    try {
        tab = await withTabRetry(() => chrome.tabs.create({ url: prevUrl, active: wasActive }));
    } catch (e) {
        console.warn("Staggered: failed to open previous tab", e);
        await chrome.storage.local.set({ staggeredQueue, staggeredHistory, currentStaggeredTabId: null, staggeredCurrentIndex: currentIndex });
        return;
    }

    staggeredHistory.pop();
    staggeredQueue.unshift(currentUrl);
    currentIndex = Math.max(1, currentIndex - 1);
    currentStaggeredTabId = tab.id;

    await chrome.storage.local.set({
        staggeredQueue,
        staggeredHistory,
        currentStaggeredTabId,
        staggeredCurrentIndex: currentIndex
    });
}

// -----------------------------
// ACTION (EXTENSION ICON CLICK)
// -----------------------------
chrome.action.onClicked.addListener((tab) => {
    chrome.tabs.sendMessage(tab.id, { type: "ACTION_CLICKED" }).catch(() => {
        // Fallback if content script not loaded/ready
        console.warn("Action clicked but content script not responding in tab", tab.id);
    });
});

// -----------------------------
// MESSAGE LISTENER
// -----------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "OPEN_TABS_SMART") {
        openTabsSmart(message.urls).catch(e => console.warn("openTabsSmart failed", e));
    } else if (message.type === "START_STAGGERED") {
        startStaggered(message.urls, sender.tab?.id).catch(e => console.warn("startStaggered failed", e));
    } else if (message.type === "NEXT_STAGGERED") {
        nextStaggered(sender.tab?.id).catch(e => console.warn("nextStaggered failed", e));
    } else if (message.type === "PREV_STAGGERED") {
        prevStaggered(sender.tab?.id).catch(e => console.warn("prevStaggered failed", e));
    } else if (message.type === "PLAY_SOUND") {
        chrome.storage.local.get(['staggeredOpenerTabId']).then(data => {
            if (data.staggeredOpenerTabId) {
                chrome.tabs.sendMessage(data.staggeredOpenerTabId, { type: "PLAY_SOUND", sound: message.sound }).catch(() => {});
            }
        });
    } else if (message.type === "CHECK_STAGGERED") {
        chrome.storage.local.get(['currentStaggeredTabId', 'staggeredTotal', 'staggeredCurrentIndex', 'staggeredHistory']).then(data => {
            sendResponse({
                isStaggered: sender.tab && sender.tab.id === data.currentStaggeredTabId,
                total: data.staggeredTotal,
                currentIndex: data.staggeredCurrentIndex,
                hasPrevious: (data.staggeredHistory || []).length > 1
            });
        });
        return true; // async response
    }
});
