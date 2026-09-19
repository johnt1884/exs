// ==UserScript==
// @name         TikTok Auto Refresh on Error
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Refresh TikTok page if "Something went wrong" is detected
// @author       You
// @match        *://www.tiktok.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // Function to check for error message
    function checkForError() {
        if (document.body.innerText.includes("Something went wrong")) {
            console.log("Detected error message. Refreshing page...");
            location.reload();
        }
    }

    // Check every 5 seconds (adjust as needed)
    setInterval(checkForError, 5000);
})();
