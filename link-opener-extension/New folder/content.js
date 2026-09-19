// -----------------------------
// SEND TO BACKGROUND
// -----------------------------
function openLinks(urls) {
    try {
        chrome.runtime.sendMessage({
            type: "OPEN_TABS_SMART",
            urls: urls
        });
    } catch (e) {
        console.warn("Link Batch Opener: Failed to send message. Context might be invalidated.", e);
    }
}

async function startStaggered(urls) {
    // Capture current baselines for all TikTok accounts to detect 'new' content during this run
    const baselines = {};
    const storage = await safeStorage.get(null); // Get all to find tiktok_last_post keys
    Object.keys(storage).forEach(key => {
        if (key.startsWith("tiktok_last_post:")) {
            baselines[key] = storage[key];
        }
    });
    await safeStorage.set({ "staggered_scan_baselines": baselines });

    try {
        chrome.runtime.sendMessage({
            type: "START_STAGGERED",
            urls: urls
        });
    } catch (e) {
        console.warn("Link Batch Opener: Failed to start staggered. Context might be invalidated.", e);
    }
}

// -----------------------------
// SAFE STORAGE & CONTEXT
// -----------------------------
function isContextValid() {
    try {
        return typeof chrome !== "undefined" && !!chrome.runtime && !!chrome.runtime.id;
    } catch (e) {
        return false;
    }
}

const safeStorage = {
    get: async (keys) => {
        if (!isContextValid() || !chrome.storage || !chrome.storage.local) {
            console.warn("Link Batch Opener: Extension context invalidated or storage unavailable.");
            return {};
        }
        try {
            return await chrome.storage.local.get(keys);
        } catch (e) {
            console.warn("Link Batch Opener: Storage get failed.", e);
            return {};
        }
    },
    set: async (obj) => {
        if (!isContextValid() || !chrome.storage || !chrome.storage.local) {
            return;
        }
        try {
            await chrome.storage.local.set(obj);
        } catch (e) {
            console.warn("Link Batch Opener: Storage set failed.", e);
        }
    }
};

// -----------------------------
// PERSISTENCE & CATEGORIES
// -----------------------------
const SELECTED_KEY_PREFIX = "selected_links:";
const SORT_MODE_KEY_PREFIX = "sort_mode:";
const CATEGORIES_KEY = "categories_list";
const URL_CATEGORIES_KEY = "url_categories_map";
const ACTIVE_CATEGORIES_KEY = "active_categories_set";
const AUTOMATIC_LOAD_KEY = "automatic_load_enabled";
const FAST_MODE_KEY = "fast_mode_enabled";

function getPageKey(prefix) {
    return prefix + location.pathname;
}

async function saveSelections() {
    const selected = getSelectedLinks();
    const key = getPageKey(SELECTED_KEY_PREFIX);
    await safeStorage.set({ [key]: selected });
}

async function loadSelections() {
    const key = getPageKey(SELECTED_KEY_PREFIX);
    const result = await safeStorage.get(key);
    const selectedUrls = result[key] || [];
    
    const checkboxes = document.querySelectorAll(".link-checkbox");
    checkboxes.forEach(cb => {
        const url = cb.dataset.href;
        if (url && selectedUrls.includes(url)) {
            cb.checked = true;
        }
    });
    updateUI();
}

async function saveSortMode(mode) {
    const key = getPageKey(SORT_MODE_KEY_PREFIX);
    await safeStorage.set({ [key]: mode });
}

async function loadSortMode() {
    const key = getPageKey(SORT_MODE_KEY_PREFIX);
    const result = await safeStorage.get(key);
    const mode = result[key] || "unsorted";
    const sortSelect = bar ? bar.querySelector("select") : null;
    if (sortSelect) {
        sortSelect.value = mode;
        if (mode !== "unsorted") {
            await applySort(mode);
        }
    }
}

async function getCategories() {
    const result = await safeStorage.get(CATEGORIES_KEY);
    return result[CATEGORIES_KEY] || [];
}

async function saveCategories(list) {
    await safeStorage.set({ [CATEGORIES_KEY]: list });
}

async function getUrlCategories() {
    const result = await safeStorage.get(URL_CATEGORIES_KEY);
    return result[URL_CATEGORIES_KEY] || {};
}

async function saveUrlCategories(map) {
    await safeStorage.set({ [URL_CATEGORIES_KEY]: map });
}

async function getActiveCategories() {
    const result = await safeStorage.get(ACTIVE_CATEGORIES_KEY);
    return result[ACTIVE_CATEGORIES_KEY] || ["Unsorted"];
}

async function saveActiveCategories(list) {
    await safeStorage.set({ [ACTIVE_CATEGORIES_KEY]: list });
}

// -----------------------------
// DATE UTIL (from userscript)
// -----------------------------
function extractPostIdFromHref(href) {
    const match = String(href || '').match(/\/(?:video|photo)\/(\d{10,})/);
    return match ? match[1] : '';
}

