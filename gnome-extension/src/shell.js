// SPDX-License-Identifier: GPL-3.0-or-later

// Integration with GNOME Shell itself: the top bar, the volume/brightness
// OSD and keyboard state. Everything here is undone in `destroy()`.

import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import {clutterBackend} from './compat.js';

// Isle's top bar colour per `top-bar-style`, added to the bar's inline style so other extensions keep
// theirs, and re-added when one replaces it (Blur my Shell does). Glass has no colour of its own.
/** More changes of the bar's style than this in a second are a fight with another extension. */
const MAX_RESTYLES_PER_SECOND = 5;

const BAR_STYLES = {
    black: 'background-color: #000000;',
    glass: 'background-color: transparent;',
};
/** Style class giving the glass bar's text a shadow to read on any wallpaper. */
const GLASS_BAR_CLASS = 'isle-glass-bar';
/** Style class making the top bar slimmer; see stylesheet.css. */
const COMPACT_BAR_CLASS = 'isle-compact-bar';
/** Style class making the top bar as tall as the closed island. */
const NOTCH_BAR_CLASS = 'isle-notch-bar';

// Restyles the top bar around the island (black or glass) and hides the clock and its calendar menu.
// Signals: `height-changed`, `style-changed` (`blendsIn` may have changed), `calendar-requested` (Super+V),
// `panel-visibility-changed` (when the panel hides or shows, e.g. via Hide Top Bar).
export class TopBar extends Signals.EventEmitter {
    constructor(settings) {
        super();
        this._settings = settings;
        this._toggle = () => this.emit('calendar-requested');
        this._dateMenu = Main.panel.statusArea.dateMenu;
        this._dateMenu.opacity = 0;
        this._dateMenu.reactive = false;

        this._panelBox = Main.layoutManager.panelBox;
        this._panelHidden = this.isPanelHidden;
        this._panelBoxChanged = [
            this._panelBox.connect('notify::y', () => this._onPanelVisibility()),
            this._panelBox.connect('notify::translation-y', () => this._onPanelVisibility()),
            this._panelBox.connect('notify::visible', () => this._onPanelVisibility()),
        ];

        this._settingsChanged = [
            settings.connect('changed::top-bar-style', () => {
                this._yielded = false;
                this._applyStyle();
                this.emit('style-changed');
            }),
            settings.connect('changed::compact-top-bar', () => this._applyStyle()),
            settings.connect('changed::island-in-top-bar', () => this._applyStyle()),
        ];
        this._applyStyle();
        this._styleChanged = Main.panel.connect('notify::style', () => this._onPanelStyle());

        this._heightChanged = Main.panel.connect('notify::height', () => this.emit('height-changed'));

        // The calendar shortcut opens the island instead, and the hidden clock's menu is closed again
        // should anything else open it; unless Super+V is left to GNOME (Settings).
        this._superVChanged = settings.connect('changed::super-v', () => this._syncCalendar());
        this._syncCalendar();
        this._menuChanged = this._dateMenu.menu.connect('open-state-changed', (menu, open) => {
            if (open && !this._clockShown && this._settings.get_string('super-v') === 'isle')
                menu.close();
        });
    }

    /** Whether the top bar panel is hidden (e.g. by Hide Top Bar or intellihide). */
    get isPanelHidden() {
        if (!this._panelBox.visible)
            return true;
        const baseY = Main.layoutManager.primaryMonitor?.y ?? 0;
        const height = this._panelBox.height || 32;
        return this._panelBox.y <= baseY - height + 1 || this._panelBox.translation_y <= -height + 1;
    }

    _onPanelVisibility() {
        const hidden = this.isPanelHidden;
        if (hidden !== this._panelHidden) {
            this._panelHidden = hidden;
            this.emit('panel-visibility-changed', hidden);
        }
    }

    get height() {
        return Main.panel.height;
    }

    _syncCalendar() {
        if (this._settings.get_string('super-v') !== 'isle') {
            this._restoreToggle();
        } else if (Main.panel.toggleCalendar !== this._toggle) {
            // Another extension's own, put back when Isle stops (GNOME's is the prototype's).
            this._priorToggle = Object.hasOwn(Main.panel, 'toggleCalendar') ? Main.panel.toggleCalendar : null;
            Main.panel.toggleCalendar = this._toggle;
        }
    }

    /** Undoes Isle's toggleCalendar, unless another extension has set its own since. */
    _restoreToggle() {
        if (Main.panel.toggleCalendar !== this._toggle)
            return;
        if (this._priorToggle)
            Main.panel.toggleCalendar = this._priorToggle;
        else
            delete Main.panel.toggleCalendar;
    }

    /** Whether the bar is as black as the island; otherwise the island hangs from the screen's top edge. */
    get blendsIn() {
        return this._settings.get_string('top-bar-style') === 'black';
    }

    /** Keeps the top bar's centre clear for the island. */
    reserveWidth(width) {
        this._dateMenu.set_width(Math.ceil(width));
    }

    /** Shows GNOME's own clock in the top bar while the island is on another display. */
    set clockShown(shown) {
        this._clockShown = shown;
        this._dateMenu.opacity = shown ? 255 : 0;
        this._dateMenu.reactive = shown;
        if (shown)
            this._dateMenu.set_width(-1);
        else if (this._settings.get_string('super-v') === 'isle')
            this._dateMenu.menu.close();
    }

    _applyStyle() {
        this._syncColor();
        // The bar's height changes with these; `height-changed` re-lays out the island.
        setStyleClasses(Main.panel, {
            [COMPACT_BAR_CLASS]: this._settings.get_boolean('compact-top-bar'),
            [NOTCH_BAR_CLASS]: this._settings.get_boolean('island-in-top-bar'),
            [GLASS_BAR_CLASS]: this._settings.get_string('top-bar-style') === 'glass',
        });
    }

