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

// -----------------------------
// CORE LOGIC
// -----------------------------
async function openTabsSmart(urls) {
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
let currentStaggeredTabId = null;
let staggeredOpenerTabId = null;

async function startStaggered(urls, openerTabId) {
    if (!urls || urls.length === 0) return;
    
    const total = urls.length;
    const currentIndex = 1;
    staggeredQueue = [...urls];
    staggeredOpenerTabId = openerTabId;
    const nextUrl = staggeredQueue.shift();
    
    const tab = await chrome.tabs.create({ url: nextUrl, active: false });
    currentStaggeredTabId = tab.id;
    
    // Save queue state in case background is suspended (though it's a service worker)
    await chrome.storage.local.set({ 
        staggeredQueue, 
        currentStaggeredTabId,
        staggeredOpenerTabId,
        staggeredTotal: total,
        staggeredCurrentIndex: currentIndex
    });
}

async function nextStaggered(senderTabId) {
    // Reload state in case background script was suspended
    const data = await chrome.storage.local.get(['staggeredQueue', 'currentStaggeredTabId', 'staggeredOpenerTabId', 'staggeredTotal', 'staggeredCurrentIndex']);
    staggeredQueue = data.staggeredQueue || [];
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
            await chrome.tabs.remove(tabToClose);
        } catch (e) {
            console.warn("Could not remove tab:", e);
        }
    }

    if (staggeredQueue.length > 0) {
        currentIndex++;
        const nextUrl = staggeredQueue.shift();
        // If the user was looking at the tab we just closed, they likely want to stay in the flow.
        // Otherwise, open in background.
        const tab = await chrome.tabs.create({ url: nextUrl, active: wasActive });
        currentStaggeredTabId = tab.id;
    } else {
        currentStaggeredTabId = null;
        if (staggeredOpenerTabId) {
            chrome.tabs.sendMessage(staggeredOpenerTabId, { type: "STAGGERED_FINISHED" }).catch(() => {});
        }
    }

    await chrome.storage.local.set({ 
        staggeredQueue, 
        currentStaggeredTabId,
        staggeredCurrentIndex: currentIndex
    });
}

// -----------------------------
// MESSAGE LISTENER
// -----------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "OPEN_TABS_SMART") {
        openTabsSmart(message.urls);
    } else if (message.type === "START_STAGGERED") {
        startStaggered(message.urls, sender.tab?.id);
    } else if (message.type === "NEXT_STAGGERED") {
        nextStaggered(sender.tab?.id);
    } else if (message.type === "PLAY_SOUND") {
        chrome.storage.local.get(['staggeredOpenerTabId']).then(data => {
            if (data.staggeredOpenerTabId) {
                chrome.tabs.sendMessage(data.staggeredOpenerTabId, { type: "PLAY_SOUND", sound: message.sound }).catch(() => {});
            }
        });
    } else if (message.type === "CHECK_STAGGERED") {
        chrome.storage.local.get(['currentStaggeredTabId', 'staggeredTotal', 'staggeredCurrentIndex']).then(data => {
            sendResponse({
                isStaggered: sender.tab && sender.tab.id === data.currentStaggeredTabId,
                total: data.staggeredTotal,
                currentIndex: data.staggeredCurrentIndex
            });
        });
        return true; // async response
    }
});