function deriveDateFromPostId(postId) {
    if (!postId) return null;
    try {
        const seconds = Number(BigInt(postId) >> 32n);
        if (!Number.isFinite(seconds)) return null;
        if (seconds < 1420070400 || seconds > 2524608000) return null;
        return new Date(seconds * 1000);
    } catch (error) {
        return null;
    }
}

async function getTimestampForLink(link) {
    const postId = extractPostIdFromHref(link.href);
    let dateObj = deriveDateFromPostId(postId);

    if (!dateObj) {
        const handleMatch = link.href.match(/tiktok\.com\/(@[^/]+)\/?$/);
        if (handleMatch) {
            const handle = handleMatch[1];
            const key = `tiktok_last_post:${handle}`;
            const result = await safeStorage.get(key);
            if (result[key]) {
                dateObj = new Date(result[key]);
            }
        }
    }
    return dateObj ? dateObj.getTime() : null;
}

function formatDate(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
    const options = {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
    };
    try {
        return new Intl.DateTimeFormat(undefined, options).format(date);
    } catch (error) {
        return date.toLocaleString();
    }
}

// -----------------------------
// GET LINKS
// -----------------------------
function getAllLinks() {
    return Array.from(document.querySelectorAll("a[href]"))
        .map(a => a.href)
        .filter(h => h.startsWith("http"));
}

function getSelectedLinks() {
    return Array.from(document.querySelectorAll(".link-checkbox:not(:disabled):checked"))
        .map(cb => cb.dataset.href)
        .filter(Boolean);
}

// -----------------------------
// SORTING
// -----------------------------
let originalStructure = null;
let originalParent = null;

function storeOriginalStructure() {
    if (!originalStructure) {
        const container = document.getElementById('links-container') || document.body;
        originalParent = container;
        const children = Array.from(container.children).filter(el => el !== bar);
        originalStructure = children.map(child => {
            const clone = child.cloneNode(true);
            clone.querySelectorAll(".link-checkbox, .date-suffix, button, .category-controls").forEach(el => el.remove());
            return clone;
        });
    }
}

async function applySort(mode) {
    storeOriginalStructure();
    
    const container = originalParent;

    if (mode === "unsorted") {
        Array.from(container.children).forEach(child => {
            if (child !== bar) child.remove();
        });
        
        originalStructure.forEach(el => {
            if (bar && bar.parentElement === container) {
                container.insertBefore(el.cloneNode(true), bar);
            } else {
                container.appendChild(el.cloneNode(true));
            }
        });
        
        await addCheckboxes();
        addGroupButtons();
        await loadSelections();
        await applyCategoryFilters();
        await saveSortMode(mode);
        return;
    }

    const itemsWithDates = [];
    
    // Use a temporary container to extract all LI items from the original structure
    // to ensure we always use the initial HTML order as the baseline.
    const tempContainer = document.createElement("div");
    originalStructure.forEach(node => tempContainer.appendChild(node.cloneNode(true)));
    const allListItems = tempContainer.querySelectorAll("li");
    
    let globalIndex = 0;
    for (const li of allListItems) {
        const link = li.querySelector("a[href]");
        if (link) {
            const ts = await getTimestampForLink(link);
            const cleanLi = li.cloneNode(true);
            cleanLi.querySelectorAll(".link-checkbox, .date-suffix, .category-controls").forEach(el => el.remove());
            itemsWithDates.push({ li: cleanLi, ts, originalIndex: globalIndex++ });
        }
    }

    Array.from(container.children).forEach(child => {
        if (child !== bar && (child.tagName === "H3" || child.tagName === "UL" || child.tagName === "DIV" || child.tagName === "P" || child.tagName === "H1" || child.tagName === "H2")) {
             if (child.tagName === "H3" || child.tagName === "UL") child.remove();
        }
    });

    if (mode === "recent_first" || mode === "recent_last") {
        const sorted = itemsWithDates.filter(i => i.ts !== null).sort((a, b) => {
            if (b.ts !== a.ts) {
                return mode === "recent_first" ? b.ts - a.ts : a.ts - b.ts;
            }
            return a.originalIndex - b.originalIndex;
        });
        const unsorted = itemsWithDates.filter(i => i.ts === null).sort((a, b) => a.originalIndex - b.originalIndex);

        const newHeader = document.createElement("h3");
        newHeader.textContent = mode === "recent_first" ? "All Items (Most Recent First)" : "All Items (Most Recent Last)";
        const newList = document.createElement("ul");
        
        sorted.forEach(i => newList.appendChild(i.li));
        unsorted.forEach(i => newList.appendChild(i.li));

        if (bar && bar.parentElement === container) {
            container.insertBefore(newHeader, bar);
            container.insertBefore(newList, bar);
        } else {
            container.appendChild(newHeader);
            container.appendChild(newList);
        }

    } else if (mode === "custom_headers") {
        const now = Date.now();
        const intervals = [
            { label: "Past Week", threshold: now - 7 * 24 * 60 * 60 * 1000 },
            { label: "Past Fortnight", threshold: now - 14 * 24 * 60 * 60 * 1000 },
            { label: "Past Month", threshold: now - 30 * 24 * 60 * 60 * 1000 },
            { label: "Past Two Months", threshold: now - 60 * 24 * 60 * 60 * 1000 },
            { label: "Past Four Months", threshold: now - 120 * 24 * 60 * 60 * 1000 },
            { label: "Past Four Months +", threshold: 0 }
        ];

        const grouped = {};
        intervals.forEach(int => grouped[int.label] = []);
        grouped["No Date"] = [];

        itemsWithDates.forEach(item => {
            if (item.ts === null) {
                grouped["No Date"].push(item);
            } else {
                const found = intervals.find(int => item.ts >= int.threshold);
                if (found) grouped[found.label].push(item);
                else grouped["Past Four Months +"].push(item);
            }
        });

        [...intervals.map(i => i.label), "No Date"].forEach(label => {
            if (grouped[label].length > 0) {
                const newHeader = document.createElement("h3");
                newHeader.textContent = label;
                const newList = document.createElement("ul");
                // Within each section, preserve original index order
                grouped[label].sort((a, b) => a.originalIndex - b.originalIndex).forEach(item => newList.appendChild(item.li));
                
                if (bar && bar.parentElement === container) {
                    container.insertBefore(newHeader, bar);
                    container.insertBefore(newList, bar);
                } else {
                    container.appendChild(newHeader);
                    container.appendChild(newList);
                }
            }
        });
    }

    await addCheckboxes();
    addGroupButtons();
    await loadSelections();
    await applyCategoryFilters();
    await saveSortMode(mode);
}

