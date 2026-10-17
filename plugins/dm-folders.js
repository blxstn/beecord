// DM Folders v1.0.0 for Beecord
// Organize Direct Messages (DMs) into collapsible, colored, custom-named folders via Drag & Drop.
// Drag a DM over another DM to create a folder; drag DMs into and out of folders; reorder freely.
// Author: blxstn (2026)

(window.beecord || window.blxstncord).definePlugin({
    id: "dm-folders",
    name: "DM Folders",
    description: "Create and manage folders in your Direct Messages sidebar with drag & drop, custom names, and colors.",
    author: "blxstn",
    version: "1.0.0",
    enabledByDefault: true,
    webpack: false,

    start(api) {
        const STORAGE_KEY = "beecord_dm_folders_v1";
        let isReconciling = false;
        let reconcileTimer = null;
        let mutationObserver = null;
        let running = true;
        let justDragged = false;

        // ---------- Preset Color Palette ----------
        const PRESET_COLORS = [
            { name: "Bee Gold", hex: "#f0b232" },
            { name: "Blurple", hex: "#5865f2" },
            { name: "Emerald", hex: "#23a559" },
            { name: "Coral Red", hex: "#f23f42" },
            { name: "Fuchsia", hex: "#eb459e" },
            { name: "Cyan Sky", hex: "#00a8fc" },
            { name: "Royal Purple", hex: "#9b59b6" },
            { name: "Sunset Orange", hex: "#e67e22" },
            { name: "Obsidian Dark", hex: "#4e5058" },
            { name: "Pure White", hex: "#f2f3f5" }
        ];

        // ---------- State Management ----------
        function loadState() {
            try {
                let parsed = null;
                const settingVal = api.settings.get("data", null);
                if (settingVal && typeof settingVal === "object") {
                    parsed = settingVal;
                } else if (typeof settingVal === "string") {
                    try { parsed = JSON.parse(settingVal); } catch (e) {}
                }
                if (!parsed) {
                    const localVal = localStorage.getItem(STORAGE_KEY);
                    if (localVal) {
                        try { parsed = JSON.parse(localVal); } catch (e) {}
                    }
                }
                if (parsed && typeof parsed === "object" && Array.isArray(parsed.folders)) {
                    return {
                        folders: parsed.folders.map(f => ({
                            id: String(f.id || "dmf_" + Math.random().toString(36).slice(2, 9)),
                            name: String(f.name || "Folder"),
                            color: String(f.color || "#f0b232"),
                            collapsed: !!f.collapsed,
                            channelIds: Array.isArray(f.channelIds) ? f.channelIds.map(String) : []
                        })),
                        rootOrder: Array.isArray(parsed.rootOrder) ? parsed.rootOrder.map(String) : []
                    };
                }
            } catch (err) {
                api.log("loadState handled:", err && err.message ? err.message : String(err));
            }
            return { folders: [], rootOrder: [] };
        }

        let state = loadState();

        function saveState() {
            try {
                // Clean up empty folders automatically
                state.folders = state.folders.filter(f => f.channelIds && f.channelIds.length > 0);
                api.settings.set("data", state);
                localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
            } catch (e) {
                api.log("Failed to save state:", e);
            }
        }

        function findFolderOfChannel(channelId) {
            return state.folders.find(f => f.channelIds.includes(String(channelId))) || null;
        }

        function findFolderById(folderId) {
            return state.folders.find(f => f.id === String(folderId)) || null;
        }

        // ---------- CSS Styles ----------
        api.addStyle(`
            /* Folder Header */
            .bdf-folder-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                height: 36px;
                padding: 0 10px 0 12px;
                margin: 4px 8px 2px 8px;
                border-radius: 6px;
                cursor: pointer;
                user-select: none;
                transition: background 0.15s ease, transform 0.1s ease;
                position: relative;
                box-sizing: border-box;
            }
            .bdf-folder-header:hover {
                background: rgba(255, 255, 255, 0.06);
            }
            .bdf-folder-header.bdf-collapsed {
                margin-bottom: 4px;
            }
            .bdf-left {
                display: flex;
                align-items: center;
                gap: 8px;
                min-width: 0;
                flex: 1;
            }
            .bdf-chevron {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 16px;
                height: 16px;
                color: #949ba4;
                transition: transform 0.22s cubic-bezier(0.4, 0, 0.2, 1), color 0.15s ease;
                flex-shrink: 0;
            }
            .bdf-chevron svg {
                width: 14px;
                height: 14px;
                fill: currentColor;
            }
            .bdf-folder-header.bdf-collapsed .bdf-chevron {
                transform: rotate(-90deg);
            }
            .bdf-folder-header:hover .bdf-chevron {
                color: #dbdee1;
            }
            .bdf-icon-wrap {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 20px;
                height: 20px;
                flex-shrink: 0;
                position: relative;
            }
            .bdf-icon-svg {
                width: 18px;
                height: 18px;
                transition: filter 0.2s ease, transform 0.2s ease;
            }
            .bdf-folder-header:hover .bdf-icon-svg {
                transform: scale(1.1);
                filter: drop-shadow(0 0 6px var(--bdf-folder-color));
            }
            .bdf-name {
                font-size: 13px;
                font-weight: 700;
                letter-spacing: 0.02em;
                color: #dbdee1;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                flex: 1;
                transition: color 0.15s ease;
            }
            .bdf-folder-header:hover .bdf-name {
                color: #ffffff;
            }
            .bdf-badge {
                font-size: 11px;
                font-weight: 700;
                padding: 1px 7px;
                border-radius: 10px;
                background: rgba(255, 255, 255, 0.08);
                color: #949ba4;
                margin-left: 4px;
                flex-shrink: 0;
                transition: all 0.15s ease;
            }
            .bdf-folder-header:hover .bdf-badge {
                background: var(--bdf-folder-glow);
                color: #ffffff;
            }
            .bdf-actions {
                display: none;
                align-items: center;
                gap: 4px;
                margin-left: 6px;
            }
            .bdf-folder-header:hover .bdf-actions {
                display: flex;
            }
            .bdf-btn-action {
                background: transparent;
                border: none;
                padding: 3px 5px;
                border-radius: 4px;
                cursor: pointer;
                color: #949ba4;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                transition: color 0.15s ease, background 0.15s ease;
            }
            .bdf-btn-action:hover {
                color: #ffffff;
                background: rgba(255, 255, 255, 0.14);
            }
            .bdf-btn-action svg {
                width: 14px;
                height: 14px;
                fill: currentColor;
            }

            /* Folder Member DMs */
            li[data-bdf-folder-id] {
                position: relative;
                transition: opacity 0.2s ease, transform 0.2s ease;
            }
            li[data-bdf-folder-id]::before {
                content: "";
                position: absolute;
                left: 17px;
                top: 0;
                bottom: 0;
                width: 2.5px;
                background: var(--bdf-item-border, #f0b232);
                opacity: 0.65;
                border-radius: 2px;
                z-index: 2;
                transition: opacity 0.2s ease, width 0.2s ease, box-shadow 0.2s ease;
            }
            li[data-bdf-folder-id]:hover::before {
                opacity: 1;
                width: 3.5px;
                box-shadow: 0 0 8px var(--bdf-item-border, #f0b232);
            }
            li[data-bdf-folder-id] > div,
            li[data-bdf-folder-id] > a {
                padding-left: 14px !important;
            }

            /* Collapsed DMs */
            li[data-bdf-hidden="true"] {
                display: none !important;
            }

            /* Drag & Drop Visuals */
            .bdf-ghost {
                position: fixed;
                pointer-events: none;
                z-index: 1000000;
                background: rgba(17, 18, 20, 0.94);
                backdrop-filter: blur(12px);
                border: 1.5px solid #f0b232;
                border-radius: 8px;
                padding: 8px 12px;
                box-shadow: 0 10px 30px rgba(0, 0, 0, 0.65), 0 0 14px rgba(240, 178, 50, 0.4);
                color: #ffffff;
                font-family: inherit;
                font-size: 13px;
                font-weight: 600;
                display: flex;
                align-items: center;
                gap: 10px;
                transform: scale(1.04);
                box-sizing: border-box;
                white-space: nowrap;
                max-width: 240px;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .bdf-ghost-icon {
                width: 24px;
                height: 24px;
                border-radius: 50%;
                background: #f0b232;
                color: #111214;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                font-size: 12px;
                font-weight: 800;
                flex-shrink: 0;
            }

            .bdf-drag-source {
                opacity: 0.35 !important;
                filter: grayscale(50%) !important;
            }

            /* Combine Hover State (Create or Add to folder) */
            .bdf-drop-combine {
                position: relative;
                outline: 2px dashed #f0b232 !important;
                outline-offset: -2px;
                border-radius: 8px !important;
                background: rgba(240, 178, 50, 0.16) !important;
                box-shadow: 0 0 18px rgba(240, 178, 50, 0.5) !important;
                transition: all 0.15s ease;
            }
            .bdf-drop-combine::after {
                content: attr(data-bdf-drop-label);
                position: absolute;
                right: 8px;
                top: 50%;
                transform: translateY(-50%);
                background: #f0b232;
                color: #111214;
                font-size: 10px;
                font-weight: 800;
                padding: 2px 7px;
                border-radius: 4px;
                pointer-events: none;
                z-index: 10;
                letter-spacing: 0.03em;
                text-transform: uppercase;
                box-shadow: 0 2px 8px rgba(0,0,0,0.4);
            }

            /* Insertion Indicator Line */
            .bdf-insert-line {
                position: fixed;
                height: 3px;
                background: #f0b232;
                border-radius: 2px;
                box-shadow: 0 0 10px rgba(240, 178, 50, 0.85);
                pointer-events: none;
                z-index: 999999;
                transition: top 0.08s ease;
            }
            .bdf-insert-line::before {
                content: "";
                position: absolute;
                left: -3px;
                top: -3.5px;
                width: 10px;
                height: 10px;
                border-radius: 50%;
                background: #f0b232;
                box-shadow: 0 0 8px #f0b232;
            }

            /* Modal Styles */
            .bdf-modal-backdrop {
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0, 0, 0, 0.72);
                backdrop-filter: blur(6px);
                z-index: 2000000;
                display: flex;
                align-items: center;
                justify-content: center;
                animation: bdfFadeIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
            }
            @keyframes bdfFadeIn {
                from { opacity: 0; transform: scale(0.97); }
                to { opacity: 1; transform: scale(1); }
            }
            .bdf-modal {
                background: #2b2d31;
                border: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 12px;
                width: 420px;
                box-shadow: 0 16px 40px rgba(0, 0, 0, 0.6), 0 0 20px rgba(240, 178, 50, 0.15);
                overflow: hidden;
                color: #dbdee1;
                font-family: inherit;
            }
            .bdf-modal-header {
                padding: 16px 20px;
                background: #232428;
                border-bottom: 1px solid rgba(255, 255, 255, 0.06);
                display: flex;
                align-items: center;
                justify-content: space-between;
            }
            .bdf-modal-title {
                font-size: 16px;
                font-weight: 700;
                color: #ffffff;
                display: flex;
                align-items: center;
                gap: 8px;
            }
            .bdf-modal-body {
                padding: 20px;
                display: flex;
                flex-direction: column;
                gap: 16px;
            }
            .bdf-label {
                font-size: 12px;
                font-weight: 700;
                color: #b5bac1;
                text-transform: uppercase;
                letter-spacing: 0.04em;
                margin-bottom: 6px;
            }
            .bdf-input {
                width: 100%;
                background: #1e1f22;
                border: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 6px;
                padding: 10px 12px;
                font-size: 14px;
                color: #ffffff;
                outline: none;
                box-sizing: border-box;
                transition: border-color 0.15s ease, box-shadow 0.15s ease;
            }
            .bdf-input:focus {
                border-color: #f0b232;
                box-shadow: 0 0 8px rgba(240, 178, 50, 0.3);
            }
            .bdf-color-grid {
                display: grid;
                grid-template-columns: repeat(5, 1fr);
                gap: 10px;
            }
            .bdf-color-swatch {
                width: 100%;
                height: 36px;
                border-radius: 8px;
                border: 2px solid transparent;
                cursor: pointer;
                transition: transform 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
                display: flex;
                align-items: center;
                justify-content: center;
                box-sizing: border-box;
            }
            .bdf-color-swatch:hover {
                transform: scale(1.08);
            }
            .bdf-color-swatch.bdf-selected {
                border-color: #ffffff;
                box-shadow: 0 0 12px rgba(255, 255, 255, 0.5);
                transform: scale(1.06);
            }
            .bdf-custom-color-row {
                display: flex;
                align-items: center;
                gap: 10px;
                margin-top: 4px;
            }
            .bdf-color-picker-input {
                -webkit-appearance: none;
                border: none;
                width: 38px;
                height: 38px;
                border-radius: 8px;
                cursor: pointer;
                background: transparent;
                padding: 0;
            }
            .bdf-color-picker-input::-webkit-color-swatch-wrapper {
                padding: 0;
            }
            .bdf-color-picker-input::-webkit-color-swatch {
                border: 2px solid rgba(255, 255, 255, 0.15);
                border-radius: 8px;
            }
            .bdf-modal-footer {
                padding: 14px 20px;
                background: #232428;
                border-top: 1px solid rgba(255, 255, 255, 0.06);
                display: flex;
                align-items: center;
                justify-content: space-between;
            }
            .bdf-btn {
                padding: 8px 16px;
                border-radius: 6px;
                font-size: 14px;
                font-weight: 600;
                cursor: pointer;
                border: none;
                transition: all 0.15s ease;
            }
            .bdf-btn-primary {
                background: #f0b232;
                color: #111214;
            }
            .bdf-btn-primary:hover {
                background: #e0a322;
                box-shadow: 0 0 10px rgba(240, 178, 50, 0.4);
            }
            .bdf-btn-danger {
                background: transparent;
                color: #f23f42;
                border: 1px solid rgba(242, 63, 66, 0.3);
            }
            .bdf-btn-danger:hover {
                background: rgba(242, 63, 66, 0.12);
                border-color: #f23f42;
            }
            .bdf-btn-cancel {
                background: transparent;
                color: #b5bac1;
            }
            .bdf-btn-cancel:hover {
                color: #ffffff;
            }
        `);

        // ---------- Icons SVG ----------
        const ICONS = {
            folder: (color) => `<svg class="bdf-icon-svg" viewBox="0 0 24 24" fill="${color || "#f0b232"}"><path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z"/></svg>`,
            chevron: `<svg viewBox="0 0 24 24"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>`,
            settings: `<svg viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>`,
            trash: `<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`,
            close: `<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`
        };

        // ---------- Modal Dialog for Folder Customization ----------
        function showFolderModal(folder, isNew = false, onSave = null) {
            const old = document.querySelector(".bdf-modal-backdrop");
            if (old) old.remove();

            let curName = folder.name || (isNew ? "Nowy folder" : "Folder");
            let curColor = folder.color || "#f0b232";

            const backdrop = document.createElement("div");
            backdrop.className = "bdf-modal-backdrop";

            backdrop.innerHTML = `
                <div class="bdf-modal" role="dialog" aria-modal="true">
                    <div class="bdf-modal-header">
                        <div class="bdf-modal-title">
                            ${ICONS.folder(curColor)}
                            <span>${isNew ? "Utwórz folder DM" : "Ustawienia folderu DM"}</span>
                        </div>
                        <button type="button" class="bdf-btn-action bdf-btn-close" title="Zamknij">
                            ${ICONS.close}
                        </button>
                    </div>
                    <div class="bdf-modal-body">
                        <div>
                            <div class="bdf-label">Nazwa folderu</div>
                            <input type="text" class="bdf-input bdf-input-name" placeholder="np. Ulubione, Znajomi, Ważne..." value="${curName.replace(/"/g, '&quot;')}" maxlength="32" autofocus />
                        </div>
                        <div>
                            <div class="bdf-label">Kolor folderu</div>
                            <div class="bdf-color-grid"></div>
                            <div class="bdf-custom-color-row">
                                <input type="color" class="bdf-color-picker-input" value="${curColor}" title="Własny kolor hex" />
                                <span style="font-size: 13px; color: #b5bac1;">Własny odcień (hex): <b class="bdf-hex-display" style="color:${curColor}">${curColor.toUpperCase()}</b></span>
                            </div>
                        </div>
                    </div>
                    <div class="bdf-modal-footer">
                        <div>
                            ${!isNew ? `<button type="button" class="bdf-btn bdf-btn-danger bdf-btn-ungroup" title="Usuwa folder i przywraca DM-y do głównej listy">Rozgrupuj folder</button>` : `<span></span>`}
                        </div>
                        <div style="display:flex; gap:8px;">
                            <button type="button" class="bdf-btn bdf-btn-cancel">Anuluj</button>
                            <button type="button" class="bdf-btn bdf-btn-primary bdf-btn-save">Zapisz</button>
                        </div>
                    </div>
                </div>
            `;

            document.body.appendChild(backdrop);

            const modal = backdrop.querySelector(".bdf-modal");
            const inputName = modal.querySelector(".bdf-input-name");
            const grid = modal.querySelector(".bdf-color-grid");
            const colorPicker = modal.querySelector(".bdf-color-picker-input");
            const hexDisplay = modal.querySelector(".bdf-hex-display");
            const titleIcon = modal.querySelector(".bdf-modal-title .bdf-icon-svg");

            function updateColor(hex) {
                curColor = hex;
                colorPicker.value = hex;
                hexDisplay.textContent = hex.toUpperCase();
                hexDisplay.style.color = hex;
                if (titleIcon) titleIcon.setAttribute("fill", hex);
                grid.querySelectorAll(".bdf-color-swatch").forEach(sw => {
                    sw.classList.toggle("bdf-selected", sw.getAttribute("data-hex").toLowerCase() === hex.toLowerCase());
                });
            }

            PRESET_COLORS.forEach(c => {
                const sw = document.createElement("button");
                sw.type = "button";
                sw.className = "bdf-color-swatch" + (c.hex.toLowerCase() === curColor.toLowerCase() ? " bdf-selected" : "");
                sw.style.background = c.hex;
                sw.setAttribute("data-hex", c.hex);
                sw.title = c.name;
                sw.addEventListener("click", () => updateColor(c.hex));
                grid.appendChild(sw);
            });

            colorPicker.addEventListener("input", (e) => updateColor(e.target.value));

            function close() {
                backdrop.style.opacity = "0";
                setTimeout(() => backdrop.remove(), 150);
            }

            modal.querySelector(".bdf-btn-close").addEventListener("click", close);
            modal.querySelector(".bdf-btn-cancel").addEventListener("click", close);
            backdrop.addEventListener("click", (e) => {
                if (e.target === backdrop) close();
            });

            const ungroupBtn = modal.querySelector(".bdf-btn-ungroup");
            if (ungroupBtn) {
                ungroupBtn.addEventListener("click", () => {
                    const idx = state.folders.findIndex(f => f.id === folder.id);
                    if (idx !== -1) {
                        const [removed] = state.folders.splice(idx, 1);
                        const rootIdx = state.rootOrder.indexOf(folder.id);
                        if (rootIdx !== -1) {
                            state.rootOrder.splice(rootIdx, 1, ...removed.channelIds);
                        } else {
                            state.rootOrder.push(...removed.channelIds);
                        }
                        saveState();
                        reconcileUI();
                    }
                    close();
                });
            }

            function handleSave() {
                const finalName = inputName.value.trim() || "Folder";
                folder.name = finalName;
                folder.color = curColor;
                saveState();
                reconcileUI();
                if (onSave) onSave(folder);
                close();
            }

            modal.querySelector(".bdf-btn-save").addEventListener("click", handleSave);
            inputName.addEventListener("keydown", (e) => {
                if (e.key === "Enter") handleSave();
                if (e.key === "Escape") close();
            });

            setTimeout(() => {
                inputName.focus();
                inputName.select();
            }, 50);
        }

        // ---------- DOM Helper: Find Sidebar & DMs ----------
        function getDMNav() {
            return document.querySelector('nav[class*="privateChannels_"], nav[aria-label*="Private Channels"], nav[aria-label*="Bezpośrednie"]');
        }

        function getDMListUl() {
            const nav = getDMNav();
            if (!nav) return null;
            return nav.querySelector('ul[class*="content_"]') || nav.querySelector('ul');
        }

        function getChannelIdFromHref(href) {
            if (!href) return null;
            const m = href.match(/\/channels\/@me\/(\d+)/);
            return m ? m[1] : null;
        }

        function getDMElementMap(ul) {
            const map = new Map();
            if (!ul) return map;
            const links = ul.querySelectorAll('a[href*="/channels/@me/"]');
            for (const a of links) {
                const id = getChannelIdFromHref(a.getAttribute("href"));
                if (id) {
                    const li = a.closest('li') || a.parentElement;
                    map.set(id, { id, li, a });
                }
            }
            return map;
        }

        function getOrCreateFolderHeader(folder, ul, activeCount) {
            let headerLi = ul.querySelector(`.bdf-folder-header[data-folder-id="${folder.id}"]`);
            if (!headerLi) {
                headerLi = document.createElement("li");
                headerLi.className = "bdf-folder-header";
                headerLi.setAttribute("data-folder-id", folder.id);

                headerLi.addEventListener("click", (e) => {
                    if (justDragged) return;
                    if (e.target.closest(".bdf-actions")) return;
                    folder.collapsed = !folder.collapsed;
                    saveState();
                    reconcileUI();
                });

                headerLi.addEventListener("contextmenu", (e) => {
                    e.preventDefault();
                    showFolderModal(folder, false);
                });

                headerLi.addEventListener("dblclick", (e) => {
                    e.preventDefault();
                    showFolderModal(folder, false);
                });
            }

            headerLi.classList.toggle("bdf-collapsed", folder.collapsed);
            headerLi.style.setProperty("--bdf-folder-color", folder.color);
            headerLi.style.setProperty("--bdf-folder-glow", folder.color + "33");

            headerLi.innerHTML = `
                <div class="bdf-left">
                    <span class="bdf-chevron">${ICONS.chevron}</span>
                    <span class="bdf-icon-wrap">${ICONS.folder(folder.color)}</span>
                    <span class="bdf-name" title="${folder.name.replace(/"/g, '&quot;')}">${folder.name}</span>
                    <span class="bdf-badge">${activeCount}</span>
                </div>
                <div class="bdf-actions">
                    <button type="button" class="bdf-btn-action bdf-action-edit" title="Edytuj folder (nazwa / kolor)">
                        ${ICONS.settings}
                    </button>
                    <button type="button" class="bdf-btn-action bdf-action-ungroup" title="Rozgrupuj folder">
                        ${ICONS.trash}
                    </button>
                </div>
            `;

            const editBtn = headerLi.querySelector(".bdf-action-edit");
            if (editBtn) {
                editBtn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    showFolderModal(folder, false);
                });
            }
            const ungroupBtn = headerLi.querySelector(".bdf-action-ungroup");
            if (ungroupBtn) {
                ungroupBtn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    const idx = state.folders.findIndex(f => f.id === folder.id);
                    if (idx !== -1) {
                        const [removed] = state.folders.splice(idx, 1);
                        const rIdx = state.rootOrder.indexOf(folder.id);
                        if (rIdx !== -1) {
                            state.rootOrder.splice(rIdx, 1, ...removed.channelIds);
                        }
                        headerLi.remove();
                        saveState();
                        reconcileUI();
                    }
                });
            }

            return headerLi;
        }

        // ---------- Reconcile UI: Render Folder Headers & Arrange DMs Sequentially ----------
        function reconcileUI() {
            if (!running || isReconciling) return;
            isReconciling = true;

            try {
                const ul = getDMListUl();
                if (!ul) {
                    isReconciling = false;
                    return;
                }

                const dmMap = getDMElementMap(ul);
                if (dmMap.size === 0) {
                    isReconciling = false;
                    return;
                }

                // Verify and synchronize rootOrder with active DM channels
                const allFolderChannels = new Set();
                state.folders.forEach(f => f.channelIds.forEach(id => allFolderChannels.add(String(id))));

                // Clean rootOrder of stale items that don't exist
                const activeFolderIds = new Set(state.folders.map(f => f.id));
                const currentRootOrder = state.rootOrder.filter(id => {
                    if (activeFolderIds.has(id)) return true;
                    if (dmMap.has(id) && !allFolderChannels.has(id)) return true;
                    return false;
                });

                // Add any missing folders to rootOrder
                state.folders.forEach(f => {
                    if (!currentRootOrder.includes(f.id)) {
                        currentRootOrder.unshift(f.id);
                    }
                });

                // Add any newly seen DMs to rootOrder (not in folders and not yet in rootOrder)
                for (const [id] of dmMap) {
                    if (!allFolderChannels.has(id) && !currentRootOrder.includes(id)) {
                        currentRootOrder.push(id);
                    }
                }
                state.rootOrder = currentRootOrder;

                // Find anchor header ("DIRECT MESSAGES" / "Bezpośrednie wiadomości")
                const headerAnchor = ul.querySelector('[class*="privateChannelsHeaderContainer"]') || ul.querySelector('h2');

                // Build exact sequence of desired elements
                const desiredElements = [];
                for (const itemKey of state.rootOrder) {
                    const folder = findFolderById(itemKey);
                    if (folder) {
                        const activeCount = folder.channelIds.filter(id => dmMap.has(id)).length;
                        const headerLi = getOrCreateFolderHeader(folder, ul, activeCount);
                        desiredElements.push(headerLi);

                        for (const chId of folder.channelIds) {
                            const dmInfo = dmMap.get(chId);
                            if (dmInfo && dmInfo.li) {
                                dmInfo.li.setAttribute("data-bdf-folder-id", folder.id);
                                dmInfo.li.setAttribute("data-bdf-hidden", folder.collapsed ? "true" : "false");
                                dmInfo.li.style.setProperty("--bdf-item-border", folder.color);
                                desiredElements.push(dmInfo.li);
                            }
                        }
                    } else {
                        const dmInfo = dmMap.get(itemKey);
                        if (dmInfo && dmInfo.li) {
                            dmInfo.li.removeAttribute("data-bdf-folder-id");
                            dmInfo.li.removeAttribute("data-bdf-hidden");
                            dmInfo.li.style.removeProperty("--bdf-item-border");
                            desiredElements.push(dmInfo.li);
                        }
                    }
                }

                // Place elements sequentially after headerAnchor
                let prevNode = headerAnchor;
                for (const el of desiredElements) {
                    const targetNext = prevNode ? prevNode.nextSibling : ul.firstChild;
                    if (el !== targetNext) {
                        ul.insertBefore(el, targetNext);
                    }
                    prevNode = el;
                }

                // Remove orphaned folder headers
                const renderedHeaders = ul.querySelectorAll(".bdf-folder-header");
                for (const h of renderedHeaders) {
                    const fId = h.getAttribute("data-folder-id");
                    if (!findFolderById(fId)) {
                        h.remove();
                    }
                }

                attachDragListeners(ul);

            } catch (err) {
                api.log("reconcileUI error:", err);
            } finally {
                isReconciling = false;
            }
        }

        function scheduleReconcile() {
            clearTimeout(reconcileTimer);
            reconcileTimer = setTimeout(() => reconcileUI(), 40);
        }

        // ---------- Drag & Drop Interaction Engine ----------
        let dragState = null;
        let ghostEl = null;
        let insertLineEl = null;
        let currentDropTarget = null;
        let currentDropAction = null; // "CREATE_FOLDER", "ADD_TO_FOLDER", "INSERT_BEFORE", "INSERT_AFTER"

        function removeDropVisuals() {
            if (ghostEl) {
                ghostEl.remove();
                ghostEl = null;
            }
            if (insertLineEl) {
                insertLineEl.remove();
                insertLineEl = null;
            }
            document.querySelectorAll(".bdf-drop-combine").forEach(el => {
                el.classList.remove("bdf-drop-combine");
                el.removeAttribute("data-bdf-drop-label");
            });
            document.querySelectorAll(".bdf-drag-source").forEach(el => {
                el.classList.remove("bdf-drag-source");
            });
            currentDropTarget = null;
            currentDropAction = null;
        }

        function getDMChannelIdFromElement(el) {
            if (!el) return null;
            const li = el.closest('li');
            if (!li) return null;
            const a = li.querySelector('a[href*="/channels/@me/"]');
            return getChannelIdFromHref(a ? a.getAttribute("href") : null);
        }

        function getDMTitle(li) {
            if (!li) return "Direct Message";
            const nameEl = li.querySelector('[class*="name_"], [class*="channelName_"], [class*="username_"]') || li.querySelector('a');
            return (nameEl ? nameEl.innerText || nameEl.textContent : "Direct Message").trim().split("\n")[0] || "Direct Message";
        }

        function attachDragListeners(ul) {
            if (!ul || ul.__bdf_drag_init) return;
            ul.__bdf_drag_init = true;

            // Prevent browser native link/image dragging from intercepting
            ul.addEventListener("dragstart", (e) => {
                e.preventDefault();
            });

            // Prevent accidental click after a drag release
            ul.addEventListener("click", (e) => {
                if (justDragged) {
                    e.preventDefault();
                    e.stopPropagation();
                    justDragged = false;
                }
            }, true);

            ul.addEventListener("mousedown", onMouseDown);
        }

        function onMouseDown(e) {
            if (e.button !== 0) return; // Left mouse button only

            // Ignore clicks on buttons/actions
            if (e.target.closest("button") || e.target.closest(".bdf-btn-action") || e.target.closest('[aria-label*="Close"]') || e.target.closest('[aria-label*="Zamknij"]') || e.target.closest('[class*="closeButton"]')) {
                return;
            }

            const headerEl = e.target.closest(".bdf-folder-header");
            const dmLi = e.target.closest("li");
            const a = dmLi ? dmLi.querySelector('a[href*="/channels/@me/"]') : null;
            const channelId = a ? getChannelIdFromHref(a.getAttribute("href")) : null;

            if (!headerEl && !channelId) return;

            const isFolder = !!headerEl;
            const id = isFolder ? headerEl.getAttribute("data-folder-id") : channelId;
            const sourceEl = isFolder ? headerEl : dmLi;
            const title = isFolder ? (headerEl.querySelector(".bdf-name")?.textContent || "Folder") : getDMTitle(dmLi);

            // Get avatar image if available
            let avatarUrl = null;
            if (!isFolder && dmLi) {
                const img = dmLi.querySelector('img[src*="avatar"]');
                if (img && img.src) avatarUrl = img.src;
            }

            dragState = {
                active: false,
                isFolder,
                id,
                sourceEl,
                title,
                avatarUrl,
                startX: e.clientX,
                startY: e.clientY
            };

            window.addEventListener("mousemove", onMouseMove, { passive: false });
            window.addEventListener("mouseup", onMouseUp, { once: true });
        }

        function onMouseMove(e) {
            if (!dragState) return;

            const dist = Math.hypot(e.clientX - dragState.startX, e.clientY - dragState.startY);

            if (!dragState.active) {
                if (dist > 5) {
                    dragState.active = true;
                    justDragged = true;
                    document.body.style.userSelect = "none";
                    dragState.sourceEl.classList.add("bdf-drag-source");

                    // Create Drag Ghost
                    ghostEl = document.createElement("div");
                    ghostEl.className = "bdf-ghost";

                    let iconHtml = `<span class="bdf-ghost-icon">${dragState.isFolder ? "📁" : "@"}</span>`;
                    if (dragState.avatarUrl) {
                        iconHtml = `<img src="${dragState.avatarUrl}" style="width:24px; height:24px; border-radius:50%; object-fit:cover; flex-shrink:0;" />`;
                    }

                    ghostEl.innerHTML = `
                        ${iconHtml}
                        <span>${dragState.title}</span>
                    `;
                    document.body.appendChild(ghostEl);

                    // Create Insert Line
                    insertLineEl = document.createElement("div");
                    insertLineEl.className = "bdf-insert-line";
                    insertLineEl.style.display = "none";
                    document.body.appendChild(insertLineEl);
                } else {
                    return;
                }
            }

            e.preventDefault();

            // Update Ghost Position
            if (ghostEl) {
                ghostEl.style.left = (e.clientX + 14) + "px";
                ghostEl.style.top = (e.clientY + 14) + "px";
            }

            // Detect target under mouse
            const ul = getDMListUl();
            if (!ul) return;

            // Clear previous hover
            document.querySelectorAll(".bdf-drop-combine").forEach(el => {
                el.classList.remove("bdf-drop-combine");
                el.removeAttribute("data-bdf-drop-label");
            });
            if (insertLineEl) insertLineEl.style.display = "none";

            const hit = document.elementFromPoint(e.clientX, e.clientY);
            if (!hit) {
                currentDropTarget = null;
                currentDropAction = null;
                return;
            }

            // Target Anchor Header ("Direct Messages")
            const targetAnchor = hit.closest('[class*="privateChannelsHeaderContainer"]') || (hit.tagName === "H2" ? hit : null);
            if (targetAnchor && state.rootOrder.length > 0) {
                const firstRoot = state.rootOrder[0];
                currentDropTarget = { type: "root_start", id: firstRoot, el: targetAnchor };
                currentDropAction = "INSERT_BEFORE";
                const rect = targetAnchor.getBoundingClientRect();
                showInsertLine(rect, rect.bottom);
                return;
            }

            const targetHeader = hit.closest(".bdf-folder-header");
            const targetLi = hit.closest("li");
            const targetChannelId = !targetHeader && targetLi ? getDMChannelIdFromElement(targetLi) : null;

            if (targetHeader) {
                const targetFolderId = targetHeader.getAttribute("data-folder-id");
                if (dragState.isFolder && dragState.id === targetFolderId) return;

                const rect = targetHeader.getBoundingClientRect();
                const relY = (e.clientY - rect.top) / rect.height;

                if (!dragState.isFolder && relY >= 0.20 && relY <= 0.80) {
                    // Hover directly over folder header -> Add to folder!
                    const folderObj = findFolderById(targetFolderId);
                    const folderName = folderObj ? folderObj.name : "folderu";
                    targetHeader.classList.add("bdf-drop-combine");
                    targetHeader.setAttribute("data-bdf-drop-label", `➕ Do: ${folderName}`);
                    currentDropTarget = { type: "folder", id: targetFolderId, el: targetHeader };
                    currentDropAction = "ADD_TO_FOLDER";
                } else {
                    // Reorder folder
                    currentDropTarget = { type: "folder", id: targetFolderId, el: targetHeader };
                    currentDropAction = relY < 0.5 ? "INSERT_BEFORE" : "INSERT_AFTER";
                    showInsertLine(rect, currentDropAction === "INSERT_BEFORE" ? rect.top : rect.bottom);
                }
            } else if (targetLi && targetChannelId) {
                if (!dragState.isFolder && dragState.id === targetChannelId) return;

                const rect = targetLi.getBoundingClientRect();
                const relY = (e.clientY - rect.top) / rect.height;

                // Center 50% = combine/folder action
                if (!dragState.isFolder && relY >= 0.25 && relY <= 0.75) {
                    const targetFolder = findFolderOfChannel(targetChannelId);
                    const sourceFolder = findFolderOfChannel(dragState.id);

                    if (targetFolder) {
                        // Target is already in a folder -> Add to that folder
                        targetLi.classList.add("bdf-drop-combine");
                        targetLi.setAttribute("data-bdf-drop-label", `➕ Do: ${targetFolder.name}`);
                        currentDropTarget = { type: "folder", id: targetFolder.id, el: targetLi, channelId: targetChannelId };
                        currentDropAction = "ADD_TO_FOLDER";
                    } else if (!sourceFolder) {
                        // Neither is in a folder -> Create new folder!
                        targetLi.classList.add("bdf-drop-combine");
                        targetLi.setAttribute("data-bdf-drop-label", "📁 Utwórz folder");
                        currentDropTarget = { type: "dm", id: targetChannelId, el: targetLi };
                        currentDropAction = "CREATE_FOLDER";
                    } else {
                        // Source is in a folder, target is root -> Move out & reorder
                        currentDropTarget = { type: "dm", id: targetChannelId, el: targetLi };
                        currentDropAction = relY < 0.5 ? "INSERT_BEFORE" : "INSERT_AFTER";
                        showInsertLine(rect, currentDropAction === "INSERT_BEFORE" ? rect.top : rect.bottom);
                    }
                } else {
                    // Reorder above or below
                    currentDropTarget = { type: "dm", id: targetChannelId, el: targetLi };
                    currentDropAction = relY < 0.5 ? "INSERT_BEFORE" : "INSERT_AFTER";
                    showInsertLine(rect, currentDropAction === "INSERT_BEFORE" ? rect.top : rect.bottom);
                }
            } else {
                currentDropTarget = null;
                currentDropAction = null;
            }
        }

        function showInsertLine(targetRect, yPos) {
            if (!insertLineEl) return;
            insertLineEl.style.display = "block";
            insertLineEl.style.top = (yPos - 1.5) + "px";
            insertLineEl.style.left = targetRect.left + "px";
            insertLineEl.style.width = targetRect.width + "px";
        }

        function onMouseUp(e) {
            window.removeEventListener("mousemove", onMouseMove);
            document.body.style.userSelect = "";

            if (!dragState || !dragState.active) {
                dragState = null;
                removeDropVisuals();
                return;
            }

            const action = currentDropAction;
            const target = currentDropTarget;
            const draggedId = dragState.id;
            const isFolder = dragState.isFolder;

            removeDropVisuals();
            dragState = null;

            if (!action || !target) {
                reconcileUI();
                return;
            }

            // Execute Drop Actions
            if (action === "CREATE_FOLDER" && !isFolder && target.type === "dm") {
                // Combine draggedId and target.id into a new folder
                const newFolderId = "dmf_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
                const newFolder = {
                    id: newFolderId,
                    name: "Nowy folder",
                    color: "#f0b232",
                    collapsed: false,
                    channelIds: [target.id, draggedId]
                };

                // Remove both from existing root / folders
                state.folders.forEach(f => {
                    f.channelIds = f.channelIds.filter(id => id !== draggedId && id !== target.id);
                });
                state.folders.push(newFolder);

                // In rootOrder, replace target.id with newFolderId, remove draggedId
                const tIdx = state.rootOrder.indexOf(target.id);
                state.rootOrder = state.rootOrder.filter(id => id !== draggedId);
                if (tIdx !== -1) {
                    state.rootOrder.splice(tIdx, 1, newFolderId);
                } else {
                    state.rootOrder.unshift(newFolderId);
                }

                saveState();
                reconcileUI();

                // Open Folder Settings Modal so user can name & color it immediately!
                setTimeout(() => {
                    showFolderModal(newFolder, true);
                }, 100);

            } else if (action === "ADD_TO_FOLDER" && !isFolder && target.type === "folder") {
                // Add draggedId into target folder
                const folder = findFolderById(target.id);
                if (folder) {
                    // Remove from any other folder
                    state.folders.forEach(f => {
                        f.channelIds = f.channelIds.filter(id => id !== draggedId);
                    });
                    // Remove from rootOrder
                    state.rootOrder = state.rootOrder.filter(id => id !== draggedId);

                    if (!folder.channelIds.includes(draggedId)) {
                        folder.channelIds.push(draggedId);
                    }
                    folder.collapsed = false; // Auto-expand so user sees the dropped item

                    saveState();
                    reconcileUI();
                }

            } else if (action === "INSERT_BEFORE" || action === "INSERT_AFTER") {
                // Reordering or moving out of folder
                const insertBefore = (action === "INSERT_BEFORE");

                if (!isFolder) {
                    // Dragging a DM
                    const sourceFolder = findFolderOfChannel(draggedId);
                    const targetFolder = target.type === "dm" ? findFolderOfChannel(target.id) : null;

                    if (target.type === "root_start") {
                        // Move to very start of root list
                        if (sourceFolder) {
                            sourceFolder.channelIds = sourceFolder.channelIds.filter(id => id !== draggedId);
                        }
                        state.rootOrder = state.rootOrder.filter(id => id !== draggedId);
                        state.rootOrder.unshift(draggedId);

                    } else if (sourceFolder && targetFolder && sourceFolder.id === targetFolder.id) {
                        // Reordering within the SAME folder
                        const arr = sourceFolder.channelIds.filter(id => id !== draggedId);
                        const tIdx = arr.indexOf(target.id);
                        const insertIdx = insertBefore ? Math.max(0, tIdx) : tIdx + 1;
                        arr.splice(insertIdx, 0, draggedId);
                        sourceFolder.channelIds = arr;

                    } else if (targetFolder && (!sourceFolder || sourceFolder.id !== targetFolder.id)) {
                        // Moving DM into target's folder at specific index
                        if (sourceFolder) {
                            sourceFolder.channelIds = sourceFolder.channelIds.filter(id => id !== draggedId);
                        }
                        state.rootOrder = state.rootOrder.filter(id => id !== draggedId);

                        const arr = targetFolder.channelIds.filter(id => id !== draggedId);
                        const tIdx = arr.indexOf(target.id);
                        const insertIdx = insertBefore ? Math.max(0, tIdx) : tIdx + 1;
                        arr.splice(insertIdx, 0, draggedId);
                        targetFolder.channelIds = arr;
                        targetFolder.collapsed = false;

                    } else {
                        // Moving DM to root (outside any folder or between root items)
                        if (sourceFolder) {
                            sourceFolder.channelIds = sourceFolder.channelIds.filter(id => id !== draggedId);
                        }
                        const targetKey = target.type === "folder" ? target.id : target.id;
                        state.rootOrder = state.rootOrder.filter(id => id !== draggedId);
                        const tIdx = state.rootOrder.indexOf(targetKey);
                        const insertIdx = insertBefore ? Math.max(0, tIdx) : tIdx + 1;
                        state.rootOrder.splice(insertIdx, 0, draggedId);
                    }

                } else {
                    // Dragging an entire folder in rootOrder
                    state.rootOrder = state.rootOrder.filter(id => id !== draggedId);
                    const tIdx = state.rootOrder.indexOf(target.id);
                    const insertIdx = insertBefore ? Math.max(0, tIdx) : tIdx + 1;
                    state.rootOrder.splice(insertIdx, 0, draggedId);
                }

                saveState();
                reconcileUI();
            }
        }

        // ---------- Observer & Heartbeat ----------
        function setupObserver() {
            if (mutationObserver) mutationObserver.disconnect();

            const ul = getDMListUl();
            if (ul) {
                mutationObserver = new MutationObserver((mutations) => {
                    let shouldReconcile = false;
                    for (const m of mutations) {
                        if (m.type === "childList") {
                            // Ignore mutations caused by our own folder header rendering
                            for (const node of m.addedNodes) {
                                if (node.nodeType === 1 && !node.classList?.contains("bdf-folder-header")) {
                                    shouldReconcile = true;
                                    break;
                                }
                            }
                            for (const node of m.removedNodes) {
                                if (node.nodeType === 1 && !node.classList?.contains("bdf-folder-header")) {
                                    shouldReconcile = true;
                                    break;
                                }
                            }
                        }
                    }
                    if (shouldReconcile) scheduleReconcile();
                });

                mutationObserver.observe(ul, { childList: true });
                reconcileUI();
            } else {
                // Retry until DM sidebar is mounted
                setTimeout(setupObserver, 800);
            }
        }

        // Initial setup
        setupObserver();

        // Listen for navigation changes (switching between servers & DMs)
        const pollInterval = setInterval(() => {
            if (!running) return;
            const ul = getDMListUl();
            if (ul) {
                if (!ul.__bdf_drag_init) {
                    setupObserver();
                }
            }
        }, 1200);

        api.cleanup(() => {
            running = false;
            clearInterval(pollInterval);
            clearTimeout(reconcileTimer);
            if (mutationObserver) mutationObserver.disconnect();
            removeDropVisuals();
            document.querySelectorAll(".bdf-folder-header").forEach(el => el.remove());
            document.querySelectorAll("li[data-bdf-folder-id]").forEach(el => {
                el.removeAttribute("data-bdf-folder-id");
                el.removeAttribute("data-bdf-hidden");
                el.style.removeProperty("--bdf-item-border");
            });
            const backdrop = document.querySelector(".bdf-modal-backdrop");
            if (backdrop) backdrop.remove();
        });

        api.log("DM Folders v1.0.0 started successfully!");
    },

    stop(api) {
        api.log("DM Folders stopped.");
    },

    options(api) {
        const { h, row, note } = api.ui;
        return [
            note("Przeciągaj DM-y lewym przyciskiem myszy, aby łączyć je w foldery, dodawać do folderów, wyjmować i dowolnie sortować! Kliknij prawym przyciskiem myszy na nagłówek folderu, aby zmienić nazwę lub kolor."),
            row("Resetuj wszystkie foldery", (() => {
                const b = h("button", {
                    type: "button",
                    style: "padding: 6px 14px; background: #f23f42; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-weight: 600;"
                }, "Wyczyść foldery DM");
                b.addEventListener("click", () => {
                    if (confirm("Czy na pewno chcesz usunąć wszystkie foldery DM? Twoje wiadomości nie zostaną usunięte, a DM-y powrócą na listę główną.")) {
                        localStorage.removeItem("beecord_dm_folders_v1");
                        api.settings.set("data", { folders: [], rootOrder: [] });
                        location.reload();
                    }
                });
                return b;
            })())
        ];
    }
});
