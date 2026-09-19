// ==UserScript==
// @name         TikTok Thumbnail Custom Context Menu with Copy URL & Middle-click Open
// @namespace    https://tiktok.com/
// @version      1.4
// @description  Adds right-click menu and middle-click open on TikTok thumbnails. Also enables native browser context menu on videos.
// @author       OpenAI
// @match        https://www.tiktok.com/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    let menu = null;
    let feedbackTimeout = null;

    function createMenu() {
        menu = document.createElement('div');
        menu.style.position = 'fixed';
        menu.style.background = '#222';
        menu.style.color = '#eee';
        menu.style.border = '1px solid #444';
        menu.style.padding = '8px 0';
        menu.style.borderRadius = '6px';
        menu.style.zIndex = 1000000;
        menu.style.minWidth = '220px';
        menu.style.fontFamily = 'Arial,sans-serif';
        menu.style.userSelect = 'none';
        menu.style.display = 'none';
        menu.style.boxShadow = '0 2px 8px rgba(0,0,0,0.5)';
        document.body.appendChild(menu);

        document.addEventListener('click', () => {
            if (menu) menu.style.display = 'none';
            clearTimeout(feedbackTimeout);
        });
    }

    function showMenu(x, y, href) {
        menu.innerHTML = '';

        const openTab = document.createElement('div');
        openTab.textContent = 'Open in new tab (Ctrl/Cmd+Click for background)';
        openTab.style.padding = '8px 16px';
        openTab.style.cursor = 'pointer';
        openTab.addEventListener('click', e => {
            e.stopPropagation();
            window.open(href, '_blank');
            menu.style.display = 'none';
        });
        openTab.addEventListener('mouseenter', () => (openTab.style.background = '#444'));
        openTab.addEventListener('mouseleave', () => (openTab.style.background = 'transparent'));

        const copyUrl = document.createElement('div');
        copyUrl.textContent = 'Copy video URL';
        copyUrl.style.padding = '8px 16px';
        copyUrl.style.cursor = 'pointer';
        copyUrl.addEventListener('click', e => {
            e.stopPropagation();
            copyToClipboard(href);
            showCopyFeedback(copyUrl);
            setTimeout(() => {
                if (menu) menu.style.display = 'none';
            }, 1500);
        });
        copyUrl.addEventListener('mouseenter', () => (copyUrl.style.background = '#444'));
        copyUrl.addEventListener('mouseleave', () => (copyUrl.style.background = 'transparent'));

        menu.appendChild(openTab);
        menu.appendChild(copyUrl);

        const width = 220;
        const height = 64;
        let left = x;
        let top = y;

        if (left + width > window.innerWidth) {
            left = window.innerWidth - width - 10;
        }
        if (top + height > window.innerHeight) {
            top = window.innerHeight - height - 10;
        }

        menu.style.left = left + 'px';
        menu.style.top = top + 'px';
        menu.style.display = 'block';
    }

    function copyToClipboard(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
        } else {
            fallbackCopy(text);
        }
    }

    function fallbackCopy(text) {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        try {
            document.execCommand('copy');
        } catch (err) {
            alert('Failed to copy text: ' + err);
        }
        document.body.removeChild(textarea);
    }

    function showCopyFeedback(element) {
        const originalText = element.textContent;
        element.textContent = 'Copied!';
        clearTimeout(feedbackTimeout);
        feedbackTimeout = setTimeout(() => {
            element.textContent = originalText;
        }, 1200);
    }

    function onContextMenu(e) {
        const target = e.target.closest('div.css-fj00f7-DivCoverContainer');
        if (!target) return;

        const link = target.querySelector('a.css-1rjlivr-LinkNonClickable');
        if (!link) return;

        e.preventDefault();
        e.stopPropagation();

        showMenu(e.clientX, e.clientY, link.href);
    }

    function onMouseDown(e) {
        if (e.button !== 1) return; // Only middle mouse button
        const target = e.target.closest('div.css-fj00f7-DivCoverContainer');
        if (!target) return;

        const link = target.querySelector('a.css-1rjlivr-LinkNonClickable');
        if (!link) return;

        e.preventDefault(); // Prevent scroll
        window.open(link.href, '_blank');
    }

    function enableNativeVideoContextMenu() {
        document.addEventListener('contextmenu', e => {
            const video = e.target.closest('video');
            if (video) {
                e.stopImmediatePropagation(); // Stop TikTok's suppression
                return; // Allow default context menu
            }
        }, true); // Use capture phase
    }

    function addListeners() {
        window.addEventListener('contextmenu', onContextMenu, { capture: true });
        window.addEventListener('mousedown', onMouseDown, { capture: true });
    }

    createMenu();
    addListeners();
    enableNativeVideoContextMenu();
})();
