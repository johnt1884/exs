// ==UserScript==
// @name         Twitter/X Embedder (all instances) + Cleanup
// @namespace    Violentmonkey Scripts
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @connect      publish.x.com
// @version      2.6
// @description  Embed tweets everywhere, remove leftover query junk and empty lines, supports duplicates, cleans gaps
// ==/UserScript==

(function () {
    'use strict';

    // Inject CSS to add padding and collapse gaps
    const style = document.createElement('style');
    style.textContent = `
      .twitter-tweet,
      .twitter-tweet-rendered {
        margin-top: 10px !important;
        margin-bottom: 10px !important;
      }
      .twitter-tweet + br,
      .twitter-tweet + div:empty {
        display: none !important;
      }
    `;
    document.head.appendChild(style);

    // Regex to capture tweet URLs
    const tweetRegex = /(https?:\/\/(?:twitter|x)\.com\/[a-zA-Z0-9_]+\/status\/[0-9]+)([^\s]*)?/g;
    const tweetCache = new Map();

    // --- NEW: Collapse gaps around embeds ---
    function collapseGaps(container) {
        if (!container) return;

        const targets = [container, container.parentNode];
        for (const node of targets) {
            if (!node || !node.parentNode) continue;

            // Remove leading empties
            let prev = node.previousSibling;
            while (prev) {
                const toRemove = prev;
                prev = prev.previousSibling;
                if (
                    (toRemove.nodeType === Node.TEXT_NODE && toRemove.textContent.trim() === "") ||
                    (toRemove.nodeType === Node.ELEMENT_NODE && toRemove.textContent.trim() === "")
                ) {
                    toRemove.remove();
                } else break;
            }

            // Remove trailing empties
            let next = node.nextSibling;
            while (next) {
                const toRemove = next;
                next = next.nextSibling;
                if (
                    (toRemove.nodeType === Node.TEXT_NODE && toRemove.textContent.trim() === "") ||
                    (toRemove.nodeType === Node.ELEMENT_NODE && toRemove.textContent.trim() === "")
                ) {
                    toRemove.remove();
                } else break;
            }
        }

        // Force block display
        container.style.display = "block";
    }

    function getTweetEmbed(url, callback) {
        const normalizedUrl = url.replace("x.com", "twitter.com");

        if (tweetCache.has(normalizedUrl)) {
            callback(tweetCache.get(normalizedUrl));
            return;
        }

        const embedUrl = `https://publish.x.com/oembed?url=${encodeURIComponent(normalizedUrl)}`;

        GM_xmlhttpRequest({
            method: "GET",
            url: embedUrl,
            onload: function (response) {
                try {
                    const text = response.responseText.trim();
                    if (!text.startsWith("{")) {
                        console.error("Tweet embed error (HTML not JSON):", normalizedUrl);
                        tweetCache.set(normalizedUrl, null);
                        callback(null);
                        return;
                    }

                    const data = JSON.parse(text);
                    const html = data.html;

                    if (typeof html === "string" && html.includes("blockquote")) {
                        tweetCache.set(normalizedUrl, html);
                        callback(html);
                    } else {
                        tweetCache.set(normalizedUrl, null);
                        callback(null);
                    }
                } catch (e) {
                    console.error("Tweet parse error:", normalizedUrl, e);
                    tweetCache.set(normalizedUrl, null);
                    callback(null);
                }
            },
            onerror: function () {
                tweetCache.set(normalizedUrl, null);
                callback(null);
            }
        });
    }

    function processNode(node) {
        if (
            node.nodeType === Node.TEXT_NODE &&
            node.parentNode &&
            !['SCRIPT', 'STYLE', 'A', 'BLOCKQUOTE', 'IFRAME'].includes(node.parentNode.tagName)
        ) {
            const text = node.textContent;
            let match;
            let lastIndex = 0;
            const fragment = document.createDocumentFragment();
            let hasMatches = false;

            while ((match = tweetRegex.exec(text)) !== null) {
                hasMatches = true;
                const before = text.slice(lastIndex, match.index).replace(/\n+$/, '');
                if (before) fragment.appendChild(document.createTextNode(before));

                const tweetUrl = match[1];
                const extra = match[2] || "";

                if (extra.length > 5) {
                    console.debug("Removing leftover query text:", extra);
                }

                const placeholder = document.createElement('div');
                placeholder.textContent = 'Loading tweet...';
                placeholder.style.fontStyle = 'italic';
                fragment.appendChild(placeholder);

                getTweetEmbed(tweetUrl, (html) => {
                    if (!placeholder.parentNode) return;

                    if (html) {
                        const tempDiv = document.createElement('div');
                        tempDiv.innerHTML = html;

                        const blockquote = tempDiv.querySelector('blockquote');
                        const script = tempDiv.querySelector('script');

                        if (script) {
                            const newScript = document.createElement('script');
                            newScript.src = script.src;
                            newScript.async = true;
                            newScript.charset = 'utf-8';
                            document.head.appendChild(newScript);
                        }

                        if (blockquote) {
                            placeholder.replaceWith(blockquote);
                            collapseGaps(blockquote);
                        } else {
                            const fallbackContainer = document.createElement('div');
                            fallbackContainer.innerHTML = html;
                            const scriptInContainer = fallbackContainer.querySelector('script');
                            if (scriptInContainer) {
                                scriptInContainer.remove();
                            }
                            placeholder.replaceWith(fallbackContainer);
                            collapseGaps(fallbackContainer);
                        }
                    } else {
                        const errorSpan = document.createElement('span');
                        errorSpan.textContent = `Tweet unavailable or blocked in your region: ${tweetUrl.trim()}`;
                        errorSpan.style.color = 'red';
                        errorSpan.style.fontWeight = 'bold';
                        placeholder.replaceWith(errorSpan);
                    }
                });

                lastIndex = tweetRegex.lastIndex;
            }

            if (lastIndex < text.length) {
                fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
            }

            if (hasMatches) {
                node.parentNode.replaceChild(fragment, node);

                const parent = fragment.parentNode;
                if (parent && parent.textContent.trim() === "" && parent.childNodes.length === 0) {
                    parent.remove();
                }
            }
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.classList.contains('twitter-tweet')) return;
            Array.from(node.childNodes).forEach(processNode);
        }
    }

    const observer = new MutationObserver((mutations) => {
        observer.disconnect();
        try {
            mutations.forEach((mutation) => {
                mutation.addedNodes.forEach((node) => {
                    processNode(node);
                });
            });
        } finally {
            observer.observe(document.body, { childList: true, subtree: true });
        }
    });

    observer.disconnect();
    try {
        processNode(document.body);
    } finally {
        observer.observe(document.body, { childList: true, subtree: true });
    }
})();