    // Another extension that sets the bar's style too would undo Isle's rule each time Isle set it, in a
    // loop that keeps the shell busy: past a few times a second, Isle gives way until the setting changes.
    _onPanelStyle() {
        if (this._yielded)
            return;
        const now = GLib.get_monotonic_time();
        this._restyles = (this._restyles ?? []).filter(at => now - at < 1e6);
        this._restyles.push(now);
        if (this._restyles.length > MAX_RESTYLES_PER_SECOND) {
            this._yielded = true;
            console.warn('Isle: another extension keeps changing the top bar\'s style; Isle stops setting its colour');
            return;
        }
        this._syncColor();
    }

    /** Sets Isle's colour rule, leaving the rest of the style alone. */
    _syncColor(barStyle = this._settings.get_string('top-bar-style')) {
        const style = Main.panel.get_style() ?? '';
        const others = Object.values(BAR_STYLES)
            .reduce((rest, rule) => rest.replace(rule, ''), style).trim();
        const rule = BAR_STYLES[barStyle];
        const wanted = rule ? `${others} ${rule}`.trim() : others;
        // Setting it notifies again, and then nothing changes.
        if (wanted !== style)
            Main.panel.set_style(wanted || null);
    }

    destroy() {
        // Tell no one about changes made while tearing down.
        this.disconnectAll();
        this._settingsChanged.forEach(id => this._settings.disconnect(id));
        this._panelBoxChanged?.forEach(id => this._panelBox.disconnect(id));
        Main.panel.disconnect(this._heightChanged);
        Main.panel.disconnect(this._styleChanged);
        this._dateMenu.menu.disconnect(this._menuChanged);
        this._settings.disconnect(this._superVChanged);
        this._restoreToggle();

        // No colour of Isle's: the theme's again.
        this._syncColor(null);
        setStyleClasses(Main.panel, {
            [COMPACT_BAR_CLASS]: false, [NOTCH_BAR_CLASS]: false, [GLASS_BAR_CLASS]: false,
        });
        this._dateMenu.set_width(-1);
        this._dateMenu.opacity = 255;
        this._dateMenu.reactive = true;
    }
}

// Adds or removes each of `classes` ({name: on}) in one change: each change restyles the whole bar at once.
function setStyleClasses(actor, classes) {
    const current = (actor.get_style_class_name() ?? '').split(/\s+/).filter(Boolean);
    const kept = current.filter(name => !(name in classes));
    const wanted = [...kept, ...Object.keys(classes).filter(name => classes[name])];
    if (wanted.length !== current.length || wanted.some(name => !current.includes(name)))
        actor.set_style_class_name(wanted.join(' ') || null);
}

// Routes GNOME's volume and brightness OSDs to `handler`; if it returns false, GNOME shows its own.
// GNOME 46–48: `show(monitorIndex, icon, label, level, maxLevel)`; 49: `show(icon, label, levels)`, plus `showAll()`.
export class OsdHook {
    constructor(handler) {
        const manager = Main.osdWindowManager;
        this._manager = manager;
        const self = this;
        const perMonitor = typeof manager.showAll === 'function';
        const adapters = perMonitor
            ? {
                show: (icon, label, levels) => {
                    const {level, maxLevel} = levels?.[Main.layoutManager.primaryIndex] ??
                        Object.values(levels ?? {}).find(Boolean) ?? {};
                    return handler(icon, label, level, maxLevel);
                },
                showAll: (icon, label, level, maxLevel) => handler(icon, label, level, maxLevel),
            }
            : {
                show: (_monitorIndex, icon, label, level, maxLevel) => handler(icon, label, level, maxLevel),
            };
        this._hooks = Object.entries(adapters).map(([name, handled]) => {
            const original = manager[name];
            // Left in place under another extension's wrapper once Isle stops: then it only passes through.
            const hook = function (...args) {
                // Isle failing must not take GNOME's own OSD with it.
                try {
                    if (!self._destroyed && handled(...args))
                        return;
                } catch (e) {
                    console.warn(`Isle: could not show the OSD: ${e.message}`);
                }
                original.apply(this, args);
            };
            // Set when another extension wrapped it before us.
            const ownOriginal = Object.hasOwn(manager, name) ? original : null;
            manager[name] = hook;
            return {name, hook, ownOriginal};
        });
    }

    destroy() {
        this._destroyed = true;
        // Only undo our own overrides; another extension may have wrapped
        // them since. GNOME's methods live on the prototype.
        for (const {name, hook, ownOriginal} of this._hooks) {
            if (this._manager[name] !== hook)
                continue;
            if (ownOriginal)
                this._manager[name] = ownOriginal;
            else
                delete this._manager[name];
        }
    }
}

/** Emits `caps-lock` (on) when Caps Lock is turned on or off. */
export class KeyboardWatcher extends Signals.EventEmitter {
    constructor() {
        super();
        this._keymap = clutterBackend().get_default_seat().get_keymap();
        this._capsLock = this._keymap.get_caps_lock_state();
        this._keymapChanged = this._keymap.connect('state-changed', () => {
            const capsLock = this._keymap.get_caps_lock_state();
            if (capsLock !== this._capsLock) {
                this._capsLock = capsLock;
                this.emit('caps-lock', capsLock);
            }
        });
    }

    destroy() {
        // Tell no one about changes made while tearing down.
        this.disconnectAll();
        this._keymap.disconnect(this._keymapChanged);
    }
}