// -----------------------------
// UI BAR (FIXED BOTTOM)
// -----------------------------
let bar, selectedBtn, countSpan, categoryMenu;

function createBottomBar() {
    const existingBar = document.getElementById("link-batch-opener-bar");
    if (existingBar) existingBar.remove();
    const existingPopup = document.getElementById("link-batch-category-popup");
    if (existingPopup) existingPopup.remove();

    bar = document.createElement("div");
    bar.id = "link-batch-opener-bar";

    bar.style.position = "fixed";
    bar.style.bottom = "0";
    bar.style.left = "0";
    bar.style.width = "100%";
    bar.style.background = "#111";
    bar.style.color = "#fff";
    bar.style.padding = "10px";
    bar.style.zIndex = "999999";
    bar.style.display = "flex";
    bar.style.gap = "10px";
    bar.style.alignItems = "center";
    bar.style.boxShadow = "0 -2px 6px rgba(0,0,0,0.3)";

    const openAllBtn = document.createElement("button");
    openAllBtn.textContent = "Open All";
    openAllBtn.onclick = () => openLinks(getAllLinks());

    selectedBtn = document.createElement("button");
    selectedBtn.textContent = "Open Selected";
    selectedBtn.onclick = () => openLinks(getSelectedLinks());
    selectedBtn.disabled = true;

    const deselectAllBtn = document.createElement("button");
    deselectAllBtn.textContent = "Deselect All";
    deselectAllBtn.onclick = async () => {
        document.querySelectorAll(".link-checkbox").forEach(cb => cb.checked = false);
        updateUI();
        await saveSelections();
    };

    const loadAllStaggeredBtn = document.createElement("button");
    loadAllStaggeredBtn.textContent = "Load All Staggered";
    loadAllStaggeredBtn.onclick = () => startStaggered(getAllLinks());

    const loadSelectedStaggeredBtn = document.createElement("button");
    loadSelectedStaggeredBtn.textContent = "Load Selected Staggered";
    loadSelectedStaggeredBtn.onclick = () => startStaggered(getSelectedLinks());
    loadSelectedStaggeredBtn.disabled = true;

    const sortSelect = document.createElement("select");
    sortSelect.style.padding = "5px";
    sortSelect.style.borderRadius = "4px";
    
    const options = [
        { value: "unsorted", text: "Unsorted" },
        { value: "recent_first", text: "Sort by most recent first" },
        { value: "recent_last", text: "Sort by most recent last" },
        { value: "custom_headers", text: "Custom headers" }
    ];
    
    options.forEach(opt => {
        const o = document.createElement("option");
        o.value = opt.value;
        o.textContent = opt.text;
        sortSelect.appendChild(o);
    });
    
    sortSelect.onchange = (e) => applySort(e.target.value);

    const categoryBtn = document.createElement("button");
    categoryBtn.textContent = "Categories";
    categoryBtn.onclick = () => {
        const isHidden = categoryMenu.style.display === "none";
        categoryMenu.style.display = isHidden ? "block" : "none";
        if (isHidden) {
            renderCategoryMenu();
        }
    };

    countSpan = document.createElement("span");
    countSpan.textContent = "0 selected";

    const autoLoadContainer = document.createElement("div");
    autoLoadContainer.style.marginLeft = "auto";
    autoLoadContainer.style.marginRight = "50px";
    autoLoadContainer.style.display = "flex";
    autoLoadContainer.style.alignItems = "center";
    autoLoadContainer.style.gap = "5px";

    const autoLoadCb = document.createElement("input");
    autoLoadCb.type = "checkbox";
    autoLoadCb.id = "auto-load-checkbox";
    autoLoadCb.style.cursor = "pointer";
    autoLoadCb.onchange = async () => {
        await safeStorage.set({ [AUTOMATIC_LOAD_KEY]: autoLoadCb.checked });
    };

    const autoLoadLabel = document.createElement("label");
    autoLoadLabel.htmlFor = "auto-load-checkbox";
    autoLoadLabel.textContent = "Automatic Load";
    autoLoadLabel.style.cursor = "pointer";
    autoLoadLabel.style.fontSize = "14px";
    autoLoadLabel.style.marginRight = "15px";

    const fastModeCb = document.createElement("input");
    fastModeCb.type = "checkbox";
    fastModeCb.id = "fast-mode-checkbox";
    fastModeCb.style.cursor = "pointer";
    fastModeCb.onchange = async () => {
        await safeStorage.set({ [FAST_MODE_KEY]: fastModeCb.checked });
    };

    const fastModeLabel = document.createElement("label");
    fastModeLabel.htmlFor = "fast-mode-checkbox";
    fastModeLabel.textContent = "Fast Mode";
    fastModeLabel.style.cursor = "pointer";
    fastModeLabel.style.fontSize = "14px";

    autoLoadContainer.appendChild(autoLoadCb);
    autoLoadContainer.appendChild(autoLoadLabel);
    autoLoadContainer.appendChild(fastModeCb);
    autoLoadContainer.appendChild(fastModeLabel);

    bar.appendChild(openAllBtn);
    bar.appendChild(selectedBtn);
    bar.appendChild(deselectAllBtn);
    bar.appendChild(loadAllStaggeredBtn);
    bar.appendChild(loadSelectedStaggeredBtn);
    bar.appendChild(sortSelect);
    bar.appendChild(categoryBtn);
    bar.appendChild(countSpan);
    bar.appendChild(autoLoadContainer);

    // Load initial state
    safeStorage.get([AUTOMATIC_LOAD_KEY, FAST_MODE_KEY]).then(res => {
        autoLoadCb.checked = !!res[AUTOMATIC_LOAD_KEY];
        fastModeCb.checked = !!res[FAST_MODE_KEY];
    });

    categoryMenu = document.createElement("div");
    categoryMenu.id = "link-batch-category-popup";
    categoryMenu.style.position = "fixed";
    categoryMenu.style.bottom = "60px";
    categoryMenu.style.left = "10px";
    categoryMenu.style.background = "#222";
    categoryMenu.style.border = "1px solid #444";
    categoryMenu.style.padding = "10px";
    categoryMenu.style.display = "none";
    categoryMenu.style.minWidth = "280px";
    categoryMenu.style.maxHeight = "550px";
    categoryMenu.style.overflowY = "auto";
    categoryMenu.style.zIndex = "1000001";
    categoryMenu.style.cursor = "default";
    categoryMenu.style.userSelect = "none";
    
    // Dragging logic
    let isDragging = false;
    let offsetX, offsetY;

    categoryMenu.onmousedown = (e) => {
        if (e.target.tagName === "INPUT" || e.target.tagName === "BUTTON" || e.target.tagName === "SPAN") return;
        isDragging = true;
        offsetX = e.clientX - categoryMenu.offsetLeft;
        offsetY = e.clientY - categoryMenu.offsetTop;
    };

    document.addEventListener("mousemove", (e) => {
        if (isDragging) {
            categoryMenu.style.left = (e.clientX - offsetX) + "px";
            categoryMenu.style.top = (e.clientY - offsetY) + "px";
            categoryMenu.style.bottom = "auto";
        }
    });

    document.addEventListener("mouseup", () => {
        isDragging = false;
    });

    document.body.appendChild(categoryMenu);
    document.body.appendChild(bar);

    // prevent content being hidden under bar
    document.body.style.paddingBottom = "60px";
}

