// SPDX-License-Identifier: GPL-3.0-or-later

// Notifications: a heading with Do Not Disturb and Clear (and, while it is on, what still gets through),
// over a list of one-line rows, newest first. Click one to open it. See docs/product-spec.md.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {VERTICAL} from '../compat.js';
import * as Format from '../format.js';
import {notificationIcon, plainBody} from '../notifications.js';
import {icon, iconButton, isSymbolic, label, ownIcon, pillButton, setButtonIcon, wrapLines} from '../widgets.js';
import {Page} from './page.js';

/** A card offers at most this many of its notification's buttons ("Mark as read", "Accept"). */
const MAX_ACTIONS = 3;

/** The app's icon, small beside its row: a colour one as is, a symbolic one on a grey rounded square. */
function notificationBadge(gicon) {
    gicon = gicon ? ownIcon(gicon) : icon('dialog-information-symbolic');
    if (!isSymbolic(gicon))
        return new St.Icon({gicon, icon_size: 20, y_align: Clutter.ActorAlign.CENTER});
    return new St.Bin({
        style_class: 'isle-notification-glyph',
        child: new St.Icon({gicon, icon_size: 12}),
        y_align: Clutter.ActorAlign.CENTER,
    });
}

export const NotificationsPage = GObject.registerClass(
class NotificationsPage extends Page {
    _init(daemon, center, {height} = {}) {
        super._init(daemon, {
            style_class: 'isle-page isle-notifications',
            layout_manager: new Clutter.BoxLayout({orientation: Clutter.Orientation.VERTICAL}),
        });
        this.name = 'notifications';
        this._center = center;
        /** Apps whose stack of notifications is unfolded. */

        this.add_child(this._buildBar());
        this.add_child(this._buildDndNote());
        this.add_child(this._buildList());

        this._centerHandlers = [
            // Closed, the list is only rebuilt when next shown (see `onActivate`).
            center.connect('changed', () => this._onListChanged()),
            // Shown anew but not marked seen: its banner does that once shown (see `acknowledge`).
            center.connect('updated', () => this._onListChanged({seen: false})),
            // Seen or not shows only in the tab's dot: the cards stay.
            center.connect('seen-changed', () => this.emit('news-changed')),
            center.connect('dnd-changed', () => this._updateDnd()),
        ];
        // Notifications expanded by user to show full message text and details.
        this._expanded = new Set();
        // Built when first warmed up or shown (see `warmUp`).
        this._times = [];
        this._stale = true;
        this._updateDnd();
        this.connect('destroy', () => this._onDestroy());
    }

    get relevant() {
        return this._center.hasUnseen;
    }

    get hasNews() {
        return this._center.hasUnseen;
    }

    get preferredHeight() {
        const barHeight = 40 + (this._dndNote?.visible ? 26 : 0);
        const notifications = this._center?.notifications ?? [];
        if (notifications.length === 0)
            return barHeight + 110;

        let listHeight = 0;
        const children = this._list?.get_children() ?? [];
        if (children.length > 0) {
            for (const child of children) {
                const [, natural] = child.get_preferred_height(-1);
                listHeight += (natural > 0 ? natural : 38) + 4;
            }
        } else {
            for (const n of notifications) {
                const key = this._notificationKey(n);
                listHeight += (this._expanded?.has(key) ? 140 : 38) + 4;
            }
        }
        return Math.max(130, Math.round(barHeight + listHeight + 8));
    }

    /** How many there are, then Do Not Disturb and Clear All as small round buttons. */
    _buildBar() {
        const bar = new St.BoxLayout({style_class: 'isle-notifications-bar'});
        bar.add_child(label('Notifications', 'isle-notifications-heading', {x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        this._dndButton = iconButton('isle-bell', 'isle-button-flat isle-dnd-toggle', () => {
            this._center.dnd = !this._center.dnd;
        }, {size: 13, accessibleName: 'Do Not Disturb'});
        this._dndButton.y_align = Clutter.ActorAlign.CENTER;
        this._clearButton = pillButton('Clear', 'isle-pill-small isle-notifications-clear', () => this._center.clearAll());
        this._clearButton.y_align = Clutter.ActorAlign.CENTER;
        bar.add_child(this._dndButton);
        bar.add_child(this._clearButton);
        return bar;
    }

    /** While Do Not Disturb is on, what it does: a moon and a line under the heading. */
    _buildDndNote() {
        this._dndNote = new St.BoxLayout({style_class: 'isle-notifications-dnd-note', visible: false});
        // Dimmed as the line beside it: the moon is drawn white, so its colour can't be set.
        this._dndNote.add_child(new St.Icon({gicon: icon('isle-moon'), icon_size: 10, opacity: 130, y_align: Clutter.ActorAlign.CENTER}));
        const text = label('Do Not Disturb: new ones wait here; urgent ones still show', 'isle-notifications-dnd-text',
            {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        text.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._dndNote.add_child(text);
        return this._dndNote;
    }

    _buildList() {
        this._list = new St.BoxLayout({...VERTICAL, style_class: 'isle-notification-list'});
        this._scroll = new St.ScrollView({
            style_class: 'isle-notifications-scroll isle-task-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            // Automatic vertical scrollbar overlaying smoothly on the right
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
        });
        this._scroll.set_child(this._list);

        this._empty = new St.BoxLayout({...VERTICAL, style_class: 'isle-empty', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        this._empty.add_child(new St.Icon({gicon: icon('isle-bell'), icon_size: 24, style_class: 'isle-empty-icon', x_align: Clutter.ActorAlign.CENTER}));
        this._empty.add_child(label('No notifications', 'isle-empty-title', {x_align: Clutter.ActorAlign.CENTER}));
        this._empty.add_child(label('You’re all caught up', 'isle-empty-hint', {x_align: Clutter.ActorAlign.CENTER}));

        const column = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        column.add_child(this._scroll);
        column.add_child(this._empty);
        return column;
    }

    _onListChanged({seen = true} = {}) {
        if (this.active)
            this._update({seen});
        else
            this._stale = true;
        this.markCold();
        this.emit('news-changed');
    }

    _notificationKey(notification) {
        return notification.id ?? `${notification.source?.id || 'app'}:${notification.title || ''}:${notification.datetime?.to_unix?.() || 0}`;
    }

    _update({seen = true} = {}) {
        this._stale = false;
        /** Each row's "5m ago", with when it came, to bring up to date without a rebuild. */
        this._times = [];
        const notifications = this._center.notifications;
        this._clearButton.visible = notifications.some(n => !n.resident);

        // Prune any expanded keys that are no longer in notifications
        const activeKeys = new Set(notifications.map(n => this._notificationKey(n)));
        for (const key of this._expanded) {
            if (!activeKeys.has(key))
                this._expanded.delete(key);
        }

        // Newest first, one row each, as a list to scroll.
        this._list.destroy_all_children();
        for (const notification of notifications)
            this._list.add_child(this._row(notification));
        this._empty.visible = notifications.length === 0;
        this._scroll.visible = notifications.length > 0;

        // Seen while open: no unread dot for something already on screen.
        if (this.active && seen)
            this._center.acknowledgeAll();
        this.emit('height-changed');
    }

    _updateDnd() {
        const on = this._center.dnd;
        if (on)
            this._dndButton.add_style_pseudo_class('checked');
        else
            this._dndButton.remove_style_pseudo_class('checked');
        setButtonIcon(this._dndButton, on ? 'isle-moon' : 'isle-bell');
        this._dndNote.visible = on;
    }

    _row(notification) {
        const key = this._notificationKey(notification);
        const container = new St.BoxLayout({...VERTICAL, style_class: 'isle-notification-row-container', x_expand: true});

        const refreshRow = () => {
            container.destroy_all_children();
            const isExpanded = this._expanded.has(key);
            if (isExpanded) {
                container.add_child(this._buildExpandedRow(notification, key, () => {
                    this._expanded.delete(key);
                    refreshRow();
                }));
            } else {
                container.add_child(this._buildCollapsedRow(notification, key, () => {
                    this._expanded.add(key);
                    refreshRow();
                }));
            }
            this.emit('height-changed');
        };

        refreshRow();
        return container;
    }

    /** Collapsed row: single line summary with ellipsis preview, hover tools, and expand chevron. */
    _buildCollapsedRow(notification, key, onExpand) {
        const content = new St.BoxLayout({style_class: 'isle-notification', x_expand: true});

        const titleText = (notification.title || notification.source?.title || '').replace(/\s+/g, ' ').trim();
        const rawBody = this._sharing ? '' : plainBody(notification).replace(/\s+/g, ' ').trim();
        const hasExpandable = rawBody.length > 0;

        const line = new St.BoxLayout({style_class: 'isle-notification-line', x_expand: true, y_align: Clutter.ActorAlign.CENTER});

        // App icon & title: clicking activates the notification and opens the app
        const titleButton = new St.Button({
            style_class: 'isle-notification-click-area',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const titleBox = new St.BoxLayout({style_class: 'isle-notification-title-box', y_align: Clutter.ActorAlign.CENTER});
        titleBox.add_child(notificationBadge(notificationIcon(notification)));
        const titleLabel = label(titleText, 'isle-notification-title');
        titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        titleBox.add_child(titleLabel);
        titleButton.set_child(titleBox);
        titleButton.connect('clicked', () => {
            notification.activate();
            this.emit('request-close');
        });
        line.add_child(titleButton);

        // Body preview: clicking expands the notification to show full message
        if (hasExpandable) {
            const bodyButton = new St.Button({
                style_class: 'isle-notification-body-button',
                x_expand: true,
                can_focus: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const bodyLabel = label(rawBody, 'isle-notification-body', {x_expand: true});
            bodyLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            bodyButton.set_child(bodyLabel);
            bodyButton.connect('clicked', () => onExpand());
            line.add_child(bodyButton);
        } else {
            titleLabel.x_expand = true;
            titleButton.x_expand = true;
        }

        content.add_child(line);

        // The time, and in its place under the pointer the buttons and ×.
        const corner = new St.Widget({layout_manager: new Clutter.BinLayout(), y_align: Clutter.ActorAlign.CENTER});
        const time = label(Format.ago(notification.datetime), 'isle-notification-time', {x_align: Clutter.ActorAlign.END});
        this._times.push([time, notification.datetime]);
        corner.add_child(time);
        const tools = new St.BoxLayout({style_class: 'isle-notification-tools', x_align: Clutter.ActorAlign.END, opacity: 0, visible: false});
        const actions = this._sharing ? [] : (notification.actions ?? []).slice(0, MAX_ACTIONS);
        for (const action of actions) {
            tools.add_child(pillButton(action.label, 'isle-pill-small isle-notification-action', () => {
                action.activate();
                this.emit('request-close');
            }));
        }
        if (!notification.resident) {
            const dismiss = iconButton('isle-close-symbolic', 'isle-button-flat isle-notification-dismiss',
                () => notification.destroy(), {size: 10, accessibleName: 'Dismiss'});
            dismiss.y_align = Clutter.ActorAlign.CENTER;
            tools.add_child(dismiss);
        }
        corner.add_child(tools);
        content.add_child(corner);

        // Dedicated chevron button to expand notification
        if (hasExpandable) {
            const expandBtn = iconButton('isle-chevron-down-symbolic', 'isle-button-flat isle-notification-expand',
                () => onExpand(), {size: 12, accessibleName: 'Expand notification'});
            expandBtn.y_align = Clutter.ActorAlign.CENTER;
            content.add_child(expandBtn);
        }

        const row = new St.BoxLayout({
            style_class: 'isle-notification-row',
            x_expand: true,
            reactive: true,
            track_hover: true,
        });
        row.add_child(content);

        if (tools.get_n_children() > 0) {
            row.connect('notify::hover', () => {
                tools.show();
                tools.ease({opacity: row.hover ? 255 : 0, duration: 120,
                    onComplete: () => (tools.visible = row.hover)});
                time.ease({opacity: row.hover ? 0 : 255, duration: 120});
            });
        }
        return row;
    }

    /** Expanded row: full multi-line message body without ellipsis, explicit actions, and collapse chevron. */
    _buildExpandedRow(notification, key, onCollapse) {
        const card = new St.BoxLayout({
            ...VERTICAL,
            style_class: 'isle-notification-expanded',
            x_expand: true,
            reactive: true,
            track_hover: true,
        });

        const header = new St.BoxLayout({
            style_class: 'isle-notification-expanded-header',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const titleText = (notification.title || notification.source?.title || '').trim();
        const titleButton = new St.Button({
            style_class: 'isle-notification-click-area',
            x_expand: true,
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const titleBox = new St.BoxLayout({style_class: 'isle-notification-title-box', y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        titleBox.add_child(notificationBadge(notificationIcon(notification)));
        const title = label(titleText, 'isle-notification-title', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        titleBox.add_child(title);
        titleButton.set_child(titleBox);
        titleButton.connect('clicked', () => {
            notification.activate();
            this.emit('request-close');
        });
        header.add_child(titleButton);

        const time = label(Format.ago(notification.datetime), 'isle-notification-time', {x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.CENTER});
        this._times.push([time, notification.datetime]);
        header.add_child(time);

        if (!notification.resident) {
            const dismiss = iconButton('isle-close-symbolic', 'isle-button-flat isle-notification-dismiss',
                () => notification.destroy(), {size: 10, accessibleName: 'Dismiss'});
            dismiss.y_align = Clutter.ActorAlign.CENTER;
            header.add_child(dismiss);
        }

        const collapseBtn = iconButton('isle-chevron-up-symbolic', 'isle-button-flat isle-notification-expand',
            () => onCollapse(), {size: 12, accessibleName: 'Collapse notification'});
        collapseBtn.y_align = Clutter.ActorAlign.CENTER;
        header.add_child(collapseBtn);

        card.add_child(header);

        // Entire message content with line breaks preserved, full wrapping, and NO ellipsis
        const rawBody = this._sharing ? '' : plainBody(notification).trim();
        if (rawBody.length > 0) {
            const bodyBox = new St.Button({
                style_class: 'isle-notification-expanded-body-box',
                x_expand: true,
                can_focus: true,
            });
            const bodyLabel = label(rawBody, 'isle-notification-expanded-body', {x_expand: true});
            wrapLines(bodyLabel, Pango.EllipsizeMode.NONE);
            bodyBox.set_child(bodyLabel);
            bodyBox.connect('clicked', () => onCollapse());
            card.add_child(bodyBox);
        }

        const actions = this._sharing ? [] : (notification.actions ?? []).slice(0, MAX_ACTIONS);
        if (actions.length > 0) {
            const actionsBox = new St.BoxLayout({style_class: 'isle-notification-expanded-actions', x_expand: true});
            for (const action of actions) {
                actionsBox.add_child(pillButton(action.label, 'isle-pill-small isle-notification-action', () => {
                    action.activate();
                    this.emit('request-close');
                }));
            }
            card.add_child(actionsBox);
        }

        return card;
    }

    warmUp() {
        if (this._stale)
            this._update();
    }

    /** While the screen is shared or recorded, the cards leave out what the notifications say. */
    set sharing(sharing) {
        if (sharing === Boolean(this._sharing))
            return;
        this._sharing = sharing;
        if (this.active)
            this._update();
        else
            this._stale = true;
        this.markCold();
    }

    onActivate() {
        this._center.acknowledgeAll();
        // Rebuilt only if something came or went while it was closed; else just the times move on.
        if (this._stale) {
            this._update();
        } else {
            this._times = this._times.filter(([time]) => {
                try {
                    return !time.is_finalized?.() && Boolean(time.get_parent?.());
                } catch {
                    return false;
                }
            });
            this._times.forEach(([time, datetime]) => {
                try {
                    time.text = Format.ago(datetime);
                } catch {
                    // Ignore destroyed actors
                }
            });
        }
    }

    _onDestroy() {
        this._centerHandlers.forEach(id => this._center.disconnect(id));
        this._times = [];
        this._expanded.clear();
    }
});
