// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// When the closed island auto-hides: no GNOME imports, so it can be tested without a shell.

/** When the closed island on screen hides ('now', 'later' after Settings' wait, or false) for `mode` (off, always,
 * top-bar, windows, or dodge); at once over a full-screen app, which it shows only for alerts. */
export function autoHide({mode, presentation, visible, hovered, fullscreen, barHidden, windowAtTop, fromTopEdge, dodged}) {
    if (!visible || presentation !== 'compact')
        return false;
    if (mode === 'dodge') {
        const isFullscreen = fullscreen || barHidden;
        // Do not dodge or hide when app is not fullscreen / top bar not hidden
        if (!isFullscreen)
            return false;
        // When top bar is hidden (by autohide topbar), island hides too.
        // It only appears when autohide topbar appears (or pointer reaches top barrier)
        if (barHidden)
            return fromTopEdge ? false : 'now';
        // When top bar is shown, dodge pointer on hover or stay dodged
        if (dodged || hovered)
            return 'now';
        return false;
    }
    if (fullscreen || (mode === 'top-bar' && barHidden))
        return 'now';
    if (hovered)
        return false;
    if (mode === 'always' || (mode === 'windows' && windowAtTop))
        return 'later';
    return false;
}

/** How much of the hidden island's top takes the pointer to bring it back, in px: none over a full-screen app or
 * with a hidden bar (that bar comes back first), else the bar's band, or `edge` at a display's top. */
export function revealBand({mode, fullscreen, barHeight, edge}) {
    if (fullscreen || mode === 'top-bar')
        return 0;
    if (mode === 'dodge')
        return edge;
    return Math.max(barHeight, edge);
}