async function renderCategoryMenu() {
    const categories = await getCategories();
    const active = await getActiveCategories();
    
    categoryMenu.innerHTML = "";
    categoryMenu.style.color = "#fff";

    // 1. Top: Add New Category
    const addNewBtn = document.createElement("button");
    addNewBtn.textContent = "Add New Category";
    addNewBtn.style.width = "100%";
    addNewBtn.style.marginBottom = "10px";
    addNewBtn.onclick = async () => {
        const name = prompt("Enter new category name:");
        if (name && name.trim()) {
            const cats = await getCategories();
            if (!cats.includes(name.trim())) {
                cats.push(name.trim());
                await saveCategories(cats);
                renderCategoryMenu();
            }
        }
    };
    categoryMenu.appendChild(addNewBtn);

    categoryMenu.appendChild(document.createElement("hr"));

    // 2. Middle: Checkboxes for selection
    const filterTitle = document.createElement("div");
    filterTitle.innerHTML = "<strong>Select Categories to Show:</strong>";
    categoryMenu.appendChild(filterTitle);

    const listDiv = document.createElement("div");
    listDiv.style.margin = "5px 0";
    const allCategories = ["Unsorted", ...categories];
    
    allCategories.forEach(cat => {
        const div = document.createElement("div");
        div.style.padding = "2px 0";
        
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = active.includes(cat);
        cb.onchange = async () => {
            const currentActive = await getActiveCategories();
            let newActive;
            if (cb.checked) {
                newActive = [...currentActive, cat];
            } else {
                newActive = currentActive.filter(c => c !== cat);
            }
            await saveActiveCategories(newActive);
            await applyCategoryFilters();
        };
        
        const label = document.createElement("label");
        label.textContent = " " + cat;
        label.style.cursor = "pointer";
        label.onclick = () => cb.click();
        
        div.appendChild(cb);
        div.appendChild(label);
        listDiv.appendChild(div);
    });
    categoryMenu.appendChild(listDiv);

    categoryMenu.appendChild(document.createElement("hr"));

    // 3. Action Section
    const actionDiv = document.createElement("div");
    actionDiv.style.display = "flex";
    actionDiv.style.flexDirection = "column";
    actionDiv.style.gap = "8px";

    const addLinksRow = document.createElement("div");
    addLinksRow.style.display = "flex";
    addLinksRow.style.alignItems = "center";
    addLinksRow.style.gap = "5px";
    addLinksRow.innerHTML = "<span>Add links to:</span>";
    
    const catSelect = document.createElement("select");
    catSelect.style.flexGrow = "1";
    catSelect.style.padding = "2px";
    allCategories.forEach(cat => {
        const opt = document.createElement("option");
        opt.value = cat;
        opt.textContent = cat;
        catSelect.appendChild(opt);
    });
    addLinksRow.appendChild(catSelect);

    const doAddBtn = document.createElement("button");
    doAddBtn.textContent = "Add";
    doAddBtn.onclick = () => addSelectedToCategory(catSelect.value);
    addLinksRow.appendChild(doAddBtn);
    actionDiv.appendChild(addLinksRow);

    const manageRow = document.createElement("div");
    manageRow.style.display = "flex";
    manageRow.style.gap = "5px";
    
    const removeBtn = document.createElement("button");
    removeBtn.textContent = "Remove from category";
    removeBtn.style.flexGrow = "1";
    removeBtn.onclick = () => removeSelectedFromCategory(catSelect.value);
    
    const selectCatBtn = document.createElement("button");
    selectCatBtn.textContent = "Select";
    selectCatBtn.onclick = () => selectLinksInCategory(catSelect.value);
    
    manageRow.appendChild(removeBtn);
    manageRow.appendChild(selectCatBtn);
    actionDiv.appendChild(manageRow);

    categoryMenu.appendChild(actionDiv);
    categoryMenu.appendChild(document.createElement("hr"));

    // 4. Rename Section
    const renameTitle = document.createElement("div");
    renameTitle.innerHTML = "<strong>Category Management</strong>";
    categoryMenu.appendChild(renameTitle);

    const renameList = document.createElement("div");
    renameList.style.marginTop = "5px";
    categories.forEach(cat => {
        const div = document.createElement("div");
        div.style.display = "flex";
        div.style.gap = "5px";
        div.style.marginBottom = "5px";

        const input = document.createElement("input");
        input.type = "text";
        input.value = cat;
        input.style.flexGrow = "1";
        input.style.background = "#333";
        input.style.color = "#fff";
        input.style.border = "1px solid #555";
        input.style.padding = "2px 5px";

        const saveRenameBtn = document.createElement("button");
        saveRenameBtn.textContent = "Save";
        saveRenameBtn.onclick = () => renameCategory(cat, input.value);

        const deleteCatBtn = document.createElement("button");
        deleteCatBtn.textContent = "x";
        deleteCatBtn.style.color = "#ff4444";
        deleteCatBtn.onclick = () => deleteCategory(cat);

        div.appendChild(input);
        div.appendChild(saveRenameBtn);
        div.appendChild(deleteCatBtn);
        renameList.appendChild(div);
    });
    categoryMenu.appendChild(renameList);

    categoryMenu.appendChild(document.createElement("hr"));

    // 5. Data Backup Section
    const backupTitle = document.createElement("div");
    backupTitle.innerHTML = "<strong>Data Backup</strong>";
    backupTitle.style.marginBottom = "5px";
    categoryMenu.appendChild(backupTitle);

    const backupRow = document.createElement("div");
    backupRow.style.display = "flex";
    backupRow.style.gap = "5px";

    const exportBtn = document.createElement("button");
    exportBtn.textContent = "Export TXT";
    exportBtn.style.flexGrow = "1";
    exportBtn.onclick = () => exportData();

    const importBtn = document.createElement("button");
    importBtn.textContent = "Import TXT";
    importBtn.style.flexGrow = "1";
    importBtn.onclick = () => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".txt";
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (file) importData(file);
        };
        input.click();
    };

    backupRow.appendChild(exportBtn);
    backupRow.appendChild(importBtn);
    categoryMenu.appendChild(backupRow);
}

