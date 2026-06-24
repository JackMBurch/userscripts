// ==UserScript==
// @name        WhatsApp Collapsible Sidebars
// @namespace   JackMBurch
// @version     1.1
// @grant       none
// @license     GNU GPLv3
// @author      JackMBurch
// @contributor imxitiz (original author)
// @match       https://web.whatsapp.com/
// @description Collapse/expand the WhatsApp Web icon rail AND the chat list with clickable carets (chat-list caret on by default; falls back to hover show/hide when disabled), plus a draggable handle to resize the chat list width.
// @downloadURL https://update.greasyfork.org/scripts/584118/WhatsApp%20Collapsible%20Sidebars.user.js
// @updateURL https://update.greasyfork.org/scripts/584118/WhatsApp%20Collapsible%20Sidebars.meta.js
// ==/UserScript==

(() => {
    "use strict";

    // ============================================================
    // DEBUG SYSTEM — Toggle with localStorage.setItem('WHC_DEBUG','true')
    // ============================================================
    const DEBUG = localStorage.getItem("WHC_DEBUG") === "true";
    const log = (...args) => DEBUG && console.log("[WHC]", ...args);
    const warn = (...args) => DEBUG && console.warn("[WHC]", ...args);
    const error = (...args) => console.error("[WHC]", ...args);

    log("Script loaded. DEBUG mode:", DEBUG);
    log("Tip: Set localStorage.setItem('WHC_DEBUG','true') and reload for detailed logs.");

    // ============================================================
    // WHY THIS SCRIPT IS SO CAREFUL ABOUT DOM MUTATIONS
    // ============================================================
    // WhatsApp Web runs its OWN MutationObserver ("trackElements") and performs
    // IndexedDB work during its initial load/sync. If a userscript mutates the
    // DOM heavily *during* that window, WhatsApp's observer fires IndexedDB
    // operations against a transaction that has already closed, throwing
    // "TransactionInactiveError" and freezing the whole app on the loading
    // screen.
    //
    // To avoid this we:
    //   1. Do NOTHING until WhatsApp is fully loaded AND the DOM has gone quiet
    //      (see whenReady()).
    //   2. Drive show/hide/resize by rewriting a <style> element in <head>
    //      (which WhatsApp's app-subtree observer never sees) instead of
    //      mutating #side and its thousands of descendants.
    //   3. Add only two DOM nodes total (a caret + a resize handle), once,
    //      after WhatsApp has settled.
    // ============================================================

    // ============================================================
    // SELECTOR STRATEGY
    // ============================================================
    // SIDEBAR: the chat list pane (#side) — the element we grow/shrink.
    // HEADER / ICON RAIL: the leftmost vertical navigation rail holding the
    //   Chats / Status / Channels / Communities / Meta AI / settings / profile
    //   buttons. In the current DOM this is the <header data-testid=
    //   "chatlist-header"> (the direct <header> child of div.two).
    const Selectors = {
        sidebar: [
            "div.two > div:has(> #side)",
            "#side",
        ],
        header: [
            'header[data-testid="chatlist-header"]',
            "div.two > header",
            "header",
        ],
    };

    const foundElements = {};
    // Cache resolved elements so we don't re-run expensive selectors (notably
    // the :has() one) on every mousemove. Auto-invalidated when detached.
    const elementCache = {};

    function queryFirst(selectorList, label) {
        const cached = elementCache[label];
        if (cached && cached.isConnected) {
            return cached;
        }
        for (let i = 0; i < selectorList.length; i++) {
            const sel = selectorList[i];
            try {
                const el = document.querySelector(sel);
                if (el) {
                    if (!foundElements[label]) {
                        foundElements[label] = true;
                        log(`Found "${label}" with: "${sel}"`);
                    }
                    elementCache[label] = el;
                    return el;
                }
            } catch (e) {
                warn(`Invalid selector "${sel}" for "${label}":`, e.message);
            }
        }
        warn(`No selector matched for "${label}" — tried:`, selectorList);
        return null;
    }

    // ============================================================
    // SETTINGS
    // ============================================================
    // USE_CHATLIST_CARET: when true (default), the chat list is controlled by a
    // dedicated clickable caret (a second handle, next to the icon-rail caret)
    // instead of by mouse hover/placement. Set to false to restore the old
    // behavior where the chat list reveals on hover near the left edge.
    const USE_CHATLIST_CARET = true;

    // ============================================================
    // TUNING — Hover behavior (used only when USE_CHATLIST_CARET is false)
    // ============================================================
    // OPEN_BUFFER: width (px) of the grace zone along the LEFT edge of the
    //   screen that OPENS the chat list when the pointer enters it. This lets
    //   you reveal the chat list without slamming the cursor into the very
    //   edge of the screen (especially when the icon rail is collapsed).
    //   Larger = bigger, easier-to-hit open zone.
    const OPEN_BUFFER = 120;
    // CLOSE_BUFFER: once the chat list is open, how many px to the RIGHT of its
    //   edge the pointer may stray before it starts to hide. Smaller = the chat
    //   list collapses sooner after you move away from it.
    const CLOSE_BUFFER = 30;
    // HIDE_DELAY: grace period (ms) after the pointer leaves before the chat
    //   list actually hides, so brief overshoots don't collapse it.
    const HIDE_DELAY = 450;
    // Color of the resize handle before the first resize. Kept subtle so it
    // blends into WhatsApp instead of being a glaring red bar.
    const HANDLE_COLOR = "rgba(134, 150, 160, 0.35)";

    // Readiness gate: require the chat list pane to exist, then wait for the
    // DOM to go quiet (SETTLE_MS) before doing anything — capped by MAX_WAIT_MS.
    const SETTLE_MS = 700;
    const MAX_WAIT_MS = 5000;

    // ============================================================
    // STATE
    // ============================================================
    let hasInitialized = false;
    let eventParent;
    let isResizing = false;
    let userDefinedFlexBasis =
        parseFloat(getLocalStorageItem("userDefinedFlexBasis")) || 30;
    let userResizedOnce =
        getSessionStorageItem("userResizedOnce") === "true" || false;
    let chatListVisible = false;
    let hideTimer = null;
    let lastVisibility = null;
    let railCollapsed = getLocalStorageItem("railCollapsed") === "true";
    // Persisted collapsed state of the chat list (only used in caret mode).
    // Default false → chat list shown on load.
    let chatListCollapsed = getLocalStorageItem("chatListCollapsed") === "true";
    // Handle for the requestAnimationFrame loop that keeps the caret(s) glued
    // to the moving panel edges during collapse/expand animations.
    let caretRaf = null;
    // The <style> element whose contents we rewrite to show/hide/resize the
    // chat list without mutating WhatsApp's own DOM nodes.
    let dynamicStyleEl = null;

    // ============================================================
    // STORAGE HELPERS
    // ============================================================
    function setSessionStorageItem(key, value) {
        sessionStorage.setItem(key, value);
    }
    function getSessionStorageItem(key) {
        return sessionStorage.getItem(key);
    }
    function setLocalStorageItem(key, value) {
        localStorage.setItem(key, value);
    }
    function getLocalStorageItem(key) {
        return localStorage.getItem(key);
    }

    // ============================================================
    // CHAT LIST VISIBILITY (CSS-driven — no #side DOM mutation)
    // ============================================================
    /**
     * Pixel width for the chat list based on userDefinedFlexBasis (percentage).
     * flex-basis percentages are unreliable in some flex contexts, so we
     * compute pixels from the parent's width.
     */
    function getSidebarPixelWidth(sidebar) {
        const parentWidth = sidebar.parentElement
            ? sidebar.parentElement.clientWidth
            : window.innerWidth;
        return Math.round(parentWidth * (userDefinedFlexBasis / 100));
    }

    /**
     * Rewrite the dynamic <style> element to reflect the current visibility,
     * width and resize state. This mutates a <style> node in <head> only —
     * WhatsApp's app-subtree observer never sees it, so it can't trigger the
     * IndexedDB crash.
     */
    function renderChatListStyle() {
        if (!dynamicStyleEl) return;
        const sidebar = queryFirst(Selectors.sidebar, "sidebar");
        const px = sidebar ? getSidebarPixelWidth(sidebar) : 0;
        const transition = isResizing
            ? "none"
            : "flex-basis .35s ease, max-width .35s ease, min-width .35s ease, width .35s ease";

        let css =
            `.whc-chatlist{position:relative!important;overflow:hidden!important;` +
            `transition:${transition};}`;

        if (chatListVisible) {
            css +=
                `.whc-chatlist{flex:0 0 ${px}px!important;` +
                `max-width:${px}px!important;min-width:${px}px!important;}`;
        } else {
            // A 0-width box still renders its borders as a 1px line, so we must
            // explicitly zero them out — otherwise a stray "edge" line lingers
            // where the chat list used to be.
            css +=
                `.whc-chatlist{flex:0 0 0!important;width:0!important;` +
                `max-width:0!important;min-width:0!important;padding:0!important;` +
                `border:0!important;}`;
            // Clip any descendant WhatsApp sets to overflow:visible so nothing
            // bleeds out of the 0-width pane. Done purely in CSS — no per-node
            // mutation.
            css += `.whc-chatlist *{overflow:hidden!important;}`;
        }

        // DRAWER DIVIDERS: WhatsApp places two empty drawer holders
        // (data-testid="drawer-left" and "drawer-middle") between the icon rail
        // and the chat list. Each one carries a 1px border-inline-start. Those
        // borders normally hug the rail's right edge, but when the rail is
        // collapsed (or the chat list is hidden) they float free and show up as
        // two stray grey vertical lines. Zero them out in those states.
        if (railCollapsed || !chatListVisible) {
            css +=
                `[data-testid="drawer-left"],[data-testid="drawer-middle"]` +
                `{border-inline-start-width:0!important;}`;
        }

        dynamicStyleEl.textContent = css;
    }

    function setChatListVisible(show) {
        chatListVisible = show;
        if (lastVisibility !== show) {
            lastVisibility = show;
            log("Visibility:", show ? "SHOW" : "HIDE");
        }
        renderChatListStyle();
    }

    /**
     * Show/hide with a grace period. Showing is immediate; hiding is deferred
     * by HIDE_DELAY so brief pointer overshoots don't snap it shut. Any "show"
     * cancels a pending hide. On steady state this performs NO mutation.
     */
    function requestVisibility(show) {
        if (show) {
            if (hideTimer) {
                clearTimeout(hideTimer);
                hideTimer = null;
            }
            if (!chatListVisible) {
                setChatListVisible(true);
            }
        } else if (chatListVisible && !hideTimer) {
            hideTimer = setTimeout(() => {
                hideTimer = null;
                setChatListVisible(false);
            }, HIDE_DELAY);
        }
    }

    // ============================================================
    // RESIZE HANDLE
    // ============================================================
    function createResizeHandle() {
        try {
            const sidebar = queryFirst(Selectors.sidebar, "sidebar");
            if (!sidebar) throw new Error("Sidebar element not found");
            if (document.getElementById("resize-handle")) return;

            const resizeHandle = document.createElement("div");
            resizeHandle.id = "resize-handle";
            resizeHandle.style.width = "10px";
            resizeHandle.style.height = "100%";
            resizeHandle.style.position = "absolute";
            resizeHandle.style.top = "0";
            resizeHandle.style.right = "0";
            resizeHandle.style.cursor = "ew-resize";
            resizeHandle.style.backgroundColor = userResizedOnce
                ? "transparent"
                : HANDLE_COLOR;
            resizeHandle.style.zIndex = "1000";
            sidebar.appendChild(resizeHandle);

            resizeHandle.addEventListener("mousedown", (e) => {
                e.preventDefault();
                isResizing = true;
                renderChatListStyle(); // disable transition during the drag
                document.addEventListener("mousemove", resizeChatList);
                document.addEventListener("mouseup", stopResize);
            });
            log("Resize handle created");
        } catch (err) {
            error("Error creating resize handle:", err);
        }
    }

    function resizeChatList(e) {
        if (!isResizing) return;
        const sidebar = queryFirst(Selectors.sidebar, "sidebar");
        if (!sidebar) return;
        const containerWidth = sidebar.parentElement.clientWidth;
        const newFlexBasis =
            ((e.clientX - sidebar.getBoundingClientRect().left) /
                containerWidth) *
            100;

        if (newFlexBasis >= 5 && newFlexBasis <= 80) {
            userDefinedFlexBasis = newFlexBasis;
            renderChatListStyle();
        }

        if (!userResizedOnce) {
            userResizedOnce = true;
            setSessionStorageItem("userResizedOnce", "true");
            const handle = document.getElementById("resize-handle");
            if (handle) handle.style.backgroundColor = "transparent";
        }
        setLocalStorageItem("userDefinedFlexBasis", userDefinedFlexBasis);
    }

    function stopResize() {
        isResizing = false;
        renderChatListStyle(); // restore transition
        document.removeEventListener("mousemove", resizeChatList);
        document.removeEventListener("mouseup", stopResize);
    }

    // ============================================================
    // UTILITY
    // ============================================================
    function isMouseOver(element) {
        return element && eventParent && element.contains(eventParent.target);
    }

    // ============================================================
    // LEFT ICON RAIL — collapse/expand with a caret toggle
    // ============================================================
    function applyRailState() {
        const rail = queryFirst(Selectors.header, "header");
        if (!rail) return;
        rail.style.transition =
            "width .25s ease, min-width .25s ease, opacity .25s ease";
        if (railCollapsed) {
            rail.style.width = "0px";
            rail.style.minWidth = "0px";
            rail.style.maxWidth = "0px";
            rail.style.overflow = "hidden";
            rail.style.opacity = "0";
            rail.style.pointerEvents = "none";
            // A 0-width box still paints its borders as a 1px line; zero them
            // so no "edge" line lingers where the rail used to be.
            rail.style.borderWidth = "0px";
            // The rail has horizontal padding (~12px each side). With the
            // default content-box sizing, max-width:0 only zeroes the CONTENT
            // box — the ~24px of padding remains and keeps pushing the chat
            // list ~24px to the right. Zero the padding so the rail truly
            // collapses to 0 and the chat list sits flush at the left edge.
            rail.style.padding = "0px";
            // WhatsApp reserves the rail's space via the --navbar-width CSS
            // variable (default 64px on :root): drawer-left's margin, the
            // conversation pane width calc, etc. all derive from it. Collapsing
            // the rail ELEMENT to 0 doesn't change that variable, so the chat
            // list and everything to its right stay offset ~64px. Override the
            // variable to 0 so the reserved space collapses with the rail. Set
            // on <html> (outside <body>) to stay clear of WhatsApp's observer.
            document.documentElement.style.setProperty("--navbar-width", "0px");
        } else {
            rail.style.width = "";
            rail.style.minWidth = "";
            rail.style.maxWidth = "";
            rail.style.overflow = "";
            rail.style.opacity = "";
            rail.style.pointerEvents = "";
            rail.style.borderWidth = "";
            rail.style.padding = "";
            document.documentElement.style.removeProperty("--navbar-width");
        }
        // The collapsed/expanded rail state changes whether the drawer divider
        // lines should be hidden, so refresh the dynamic stylesheet too.
        renderChatListStyle();
        refreshCaretIcons();
        positionCarets();
    }

    function toggleRail() {
        railCollapsed = !railCollapsed;
        setLocalStorageItem("railCollapsed", railCollapsed);
        log("Icon rail collapsed:", railCollapsed);
        applyRailState();
        // Track the panel edges through the rail's width animation (.25s).
        animateCarets(420);
    }

    function createCaretButton() {
        if (document.getElementById("whc-rail-toggle")) return;
        const btn = document.createElement("button");
        btn.id = "whc-rail-toggle";
        btn.type = "button";
        btn.setAttribute("aria-label", "Collapse or expand the icon rail");
        btn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleRail();
        });
        document.body.appendChild(btn);
        log("Rail toggle caret created");
    }

    // ============================================================
    // CHAT LIST — collapse/expand with a caret toggle (caret mode)
    // ============================================================
    function createChatListCaret() {
        if (document.getElementById("whc-chatlist-toggle")) return;
        const btn = document.createElement("button");
        btn.id = "whc-chatlist-toggle";
        btn.type = "button";
        btn.setAttribute("aria-label", "Collapse or expand the chat list");
        btn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleChatList();
        });
        document.body.appendChild(btn);
        log("Chat list toggle caret created");
    }

    function toggleChatList() {
        chatListCollapsed = !chatListCollapsed;
        setLocalStorageItem("chatListCollapsed", chatListCollapsed);
        log("Chat list collapsed:", chatListCollapsed);
        setChatListVisible(!chatListCollapsed);
        refreshCaretIcons();
        // Track the chat list's right edge through its width animation (.35s).
        animateCarets(420);
    }

    // ============================================================
    // CARET RENDERING
    // ============================================================
    // Set the arrow glyph + tooltip. Each caret points toward the action it
    // performs: collapse (◂, points toward where the panel goes) when open,
    // expand (▸) when collapsed.
    function refreshCaretIcons() {
        const railBtn = document.getElementById("whc-rail-toggle");
        if (railBtn) {
            railBtn.textContent = railCollapsed ? "\u25B8" : "\u25C2";
            railBtn.title = railCollapsed ? "Show icon rail" : "Hide icon rail";
        }
        const chatBtn = document.getElementById("whc-chatlist-toggle");
        if (chatBtn) {
            chatBtn.textContent = chatListVisible ? "\u25C2" : "\u25B8";
            chatBtn.title = chatListVisible
                ? "Hide chat list"
                : "Show chat list";
        }
    }

    // Position both carets by LIVE-measuring the chat list container's edges:
    //   - rail caret  → container's LEFT edge  (= the icon rail's right edge)
    //   - chat caret  → container's RIGHT edge (= the chat list's right edge;
    //                    collapses to the left edge when the chat list is hidden)
    // Measuring live (each animation frame, via animateCarets) keeps the carets
    // perfectly glued to the panels regardless of which animation is running or
    // its easing/duration — no CSS `left` transition is used on the carets.
    function positionCarets() {
        const container = queryFirst(Selectors.sidebar, "sidebar");
        if (!container) return;
        const rect = container.getBoundingClientRect();
        const railBtn = document.getElementById("whc-rail-toggle");
        if (railBtn) {
            railBtn.style.left = `${Math.max(0, Math.round(rect.left))}px`;
        }
        const chatBtn = document.getElementById("whc-chatlist-toggle");
        if (chatBtn) {
            chatBtn.style.left = `${Math.max(0, Math.round(rect.right))}px`;
        }
    }

    // Run a short rAF loop that re-positions the carets every frame for the
    // duration of a collapse/expand animation, so they stay glued to the
    // moving edges (works for both the rail's .25s and the chat list's .35s
    // animations without any easing/duration matching).
    function animateCarets(duration) {
        if (caretRaf) cancelAnimationFrame(caretRaf);
        const start = performance.now();
        const step = (now) => {
            positionCarets();
            if (now - start < duration) {
                caretRaf = requestAnimationFrame(step);
            } else {
                caretRaf = null;
                positionCarets();
            }
        };
        caretRaf = requestAnimationFrame(step);
    }

    // ============================================================
    // MOUSEMOVE — hover show/hide (only active after setup)
    // ============================================================
    function updateSidebarVisibility() {
        const sidebar = queryFirst(Selectors.sidebar, "sidebar");
        const inboxSwitcher = queryFirst(Selectors.header, "header");
        if (!sidebar || !inboxSwitcher) return;

        // Re-assert our class if WhatsApp re-rendered #side (cheap read; only
        // mutates on the rare re-render).
        if (!sidebar.classList.contains("whc-chatlist")) {
            sidebar.classList.add("whc-chatlist");
            renderChatListStyle();
        }
        // Keep the rail in its persisted state across re-renders.
        if (railCollapsed && inboxSwitcher.style.width !== "0px") {
            applyRailState();
        }

        // In caret mode the chat list is driven solely by its caret — skip all
        // hover-based show/hide. We still ran the cheap re-assert above so the
        // chat list / rail survive WhatsApp re-renders.
        if (USE_CHATLIST_CARET) return;

        const x = eventParent.clientX;
        const overSidebar =
            isMouseOver(sidebar) || isMouseOver(inboxSwitcher);

        let show;
        if (overSidebar || isResizing || x <= OPEN_BUFFER) {
            show = true;
        } else if (
            chatListVisible &&
            x <= sidebar.getBoundingClientRect().right + CLOSE_BUFFER
        ) {
            show = true;
        } else {
            show = false;
        }

        requestVisibility(show);
    }

    function onMouseMove(event) {
        eventParent = event;
        try {
            updateSidebarVisibility();
        } catch (err) {
            error("updateSidebarVisibility failed:", err);
        }
    }

    // ============================================================
    // STYLES
    // ============================================================
    function injectStyles() {
        if (!document.getElementById("whc-static-style")) {
            const staticStyle = document.createElement("style");
            staticStyle.id = "whc-static-style";
            staticStyle.textContent = `
                #whc-rail-toggle,
                #whc-chatlist-toggle {
                    position: fixed;
                    transform: translateY(-50%);
                    left: 0;
                    z-index: 100000;
                    width: 24px;
                    height: 56px;
                    padding: 0;
                    border: none;
                    border-radius: 0 12px 12px 0;
                    background: rgba(0, 0, 0, 0.35);
                    color: #fff;
                    font-size: 18px;
                    line-height: 56px;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    opacity: 0.5;
                    /* No 'left' transition: position is driven per-frame by
                       requestAnimationFrame so the carets stay glued to the
                       moving panel edges. */
                    transition: background .2s ease, opacity .2s ease;
                }
                /* Stack the two carets vertically so they never overlap when
                   the chat list is hidden and both sit at the rail's edge. */
                #whc-rail-toggle { top: calc(50% - 32px); }
                #whc-chatlist-toggle { top: calc(50% + 32px); }
                /* The chat-list caret stacks a small chat-bubble glyph above
                   its arrow so it's obvious which caret controls the chat
                   list. The arrow itself is the button's textContent (updated
                   by refreshCaretIcons); the bubble is a generated ::before
                   flex item sitting above it. */
                #whc-chatlist-toggle {
                    flex-direction: column;
                    /* Center the bubble+arrow stack as a group so the midpoint
                       between them lands at the button's center. */
                    justify-content: center;
                    align-items: center;
                    gap: 8px;
                    line-height: 1;
                }
                #whc-chatlist-toggle::before {
                    content: "\\1F4AC";
                    font-size: 11px;
                    line-height: 1;
                }
                #whc-rail-toggle:hover,
                #whc-chatlist-toggle:hover {
                    background: rgba(0, 0, 0, 0.65);
                    opacity: 1;
                }
                /* Subtle resize handle that brightens on hover instead of a
                   permanent red bar. */
                #resize-handle:hover {
                    background-color: rgba(134, 150, 160, 0.6) !important;
                }
            `;
            document.head.appendChild(staticStyle);
        }
        if (!dynamicStyleEl) {
            dynamicStyleEl = document.createElement("style");
            dynamicStyleEl.id = "whc-dynamic-style";
            document.head.appendChild(dynamicStyleEl);
        }
    }

    // ============================================================
    // SETUP — runs ONCE, only after WhatsApp has loaded and settled
    // ============================================================
    function setup() {
        if (hasInitialized) return;
        const sidebar = queryFirst(Selectors.sidebar, "sidebar");
        if (!sidebar) {
            // pane-side existed but #side isn't resolvable yet; try shortly.
            setTimeout(setup, 500);
            return;
        }
        hasInitialized = true;
        log("Setting up — WhatsApp is loaded & settled.");

        injectStyles();
        // Tag the chat list element; all sizing is driven via this class in the
        // dynamic stylesheet (single attribute mutation, done once).
        sidebar.classList.add("whc-chatlist");

        // In caret mode, restore the persisted chat list state (default shown).
        // In hover mode, start hidden and let the pointer reveal it.
        chatListVisible = USE_CHATLIST_CARET ? !chatListCollapsed : false;
        renderChatListStyle();

        createResizeHandle();
        createCaretButton();
        if (USE_CHATLIST_CARET) {
            createChatListCaret();
        }
        applyRailState();
        refreshCaretIcons();
        positionCarets();
        // applyRailState() may kick off a collapse animation (when the rail
        // starts collapsed on load), so the panel edges keep moving for a beat
        // after this point. A single positionCarets() above would measure the
        // pre-animation (open-rail) edge and leave the carets floating. Track
        // the edges across the animation so they settle flush against it.
        animateCarets(420);

        // The mousemove listener is always attached: in hover mode it drives
        // show/hide; in caret mode it only re-asserts our state across WhatsApp
        // re-renders (it returns early before any hover logic).
        document.addEventListener("mousemove", onMouseMove);
        window.addEventListener("resize", positionCarets);
        log("Setup complete.");
    }

    // ============================================================
    // READINESS GATE — wait for full load + a quiet DOM before doing anything
    // ============================================================
    function whenReady(cb) {
        let settleTimer = null;
        let paneSeenAt = 0;
        let done = false;

        const finish = (reason) => {
            if (done) return;
            done = true;
            if (settleTimer) clearTimeout(settleTimer);
            observer.disconnect();
            log("Ready (", reason, ") — initializing.");
            cb();
        };

        const check = () => {
            // The chat list pane only exists once WhatsApp is past its initial
            // load/sync (and the user is logged in). Until then, do nothing.
            if (!document.getElementById("pane-side")) return;
            if (!paneSeenAt) paneSeenAt = Date.now();
            if (Date.now() - paneSeenAt >= MAX_WAIT_MS) {
                finish("max-wait");
                return;
            }
            if (settleTimer) clearTimeout(settleTimer);
            settleTimer = setTimeout(() => finish("settled"), SETTLE_MS);
        };

        const observer = new MutationObserver(check);
        observer.observe(document.body, { childList: true, subtree: true });
        check();
    }

    // ============================================================
    // BOOT
    // ============================================================
    function init() {
        log("=== INIT START ===");
        whenReady(setup);
        log("Waiting for WhatsApp to finish loading…");
    }

    function safeInit() {
        try {
            init();
        } catch (err) {
            error("init failed:", err);
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", safeInit);
    } else {
        safeInit();
    }
})();
