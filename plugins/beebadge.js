// BeeBadge v1.0.0: the beebadge (the beecord bee) on your Discord profile, next to your other badges.
//
// The badge is a vector image (SVG), so it stays sharp at every size. It copies the look and size of a real Discord badge
// in the same row, so it is exactly as big as the others. Turn it off in this plugin's settings (it disappears instantly).
//
// HOW IT WORKS: Discord draws the badge row of a profile (pop-out, full profile, settings preview) in the page. This plugin
// finds that row, checks that the profile belongs to YOU, and adds the bee to it. It does not need Discord's internal
// modules (webpack), so it starts immediately. No network access, nothing is sent anywhere.
//
// LIMIT: everything here runs on your own client. So you see the beebadge on your own profile. Showing it to OTHER people
// on their screens would need a small server that lists who uses the mod (that is how Vencord's badges work).
(window.beecord || window.blxstncord).definePlugin({
    id: "beebadge",
    name: "BeeBadge",
    description: "Adds the beebadge (bee logo) to your Discord profile, next to your other badges, same size as Discord's own. Can be switched off in the settings.",
    author: "beecord",
    version: "1.0.1",
    enabledByDefault: true,
    webpack: false,

    start(api) {
        const NAME = "beebadge";
        const SNOW = /^\d{17,20}$/;
        const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1222 1222"><path fill="#000" fill-rule="evenodd" d="M34 98 69 176 102 240 136 295 165 332 196 361 263 389 295 401 356 420 358 422 236 504 400 545 505 518 509 519 482 543 439 572 409 595 373 627 347 669 324 718 309 768 309 772 316 778 308 789 308 802 312 827 320 856 331 882 346 907 356 920 382 944 386 936 425 975 453 996 480 1012 508 1025 533 1034 587 1048 622 1053 694 1091 761 1123 737 1085 711 1049 680 998 648 932 633 894 622 857 645 831 672 868 697 898 729 931 743 943 745 937 746 885 748 881 753 894 780 1007 790 969 795 935 795 880 788 817 731 740 729 735 754 728 772 719 790 707 818 680 831 662 841 645 847 645 881 656 900 667 911 676 934 703 944 725 951 749 963 737 990 699 1009 661 1019 627 1020 599 1017 587 1010 572 998 557 993 585 990 585 985 558 978 538 978 525 975 509 969 491 958 470 999 440 1024 427 1052 418 1059 417 1079 428 1116 456 1183 520 1187 522 1183 503 1173 473 1157 442 1142 421 1124 402 1110 392 1057 367 1043 370 1018 380 972 408 933 436 920 425 874 429 842 413 841 411 892 365 941 329 968 330 1006 335 1040 343 1082 358 1104 362 1109 361 1063 315 1027 291 964 282 914 281 887 310 858 347 822 404 780 387 721 307 638 204 518 137 442 102 440 103 487 223 501 253 573 333 572 334 417 221 304 145 197 123 68 102Z"/><path fill="#FFC800" fill-rule="evenodd" d="M613 890 611 913 589 927 577 937 563 952 553 966 540 995 536 1021 573 1032 625 1041 730 1096 692 1043 660 990 637 945ZM588 803 571 802 538 809 511 819 472 841 443 865 426 884 411 906 399 933 435 968 473 994 470 985 470 969 473 954 484 930 499 910 519 891 537 878 555 868 574 860 592 855 603 860ZM718 742 703 786 712 793 751 834 763 879 780 959 784 926 784 893 777 822ZM572 748 551 735 530 726 506 719 477 715 443 716 418 721 391 731 364 747 336 772 320 792 321 811 327 840 336 865 354 898 372 920 361 887 356 853 376 827 406 801 442 781 464 773 493 766 509 764 549 764 572 768 584 772ZM669 653 661 679 644 796 677 852 698 880 722 906 690 805 683 788 711 708 697 698 687 687 679 675ZM772 607 783 656 768 689 748 716 773 704 791 690 811 667 821 649 819 646 795 630ZM900 565 904 602 930 628 919 596ZM621 695 607 673 587 648 559 621 539 607 506 572 532 553 506 557 473 565 461 572 418 603 381 636 361 668 344 701 327 746 365 700 383 663 397 659 427 655 460 655 489 659 524 669 545 678 578 698 603 719 620 738ZM557 543 604 552 626 560 645 570 667 587 683 604 700 629 715 659 734 663 754 664 737 646 724 623 719 609 707 553 699 525 673 489 608 488 585 509ZM845 466 830 475 819 486 809 503 803 525 803 550 810 576 821 595 841 615 894 644 922 665 944 691 952 706 958 723 981 690 999 653 1005 635 1009 613 1008 599 1004 585 997 615 984 639 979 599 972 573 959 544 943 520 922 498 893 477 860 462ZM849 496 865 508 885 527 903 548 919 571 930 592 941 622 946 646 946 655 886 627 871 616 861 606 850 591 844 579 838 557 839 524ZM878 440 895 450 926 473 964 511 958 494 948 475 933 454 917 437ZM264 499 401 533 563 491 477 495 401 503 335 485 385 450 434 444 366 431ZM784 408 753 413 725 423 696 440 679 454 697 483 724 504 760 570 754 539 754 514 761 483 772 462 782 453 803 443 828 438 855 438 821 421ZM941 444 950 457 954 459 983 437 1019 417 1045 408 1062 406 1079 415 1110 437 1168 491 1153 457 1139 435 1123 416 1099 398 1057 378 1036 384 1010 397ZM841 395 893 349 938 317 973 319 1009 324 1042 332 1080 345 1044 314 1021 301 970 294 920 292 900 313 878 340ZM461 123 510 245 569 312 623 367 543 243 523 188 524 185 603 227 654 281 709 344 708 346 634 301 677 358 708 403 732 396 768 389 711 313 629 212 529 156ZM57 115 100 206 134 266 169 315 202 349 249 370 299 389 387 416 504 442 647 467 579 411 495 350 401 289 309 236 340 271 405 336 440 367 495 411 491 412 437 399 361 375 290 346 233 318 180 251 156 214 130 169 139 168 177 172 287 188 385 245 471 300 565 366 650 433 665 422 615 381 495 291 377 207 301 157 202 137Z"/></svg>';
        const SRC = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(SVG);
        const ROW_SEL = '[class*="profileBadges"], [class*="userBadges"], [class*="badgeList"], [aria-label="User Badges"], [aria-label="Badges"]';
        const IS_API = /^(?:https?:\/\/(?:[\w-]+\.)?discord(?:app)?\.com)?\/api\//i;
        let stopped = false;

        // ============================ who am I (the badge is only drawn on your own profile) ============================
        let me = null, lastWebpack = 0;
        const setMe = v => { if (typeof v === "string" && SNOW.test(v)) { const fresh = me !== v; me = v; if (fresh) { try { schedule(); } catch { } } return true; } return false; };
        // the first part of a Discord login token is your user id (base64). Only that id is read; the token is not kept.
        const idFromToken = t => { try { return atob(String(t).split(".")[0].replace(/-/g, "+").replace(/_/g, "/")); } catch { return null; } };
        const sniff = v => { if (me || typeof v !== "string" || v.length < 30 || /^(bot|bearer)\s/i.test(v)) return; setMe(idFromToken(v)); };
        const authFrom = h => {
            try {
                if (!h) return null;
                if (typeof h.get === "function") return h.get("authorization");
                if (Array.isArray(h)) { const p = h.find(x => x && String(x[0]).toLowerCase() === "authorization"); return p && p[1]; }
                for (const k of Object.keys(h)) if (k.toLowerCase() === "authorization") return h[k];
            } catch { }
            return null;
        };
        api.patch(window, "fetch", orig => function (input, init) {
            try {
                if (!me) {
                    const url = typeof input === "string" ? input : (input && input.url) || String(input);
                    if (IS_API.test(url)) sniff(authFrom(init && init.headers) || authFrom(input && typeof input === "object" && input.headers));
                }
            } catch { }
            return orig.call(this, input, init);
        });
        api.patch(XMLHttpRequest.prototype, "open", orig => function (method, url, ...rest) {
            try { this.__beeApi = !me && IS_API.test(String(url)); } catch { }
            return orig.call(this, method, url, ...rest);
        });
        api.patch(XMLHttpRequest.prototype, "setRequestHeader", orig => function (k, v) {
            try { if (this.__beeApi && String(k).toLowerCase() === "authorization") sniff(v); } catch { }
            return orig.call(this, k, v);
        });

        function myId() {
            if (me) return me;
            try {
                const raw = window.localStorage && window.localStorage.getItem("token");
                if (raw) {
                    const parsed = JSON.parse(raw);
                    if (typeof parsed === "string") { const id = idFromToken(parsed); if (setMe(id)) return me; }
                }
            } catch { }
            try {
                const v = localStorage.getItem("user_id_cache");
                if (v) { let s = v; try { s = JSON.parse(v); } catch { } if (setMe(String(s))) return me; }
            } catch { }
            if (Date.now() - lastWebpack > 10000) {
                lastWebpack = Date.now();
                try {
                    const st = (api.webpack.find && api.webpack.find(o => o && typeof o.getCurrentUser === "function", 1)) ||
                        (api.webpack.findByProps && api.webpack.findByProps(["getCurrentUser"], "getCurrentUser", "getUser")) ||
                        api.webpack.findBy("beebadge-user", ["getCurrentUser"], o => typeof o.getCurrentUser === "function");
                    const u = st && st.getCurrentUser();
                    if (u) setMe(String(u.id));
                } catch { }
            }
            return me;
        }

        // ============================ which user does a badge row belong to ============================
        const fiberOf = el => { for (const k of Object.keys(el)) if (k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")) return el[k]; return null; };
        function ownerId(el) {
            let f = fiberOf(el);
            for (let i = 0; f && i < 60; i++, f = f.return) {
                const p = f.memoizedProps;
                if (!p || typeof p !== "object") continue;
                for (const x of [p.user && p.user.id, p.userId, p.user_id, p.profileUser && p.profileUser.id, p.targetUser && p.targetUser.id,
                                 p.member && p.member.userId, p.profile && p.profile.userId, p.displayProfile && p.displayProfile.userId])
                    if (typeof x === "string" && SNOW.test(x)) return x;
            }
            return null;
        }

        // ============================ find the badge rows and add the bee ============================
        function rows() {
            const set = new Set(document.querySelectorAll(ROW_SEL));
            for (const img of document.querySelectorAll('img[class*="profileBadge"]')) {
                const r = img.closest('[class*="profileBadges"]') || (img.parentElement && img.parentElement.parentElement);
                if (r) set.add(r);
            }
            const all = [...set];
            return all.filter(el => !all.some(o => o !== el && el.contains(o)));   // innermost rows only
        }

        function build(row) {
            // copy a real badge of this row, so size, spacing and shape are exactly Discord's
            const tpl = [...row.children].find(c => !c.hasAttribute("data-bee") && c.querySelector && (c.matches("img") || c.querySelector("img")));
            let el, img;
            if (tpl) {
                el = tpl.cloneNode(true);
                el.removeAttribute("href"); el.removeAttribute("id");
                el.querySelectorAll("[id]").forEach(n => n.removeAttribute("id"));
                img = el.matches("img") ? el : el.querySelector("img");
                img.removeAttribute("srcset");
            } else {
                el = document.createElement("div");
                el.style.cssText = "display:inline-flex;flex:none;width:22px;height:22px;margin-left:4px";
                img = document.createElement("img");
                img.style.cssText = "width:100%;height:100%";
                el.append(img);
            }
            img.src = SRC; img.alt = NAME; img.draggable = false;
            img.style.objectFit = "contain";
            img.setAttribute("aria-label", NAME);
            el.setAttribute("data-bee", "1");
            el.setAttribute("title", NAME);
            el.setAttribute("aria-label", NAME);
            el.style.cursor = "default";
            return el;
        }

        const stat = { rows: 0, own: 0, added: 0 };
        function scan() {
            if (stopped) return;
            if (!api.settings.get("show", true)) { document.querySelectorAll("[data-bee]").forEach(n => n.remove()); return; }
            const mine = myId();
            let rowsNow = 0, ownNow = 0;
            for (const row of rows()) {
                rowsNow++;
                const has = row.querySelector("[data-bee]");
                const own = !!(mine && ownerId(row) === mine);
                if (own) ownNow++;
                if (own && !has) { row.append(build(row)); stat.added++; }
                else if (!own && has) has.remove();
            }
            if (rowsNow !== stat.rows || ownNow !== stat.own) {
                stat.rows = rowsNow; stat.own = ownNow;
                api.log("badge rows on screen: " + rowsNow + ", of them yours: " + ownNow);
            }
        }

        let timer = null;
        function schedule() {
            if (timer || stopped) return;
            timer = setTimeout(() => { timer = null; try { scan(); } catch (e) { api.log("scan error: " + (e && e.message || e)); } }, 150);
        }
        const mo = new MutationObserver(schedule);
        mo.observe(document.documentElement, { childList: true, subtree: true });
        api.on(window, "blx-beebadge", schedule);   // fired by the settings switch

        const report = () => api.log("self-check: own user id " + (me ? "known" : "NOT known (the bee cannot tell which profile is yours)") +
            ", badge rows seen " + stat.rows + " (yours " + stat.own + "), bees added " + stat.added);
        const rt = [10000, 45000].map(ms => setTimeout(report, ms));

        api.cleanup(() => {
            stopped = true;
            mo.disconnect(); clearTimeout(timer); rt.forEach(clearTimeout);
            document.querySelectorAll("[data-bee]").forEach(n => n.remove());
        });
        schedule();
        api.log("BeeBadge v1.0.0 started");
    },

    options(api) {
        const { row, toggle, note } = api.ui;
        return [
            row("Show the beebadge on my profile",
                toggle(api.settings.get("show", true), v => { api.settings.set("show", v); try { window.dispatchEvent(new Event("blx-beebadge")); } catch { } })),
            note("The bee appears next to your other badges when you open your own profile (click your avatar or name). " +
                "It is drawn by the mod on your own screen, so other people only see it if they also run the mod and a badge list exists for it.")
        ];
    }
});