async function exportData() {
    const categories = await getCategories();
    const urlMap = await getUrlCategories();
    const storage = await safeStorage.get(null);
    const dates = {};
    Object.keys(storage).forEach(key => {
        if (key.startsWith("tiktok_last_post:")) {
            dates[key] = storage[key];
        }
    });

    let content = "[CATEGORIES]\n" + categories.join("\n") + "\n\n";
    content += "[URLS]\n";
    Object.keys(urlMap).forEach(url => {
        content += `${url}|${urlMap[url].join(",")}\n`;
    });
    content += "\n[DATES]\n";
    Object.keys(dates).forEach(key => {
        content += `${key}|${dates[key]}\n`;
    });

    const blob = new Blob([content], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "tiktok_link_batch_backup.txt";
    a.click();
}

async function importData(file) {
    const reader = new FileReader();
    reader.onload = async (e) => {
        const text = e.target.result;
        const sections = { categories: [], urls: {}, dates: {} };
        let currentSection = "";

        text.split("\n").forEach(line => {
            line = line.trim();
            if (!line) return;
            if (line === "[CATEGORIES]") currentSection = "categories";
            else if (line === "[URLS]") currentSection = "urls";
            else if (line === "[DATES]") currentSection = "dates";
            else {
                if (currentSection === "categories") {
                    sections.categories.push(line);
                } else if (currentSection === "urls") {
                    const [url, cats] = line.split("|");
                    if (url && cats) sections.urls[url] = cats.split(",");
                } else if (currentSection === "dates") {
                    const [key, val] = line.split("|");
                    if (key && val) sections.dates[key] = val;
                }
            }
        });

        const mode = confirm("Import Mode:\nClick OK to ADD (merge) data.\nClick Cancel to REPLACE all data.") ? "add" : "replace";

        if (mode === "replace") {
            await saveCategories(sections.categories);
            await saveUrlCategories(sections.urls);
            await safeStorage.set(sections.dates);
        } else {
            const oldCats = await getCategories();
            await saveCategories(Array.from(new Set([...oldCats, ...sections.categories])));
            
            const oldUrls = await getUrlCategories();
            Object.keys(sections.urls).forEach(url => {
                const merged = Array.from(new Set([...(oldUrls[url] || []), ...sections.urls[url]]));
                oldUrls[url] = merged;
            });
            await saveUrlCategories(oldUrls);
            await safeStorage.set(sections.dates);
        }

        alert("Import complete!");
        renderCategoryMenu();
        await applyCategoryFilters();
    };
    reader.readAsText(file);
}

async function applyCategoryFilters() {
    const active = await getActiveCategories();
    const urlMap = await getUrlCategories();
    
    const checkboxes = document.querySelectorAll(".link-checkbox");
    checkboxes.forEach(cb => {
        const url = cb.dataset.href;
        if (!url) return;
        
        const categories = urlMap[url] || [];
        const matches = categories.length === 0 
            ? active.includes("Unsorted")
            : categories.some(cat => active.includes(cat));

        // Note: multiple links might be in one LI, or links might be outside LI.
        // For simplicity, we affect the parent if it's an LI, but specifically enable/disable the checkbox.
        const parentLI = cb.closest("li");
        
        if (matches) {
            if (parentLI) parentLI.style.opacity = "1";
            cb.disabled = false;
        } else {
            // Only dim if ALL links in this LI are hidden? 
            // That's complex. Let's dim the checkbox and its link if possible.
            cb.disabled = true;
            cb.checked = false;
        }
    });

    // Second pass to handle LI opacity if they contain multiple checkboxes
    const allLIs = document.querySelectorAll("li");
    allLIs.forEach(li => {
        const cbs = li.querySelectorAll(".link-checkbox");
        if (cbs.length > 0) {
            const anyVisible = Array.from(cbs).some(c => !c.disabled);
            li.style.opacity = anyVisible ? "1" : "0.3";
        }
    });

    updateUI();
}

// -----------------------------
// CATEGORY MANAGEMENT
// -----------------------------

async function addSelectedToCategory(categoryName) {
    if (categoryName === "Unsorted") return;
    const selectedUrls = getSelectedLinks();
    if (selectedUrls.length === 0) {
        alert("No links selected.");
        return;
    }
    const urlMap = await getUrlCategories();
    selectedUrls.forEach(url => {
        const current = urlMap[url] || [];
        if (!current.includes(categoryName)) {
            current.push(categoryName);
            urlMap[url] = current;
        }
    });
    await saveUrlCategories(urlMap);
    await applyCategoryFilters();
}

async function removeSelectedFromCategory(categoryName) {
    const selectedUrls = getSelectedLinks();
    if (selectedUrls.length === 0) {
        alert("No links selected.");
        return;
    }
    const urlMap = await getUrlCategories();
    selectedUrls.forEach(url => {
        if (categoryName === "Unsorted") {
            // Removing from Unsorted means clearing all categories
            delete urlMap[url];
        } else if (urlMap[url]) {
            urlMap[url] = urlMap[url].filter(cat => cat !== categoryName);
            if (urlMap[url].length === 0) delete urlMap[url];
        }
    });
    await saveUrlCategories(urlMap);
    await applyCategoryFilters();
}

async function selectLinksInCategory(categoryName) {
    const urlMap = await getUrlCategories();
    const checkboxes = document.querySelectorAll(".link-checkbox:not(:disabled)");
    let found = false;
    checkboxes.forEach(cb => {
        const url = cb.dataset.href;
        if (url) {
            const categories = urlMap[url] || [];
            if (categoryName === "Unsorted") {
                if (categories.length === 0) {
                    cb.checked = true;
                    found = true;
                }
            } else if (categories.includes(categoryName)) {
                cb.checked = true;
                found = true;
            }
        }
    });
    if (found) {
        updateUI();
        await saveSelections();
    }
}

async function renameCategory(oldName, newName) {
    if (!newName || !newName.trim() || oldName === newName) return;
    newName = newName.trim();
    
    let categories = await getCategories();
    if (categories.includes(newName)) {
        alert("Category already exists.");
        return;
    }
    
    // Update categories list
    categories = categories.map(cat => cat === oldName ? newName : cat);
    await saveCategories(categories);
    
    // Update url map
    const urlMap = await getUrlCategories();
    Object.keys(urlMap).forEach(url => {
        urlMap[url] = urlMap[url].map(cat => cat === oldName ? newName : cat);
    });
    await saveUrlCategories(urlMap);
    
    // Update active categories
    let active = await getActiveCategories();
    active = active.map(cat => cat === oldName ? newName : cat);
    await saveActiveCategories(active);
    
    await applyCategoryFilters();
    renderCategoryMenu();
}

async function deleteCategory(categoryName) {
    if (!confirm(`Are you sure you want to delete category "${categoryName}"?`)) return;

    let categories = await getCategories();
    categories = categories.filter(cat => cat !== categoryName);
    await saveCategories(categories);

    const urlMap = await getUrlCategories();
    Object.keys(urlMap).forEach(url => {
        urlMap[url] = urlMap[url].filter(cat => cat !== categoryName);
        if (urlMap[url].length === 0) delete urlMap[url];
    });
    await saveUrlCategories(urlMap);

    let active = await getActiveCategories();
    active = active.filter(cat => cat !== categoryName);
    await saveActiveCategories(active);

    await applyCategoryFilters();
    renderCategoryMenu();
}

// -----------------------------
// UPDATE UI
// -----------------------------
function updateUI() {
    if (!bar) return;
    const selected = getSelectedLinks();
    const hasSelected = selected.length > 0;

    selectedBtn.disabled = !hasSelected;
    const loadSelectedStaggeredBtn = Array.from(bar.querySelectorAll("button")).find(b => b.textContent === "Load Selected Staggered");
    if (loadSelectedStaggeredBtn) loadSelectedStaggeredBtn.disabled = !hasSelected;

    countSpan.textContent = `${selected.length} selected`;

    const addBtn = document.getElementById("add-to-category-btn");
    if (addBtn) {
        addBtn.style.display = hasSelected ? "inline" : "none";
    }
}

// -----------------------------
// CHECKBOXES (BIGGER)
// -----------------------------
async function addCheckboxes() {
    const links = document.querySelectorAll("a[href]");

    for (const link of links) {
        if (!isContextValid()) break;
        
        let cb = null;
        const prev = link.previousElementSibling;
        if (prev && prev.classList.contains("link-checkbox")) {
            cb = prev;
        }

        if (!cb) {
            cb = document.createElement("input");
            cb.type = "checkbox";
            cb.className = "link-checkbox";
            cb.style.marginRight = "8px";
            cb.style.transform = "scale(1.4)";
            cb.style.cursor = "pointer";
            link.parentNode.insertBefore(cb, link);
        }

        cb.dataset.href = link.href;

        cb.onclick = async () => {
            updateUI();
            await saveSelections();
        };

        const ts = await getTimestampForLink(link);
        const dateStr = ts ? formatDate(new Date(ts)) : "";

        if (dateStr && !link.parentElement.querySelector(".date-suffix")) {
            const suffix = document.createElement("b");
            suffix.className = "date-suffix";
            suffix.textContent = ` [${dateStr}]`;
            link.parentNode.insertBefore(suffix, link.nextSibling);
        }
    }
}

// -----------------------------
// GROUP BUTTONS
// -----------------------------
function addGroupButtonsToHeader(header) {
    header.querySelectorAll("button").forEach(b => b.remove());

    const openBtn = document.createElement("button");
    openBtn.textContent = "Open Group";
    openBtn.style.marginLeft = "10px";

    const getGroupUrls = () => {
        let urls = [];
        let el = header.nextElementSibling;
        while (el && el.tagName !== "H3") {
            const liItems = el.tagName === "UL" ? el.querySelectorAll("li") : [];
            liItems.forEach(li => {
                if (li.style.opacity !== "0.3") {
                    const a = li.querySelector("a[href]");
                    if (a) urls.push(a.href);
                }
            });
            el = el.nextElementSibling;
        }
        return urls;
    };

    openBtn.onclick = () => openLinks(getGroupUrls());

    const selectBtn = document.createElement("button");
    selectBtn.textContent = "Select Group";
    selectBtn.style.marginLeft = "10px";

    selectBtn.onclick = async () => {
        let el = header.nextElementSibling;
        while (el && el.tagName !== "H3") {
            const liList = el.tagName === "UL" ? el.querySelectorAll("li") : [];
            liList.forEach(li => {
                if (li.style.opacity !== "0.3") {
                    const cb = li.querySelector(".link-checkbox");
                    if (cb) cb.checked = true;
                }
            });
            el = el.nextElementSibling;
        }
        updateUI();
        await saveSelections();
    };

    const deselectBtn = document.createElement("button");
    deselectBtn.textContent = "Deselect Group";
    deselectBtn.style.marginLeft = "10px";

    deselectBtn.onclick = async () => {
        let el = header.nextElementSibling;
        while (el && el.tagName !== "H3") {
            const liList = el.tagName === "UL" ? el.querySelectorAll("li") : [];
            liList.forEach(li => {
                const cb = li.querySelector(".link-checkbox");
                if (cb) cb.checked = false;
            });
            el = el.nextElementSibling;
        }
        updateUI();
        await saveSelections();
    };

    const openStaggeredBtn = document.createElement("button");
    openStaggeredBtn.textContent = "Open Group Staggered";
    openStaggeredBtn.style.marginLeft = "10px";
    openStaggeredBtn.onclick = () => startStaggered(getGroupUrls());

    header.appendChild(openBtn);
    header.appendChild(selectBtn);
    header.appendChild(deselectBtn);
    header.appendChild(openStaggeredBtn);
}

function addGroupButtons() {
    const headers = document.querySelectorAll("h3");
    headers.forEach(header => addGroupButtonsToHeader(header));
}

// -----------------------------
// SOUNDS
// -----------------------------
function playNotificationSound(type) {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    if (type === 'new_videos') {
        // High pitch beep for new videos
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(880, audioCtx.currentTime); // A5
        gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime);
        oscillator.start();
        oscillator.stop(audioCtx.currentTime + 0.2);
    } else if (type === 'finished') {
        // Double beep for finished list
        oscillator.type = 'square';
        oscillator.frequency.setValueAtTime(440, audioCtx.currentTime); // A4
        gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime);
        oscillator.start();
        
        // Second beep
        oscillator.frequency.setValueAtTime(660, audioCtx.currentTime + 0.3); // E5
        oscillator.stop(audioCtx.currentTime + 0.5);
    }
}

if (isContextValid()) {
    chrome.runtime.onMessage.addListener((message) => {
        if (message.type === "PLAY_SOUND") {
            playNotificationSound(message.sound);
        } else if (message.type === "STAGGERED_FINISHED") {
            playNotificationSound('finished');
            alert("Staggered load finished.");
        }
    });
}

// -----------------------------
// INIT
// -----------------------------
async function initialize() {
    if (window.top !== window.self) return;

    console.log("Link Batch Opener: Initializing UI...");
    
    if (!document.body) {
        console.warn("Link Batch Opener: Document body not available, waiting...");
        window.addEventListener("DOMContentLoaded", initialize);
        return;
    }

    try {
        createBottomBar();
        console.log("Link Batch Opener: Bottom bar created.");
    } catch (e) {
        console.error("Link Batch Opener: Failed to create bottom bar.", e);
    }

    try {
        await addCheckboxes();
        console.log("Link Batch Opener: Checkboxes added.");
    } catch (e) {
        console.error("Link Batch Opener: Failed to add checkboxes.", e);
    }

    try {
        addGroupButtons();
        console.log("Link Batch Opener: Group buttons added.");
    } catch (e) {
        console.error("Link Batch Opener: Failed to add group buttons.", e);
    }

    try {
        await loadSelections();
        console.log("Link Batch Opener: Selections loaded.");
    } catch (e) {
        console.error("Link Batch Opener: Failed to load selections.", e);
    }

    try {
        await loadSortMode();
        console.log("Link Batch Opener: Sort mode loaded.");
    } catch (e) {
        console.error("Link Batch Opener: Failed to load sort mode.", e);
    }

    try {
        await applyCategoryFilters();
        console.log("Link Batch Opener: Category filters applied.");
    } catch (e) {
        console.error("Link Batch Opener: Failed to apply category filters.", e);
    }

    console.log("Link Batch Opener: Initialization complete.");
}

(async () => {
    try {
        await initialize();
    } catch (e) {
        console.error("Link Batch Opener: Top-level initialization error.", e);
    }
})();
