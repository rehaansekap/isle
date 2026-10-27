// SPDX-License-Identifier: GPL-3.0-or-later

// Preferences: island look and behaviour (GSettings), clipboard history, and
// focus timer durations (stored by isled, edited over D-Bus).

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {DesktopAppInfo} from './src/appInfo.js';
import {Bot, COLORS, SHAPES, paletteFor} from './src/bot.js';
import {paintRim} from './src/glow.js';

const DAEMON = 'io.github.zickrian.isle.Daemon';
const DAEMON_PATH = '/io/github/zickrian/isle/Daemon';
const POMODORO_INTERFACE = 'io.github.zickrian.isle.Pomodoro1';
const CLIPBOARD_INTERFACE = 'io.github.zickrian.isle.Clipboard1';
const AGENTS_INTERFACE = 'io.github.zickrian.isle.Agents1';
const ASSISTANT_INTERFACE = 'io.github.zickrian.isle.Assistant1';
/** Edits to the timer are sent once typing pauses for this long. */
const SAVE_DELAY_MS = 400;

export default class IslePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(560, 680);
        window.add(this._islandPage(settings));
        window.add(this._clipboardPage(settings, window));
        window.add(this._timerPage(settings, window));
        window.add(this._voicePage(settings));
        window.add(this._usagePage(settings));
        window.add(this._aboutPage(settings, window));
    }

    // The version, where to get help, a bug report to paste, and a way back to the defaults.
    _aboutPage(settings, window) {
        const page = new Adw.PreferencesPage({title: 'About', icon_name: 'help-about-symbolic'});
        const about = new Adw.PreferencesGroup({title: `Isle ${this.metadata['version-name'] ?? ''}`.trim(),
            description: 'A notch-style island for GNOME. © 2026 zickrian, free software under the GPL.'});
        const link = (title, subtitle, url) => {
            const row = new Adw.ActionRow({title, subtitle, activatable: true});
            row.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
            row.connect('activated', () => new Gtk.UriLauncher({uri: url}).launch(window, null, null));
            return row;
        };
        // Whether a newer Isle is out, as isled last found, and the switch for asking.
        for (const row of updateRows(settings, window, this.metadata['version-name'] ?? '', this.path.startsWith('/usr/')))
            about.add(row);
        about.add(link('Website', 'Features, installing and updating', 'https://github.com/zickrian/isle'));
        about.add(link('Report a problem', 'On GitHub; paste the report below in it', 'https://github.com/zickrian/isle/issues/new/choose'));
        const report = new Adw.ActionRow({title: 'Copy a bug report', subtitle: 'Versions, a check of what works, and recent logs (isled --report)',
            activatable: true});
        report.add_suffix(new Gtk.Image({icon_name: 'edit-copy-symbolic'}));
        report.connect('activated', () => copyReport(window, report));
        about.add(report);
        page.add(about);

        const reset = new Adw.PreferencesGroup({title: 'Settings'});
        const resetRow = new Adw.ActionRow({title: 'Reset all settings', subtitle: 'Back to how Isle came; your data stays',
            activatable: true});
        resetRow.connect('activated', () => confirm(window, {
            heading: 'Reset all of Isle’s settings?',
            body: 'Every option goes back to its default. Your tasks, events, clipboard history and files stay.',
            action: 'Reset',
        }, () => {
            // Not Isle's state: which update was announced, and a focus session's Do Not Disturb.
            const state = ['update-shown', 'focus-dnd-owned'];
            for (const key of settings.settings_schema.list_keys().filter(key => !state.includes(key)))
                settings.reset(key);
        }));
        reset.add(resetRow);
        page.add(reset);
        return page;
    }

    // AI plan usage: only the providers signed in on this computer are listed.
    _usagePage(settings) {
        const page = new Adw.PreferencesPage({title: 'AI Usage', icon_name: 'power-profile-performance-symbolic'});
        const found = usageProviders();
        const group = new Adw.PreferencesGroup({
            title: 'AI Usage',
            description: found.length
                ? 'How much of your plans\' limits is used, on a Usage page in the open island, with a warning ' +
                  'as one nears its end. Found from the apps you are signed in to; nothing else to set up.'
                : 'Sign in to Claude Code (claude) or Codex (codex) and your plan shows up here.',
        });
        const enabled = switchRow(settings, 'usage-enabled', 'Show AI usage', 'The Usage page and its warnings');
        group.add(enabled);
        const rows = found.map(({key, title, subtitle}) => switchRow(settings, key, title, subtitle));
        const warn = spinRow(settings, 'usage-warn', 'Warn at', 'Share of a limit, in %', 50, 99);
        const critical = spinRow(settings, 'usage-critical', 'Warn again at', 'Share of a limit, in %', 50, 100);
        // The second warning never comes before the first.
        settings.connect('changed::usage-warn', () => {
            if (settings.get_int('usage-critical') < settings.get_int('usage-warn'))
                settings.set_int('usage-critical', settings.get_int('usage-warn'));
        });
        settings.connect('changed::usage-critical', () => {
            if (settings.get_int('usage-critical') < settings.get_int('usage-warn'))
                settings.set_int('usage-warn', settings.get_int('usage-critical'));
        });
        for (const row of found.length ? [...rows, warn, critical] : []) {
            settings.bind('usage-enabled', row, 'sensitive', Gio.SettingsBindFlags.GET);
            group.add(row);
        }
        enabled.sensitive = found.length > 0;
        page.add(group);

        // Only the AIs found on this computer; none, and the group is not there at all.
        const agents = agentsFound();
        if (agents.length) {
            const agentGroup = new Adw.PreferencesGroup({
                title: 'AI Agents',
                description: 'Answer your coding agents from the island when they ask, and know when they are done. ' +
                    'On by default; off removes Isle\'s hook from that agent\'s settings.',
            });
            for (const {provider, title, subtitle} of agents) {
                agentGroup.add(switchRow(settings, `agent-alerts-${provider}`, title, subtitle));
            }
            page.add(agentGroup);
        }
        return page;
    }

    _voicePage(settings) {
        const page = new Adw.PreferencesPage({title: 'Assistant', icon_name: 'audio-input-microphone-symbolic'});
        const installed = AI_PROVIDERS.filter(provider => findProgram(provider.command));
        const group = new Adw.PreferencesGroup({
            title: 'Voice Assistant',
            description: 'Press the shortcut (or the mic in the open island) and speak. Speech is recognised on this ' +
                'computer (set up once with isle-setup-voice in a terminal); the request goes to the AI you pick, with your ' +
                'own sign-in and plan.',
        });
        page.add(lookGroup(settings));
        group.add(switchRow(settings, 'voice-assistant', 'Voice assistant', 'The shortcut and the mic in the open island'));
        group.add(shortcutRow(settings, 'voice-shortcut', 'Shortcut', 'Opens the assistant and listens'));

        // Only the AIs installed here are offered; with none, the assistant says how to get one.
        const provider = choiceRow(settings, 'voice-provider', 'AI', installed.length
            ? 'Answers with your own sign-in; Isle runs its actions'
            : 'Install Claude Code, Codex or Antigravity (agy), and sign in', [
            ['auto', installed.length === 1 ? `Automatic (${installed[0].name})`
                : installed.length ? 'Automatic (the one you are signed in to)' : 'None installed'],
            ...installed.map(({id, name}) => [id, name]),
        ]);
        const model = new Adw.ComboRow({title: 'Model'});
        let modelChoices = [];
        let modelKey = null;
        // Swapping the list moves the selection; that must not write a model of its own.
        let syncing = false;
        const syncModel = () => {
            syncing = true;
            try {
                fillModel();
            } finally {
                syncing = false;
            }
        };
        // Automatic is the first signed in, else the first installed: as isled picks (brain.rs `pick`).
        const automatic = installed.find(p => signedIn(p.id)) ?? installed[0];
        const fillModel = () => {
            const wanted = settings.get_string('voice-provider');
            const current = installed.find(p => p.id === wanted) ?? automatic;
            model.visible = Boolean(current);
            if (!current)
                return;
            modelKey = current.modelKey;
            modelChoices = current.models();
            // A model set by hand, not in the list, stays shown and kept.
            const value = settings.get_string(modelKey);
            if (!modelChoices.some(([id]) => id === value))
                modelChoices.push([value, value || 'Default']);
            model.subtitle = current.about;
            model.model = Gtk.StringList.new(modelChoices.map(([, label]) => label));
            model.selected = Math.max(0, modelChoices.findIndex(([id]) => id === value));
        };
        model.connect('notify::selected', () => {
            if (syncing)
                return;
            const value = modelChoices[model.selected]?.[0];
            if (modelKey && value !== undefined && value !== settings.get_string(modelKey))
                settings.set_string(modelKey, value);
        });
        const changed = settings.connect('changed::voice-provider', syncModel);
        model.connect('destroy', () => settings.disconnect(changed));
        syncModel();

        const options = [provider, model];
        options.push(choiceRow(settings, 'voice-speech-model', 'Speech recognition', 'Bigger is more accurate, and slower; downloaded once', [
            ['tiny', 'Tiny (44 MB)'],
            ['base', 'Base (82 MB)'],
            ['small', 'Small (265 MB)'],
            ['medium', 'Medium (823 MB)'],
        ]));
        options.push(choiceRow(settings, 'voice-language', 'Language', 'The language you speak', [
            ['', 'Any (detected)'],
            ['id,en', 'Indonesian or English'],
            ['id', 'Indonesian'],
            ['en', 'English'],
        ]));
        options.push(choiceRow(settings, 'voice-keep-chat', 'Keep the conversation', 'Never more than a day; then it is deleted, with the AI\'s copy', [
            ['day', 'Until midnight'],
            ['idle-2h', '2 hours without a word'],
            ['idle-30m', '30 minutes without a word'],
        ]));
        const clearChat = new Adw.ActionRow({title: 'Clear the conversation now', subtitle: 'Deletes it here and the AI\'s copy of it',
            activatable: true});
        clearChat.add_suffix(new Gtk.Image({icon_name: 'user-trash-symbolic'}));
        clearChat.connect('activated', () => confirm(clearChat.get_root(), {
            heading: 'Clear the conversation?',
            body: 'The assistant starts afresh; what was said is deleted here and from the AI\'s own history on this computer.',
            action: 'Clear',
        }, () => Gio.DBus.session.call(DAEMON, DAEMON_PATH, ASSISTANT_INTERFACE, 'ClearChat', null, null,
            Gio.DBusCallFlags.NONE, -1, null, null)));
        options.push(clearChat);
        options.push(switchRow(settings, 'voice-use-selection', 'Use selected text',
            'Send the text you have selected, so the AI can work on it; never from terminals or password managers'));
        options.push(switchRow(settings, 'voice-read-notifications', 'Read notifications',
            'Let the AI read your recent notifications when you ask about them'));
        for (const row of options) {
            settings.bind('voice-assistant', row, 'sensitive', Gio.SettingsBindFlags.GET);
            group.add(row);
        }
        page.add(group);

        const notes = new Adw.PreferencesGroup({
            title: 'About the AIs',
            description: 'Claude Code and Codex answer within your Claude or ChatGPT plan\'s limits. Antigravity\'s ' +
                'terms bar third-party tools from its service; Isle only runs the official agy app, but use it at ' +
                'your own risk. Each runs kept to answering: commands and file changes go through Isle, which ' +
                'asks you first.',
        });
        page.add(notes);
        return page;
    }

    _clipboardPage(settings, window) {
        const page = new Adw.PreferencesPage({title: 'Clipboard', icon_name: 'edit-paste-symbolic'});

        const history = new Adw.PreferencesGroup({
            title: 'Clipboard History',
            description: 'Super+V opens it. Everything stays on this computer.',
        });
        history.add(switchRow(settings, 'clipboard-history', 'Keep clipboard history',
            'Text, links, images and files you copy. Passwords from password managers are never kept.'));
        const clear = new Adw.ActionRow({title: 'Clear history', subtitle: 'Pinned items are kept'});
        const clearButton = new Gtk.Button({label: 'Clear…', valign: Gtk.Align.CENTER});
        clearButton.connect('clicked', () => confirmClear(window));
        clear.add_suffix(clearButton);
        history.add(clear);
        page.add(history);

        const ignored = new Adw.PreferencesGroup({
            title: 'Never Keep Copies From',
            description: 'Known password managers are on the list from the start.',
        });
        page.add(ignored);
        fillIgnoredApps(ignored, settings);
        return page;
    }

    _islandPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Island', icon_name: 'preferences-desktop-appearance-symbolic'});

        const look = new Adw.PreferencesGroup({title: 'Appearance'});
        look.add(choiceRow(settings, 'top-bar-style', 'Top bar', 'Glass shows the island as a notch, like on a Mac', [
            ['glass', 'Glass'],
            ['black', 'Black'],
        ]));
        const glassPillsRow = switchRow(settings, 'glass-pills', 'Pill style on glass top bar',
            'Enclose workspace, tray apps, and system icons in solid black pills when top bar is glass');
        look.add(glassPillsRow);
        const syncGlassPillsSensitivity = () => {
            glassPillsRow.sensitive = settings.get_string('top-bar-style') === 'glass';
        };
        syncGlassPillsSensitivity();
        settings.connect('changed::top-bar-style', syncGlassPillsSensitivity);
        look.add(switchRow(settings, 'compact-top-bar', 'Compact top bar', 'A slimmer top bar that frames the island like a bezel'));
        look.add(switchRow(settings, 'island-in-top-bar', 'Island inside the top bar',
            'Like a notch: the closed island never covers windows'));
        const depth = spinRow(settings, 'notch-depth', 'Island height', 'How far the closed island hangs below the top bar, in pixels', 24, 40);
        settings.bind('island-in-top-bar', depth, 'sensitive', Gio.SettingsBindFlags.GET | Gio.SettingsBindFlags.INVERT_BOOLEAN);
        look.add(depth);
        const maxOpenHeight = spinRow(settings, 'expanded-max-height', 'Open island max height',
            'Maximum height of the open island, in pixels. Content hugs naturally below this; taller content scrolls', 180, 600);
        look.add(maxOpenHeight);
        const dimRow = switchRow(settings, 'dim-when-top-bar-hidden', 'Dim when top bar is hidden',
            'Reduce opacity and pass clicks through to windows underneath when the top bar is hidden (e.g. by Hide Top Bar)');
        look.add(dimRow);
        const opacityRow = spinRow(settings, 'dimmed-opacity', 'Dimmed opacity (%)',
            'Opacity percentage while the top bar is hidden (alerts still show at 100%)', 10, 90);
        settings.bind('dim-when-top-bar-hidden', opacityRow, 'sensitive', Gio.SettingsBindFlags.GET);
        look.add(opacityRow);
        look.add(choiceRow(settings, 'island-monitor', 'Display', 'With more than one display, where the island is', [
            ['primary', 'Main display'],
            ['active', 'Display in use'],
        ]));
        look.add(choiceRow(settings, 'open-on', 'Open', 'How the closed island opens', [
            ['hover', 'On hover'],
            ['click', 'On click'],
        ]));
        const delay = Adw.SpinRow.new_with_range(60, 1000, 20);
        delay.title = 'Rest before opening';
        delay.subtitle = 'In milliseconds';
        settings.bind('hover-delay', delay, 'value', Gio.SettingsBindFlags.DEFAULT);
        const byHover = () => (delay.sensitive = settings.get_string('open-on') === 'hover');
        settings.connect('changed::open-on', byHover);
        byHover();
        look.add(delay);

        const notifDelay = Adw.SpinRow.new_with_range(200, 3000, 50);
        notifDelay.title = 'Notification hover before opening';
        notifDelay.subtitle = 'In milliseconds. Click before this opens app; hover for this duration opens island';
        settings.bind('notification-hover-delay', notifDelay, 'value', Gio.SettingsBindFlags.DEFAULT);
        const byHoverNotif = () => (notifDelay.sensitive = settings.get_string('open-on') === 'hover');
        settings.connect('changed::open-on', byHoverNotif);
        byHoverNotif();
        look.add(notifDelay);
        page.add(look);

        const alerts = new Adw.PreferencesGroup({title: 'Alerts'});
        alerts.add(switchRow(settings, 'replace-osd', 'Volume and brightness', 'Show them in the island instead of the centre of the screen'));
        alerts.add(switchRow(settings, 'alert-power', 'Charging and battery', 'Plugged in, unplugged, full and low'));
        alerts.add(switchRow(settings, 'alert-network', 'Network', 'When the connection drops'));
        alerts.add(switchRow(settings, 'alert-bluetooth', 'Bluetooth', 'Devices connecting, with their battery'));
        alerts.add(switchRow(settings, 'alert-caps-lock', 'Caps Lock', 'When it turns on or off'));
        alerts.add(switchRow(settings, 'event-alerts', 'Calendar events',
            'Before each event with a time, with Join for a Meet, Zoom or Teams link'));
        const eventMinutes = spinRow(settings, 'event-alert-minutes', 'Minutes before an event', null, 1, 60);
        settings.bind('event-alerts', eventMinutes, 'sensitive', Gio.SettingsBindFlags.GET);
        alerts.add(eventMinutes);
        alerts.add(switchRow(settings, 'gnome-banners', 'GNOME’s notification banners',
            'Show notifications as GNOME does instead of in the island'));
        alerts.add(choiceRow(settings, 'super-v', 'Super+V', 'GNOME’s calendar shortcut', [
            ['isle', 'Isle’s clipboard history'],
            ['gnome', 'GNOME’s calendar and notifications'],
        ]));
        alerts.add(switchRow(settings, 'privacy-indicators', 'Privacy indicators', 'Dots when the camera, microphone or screen sharing is in use'));
        alerts.add(switchRow(settings, 'track-peek', 'New song', 'Briefly show the song when the track changes'));
        alerts.add(switchRow(settings, 'lyrics-online', 'Lyrics', 'Look up the playing song’s lyrics online'));
        const lyricsProvider = choiceRow(settings, 'lyrics-provider', 'Lyrics Provider',
            'Source for synchronized lyrics lookup', [
                ['auto', 'Lyrics Plus (NetEase + LRCLIB Fallback)'],
                ['netease', 'NetEase Cloud Music (Spicetify)'],
                ['lrclib', 'LRCLIB'],
            ]);
        settings.bind('lyrics-online', lyricsProvider, 'sensitive', Gio.SettingsBindFlags.GET);
        alerts.add(lyricsProvider);
        alerts.add(switchRow(settings, 'chimes', 'Sounds', 'Chime when a focus session or break ends, and for reminders'));
        page.add(alerts);

        const calls = new Adw.PreferencesGroup({
            title: 'Calls',
            description: 'WhatsApp, Telegram, Meet and other calls, in any app or browser.',
        });
        calls.add(switchRow(settings, 'call-activity', 'Calls in the island', 'The call’s length, mute and a way back to it'));
        const preview = switchRow(settings, 'call-preview', 'Live preview',
            'See yourself and whoever you call, live in the open island');
        settings.bind('call-activity', preview, 'sensitive', Gio.SettingsBindFlags.GET);
        calls.add(preview);
        page.add(calls);
        return page;
    }

    _timerPage(settings, window) {
        const page = new Adw.PreferencesPage({title: 'Focus Timer', icon_name: 'alarm-symbolic'});
        const focus = new Adw.PreferencesGroup({title: 'While Focusing'});
        focus.add(switchRow(settings, 'focus-dnd', 'Do Not Disturb', 'Silence notifications during focus sessions, and restore them afterwards'));
        page.add(focus);

        const group = new Adw.PreferencesGroup({
            title: 'Pomodoro',
            description: 'Focus sessions with short breaks, and a long break after a few sessions.',
        });
        page.add(group);

        let proxy = null;
        let config = null;
        try {
            proxy = Gio.DBusProxy.new_for_bus_sync(Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE,
                null, DAEMON, DAEMON_PATH, POMODORO_INTERFACE, null);
            config = JSON.parse(proxy.get_cached_property('Config')?.unpack() ?? 'null');
        } catch (e) {
            console.warn(`Isle: could not read the timer settings: ${e.message}`);
        }
        if (!config) {
            group.add(new Adw.ActionRow({
                title: 'Isle’s background service is not running',
                subtitle: 'Run the installer again, or start it with “systemctl --user start isled”.',
            }));
            return page;
        }

        let saveId = 0;
        const save = () => {
            if (saveId)
                GLib.source_remove(saveId);
            saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVE_DELAY_MS, () => {
                saveId = 0;
                proxy.call('SetConfig', new GLib.Variant('(s)', [JSON.stringify(config)]),
                    Gio.DBusCallFlags.NONE, -1, null, null);
                return GLib.SOURCE_REMOVE;
            });
        };
        // Don't lose the last change when the window closes before it is saved.
        window.connect('close-request', () => {
            if (!saveId)
                return false;
            GLib.source_remove(saveId);
            saveId = 0;
            try {
                proxy.call_sync('SetConfig', new GLib.Variant('(s)', [JSON.stringify(config)]),
                    Gio.DBusCallFlags.NONE, -1, null);
            } catch (e) {
                console.warn(`Isle: could not save the timer settings: ${e.message}`);
            }
            return false;
        });
        const number = (key, title, min, max) => {
            const row = Adw.SpinRow.new_with_range(min, max, 1);
            row.title = title;
            row.value = config[key];
            row.connect('notify::value', () => {
                config[key] = row.value;
                save();
            });
            return row;
        };
        const toggle = (key, title, subtitle) => {
            const row = new Adw.SwitchRow({title, subtitle, active: config[key]});
            row.connect('notify::active', () => {
                config[key] = row.active;
                save();
            });
            return row;
        };

        group.add(number('focus_minutes', 'Focus (minutes)', 1, 180));
        group.add(number('short_break_minutes', 'Short break (minutes)', 1, 60));
        group.add(number('long_break_minutes', 'Long break (minutes)', 1, 120));
        group.add(number('sessions_before_long_break', 'Sessions before a long break', 1, 12));
        group.add(toggle('auto_start_breaks', 'Start breaks automatically', null));
        group.add(toggle('auto_start_focus', 'Start focus automatically', 'After a break ends'));
        return page;
    }
}

/** The assistant's shape and colours as Settings has them (see bot.js). */
function lookOf(settings) {
    return {shape: settings.get_string('bot-shape'),
        palette: paletteFor(settings.get_string('bot-color'), settings.get_string('bot-glow'))};
}

const hexOf = rgba => `#${[rgba.red, rgba.green, rgba.blue].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;

/** A still copy of the assistant `size` px big, redrawn by `update(look)`. */
function botTile(size, look) {
    const area = new Gtk.DrawingArea({content_width: size, content_height: size});
    let bot = null;
    const update = next => {
        bot = new Bot(next);
        bot.holdEyes();
        for (let t = 1 / 30; t <= 0.7; t += 1 / 30)
            bot.step(t, {x: 0.12, y: 0.06});
        area.queue_draw();
    };
    area.set_draw_func((_area, cr) => bot.paint(cr, size));
    update(look);
    return {area, update};
}

// A row of picks (`choices`: [[value, child]…]) as toggles in a flowing grid, `key`'s value pressed.
function pickerRow(settings, key, title, choices, {custom = null, perLine = 8, least = 4} = {}) {
    const row = new Adw.PreferencesRow({activatable: false});
    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 8, margin_top: 12, margin_bottom: 12,
        margin_start: 12, margin_end: 12});
    box.append(new Gtk.Label({label: title, xalign: 0, css_classes: ['heading']}));
    // Up to `perLine` on a line, fewer in a narrow window: never wider than the window.
    const flow = new Gtk.FlowBox({selection_mode: Gtk.SelectionMode.NONE, homogeneous: true, max_children_per_line: perLine,
        min_children_per_line: least, column_spacing: 2, row_spacing: 2});
    const buttons = [];
    let syncing = false;
    for (const [value, child, tooltip] of choices) {
        const button = new Gtk.ToggleButton({child, css_classes: ['flat'], tooltip_text: tooltip, halign: Gtk.Align.CENTER,
            group: buttons[0] ?? null});
        button.connect('toggled', () => {
            if (!syncing && button.active && settings.get_string(key) !== value)
                settings.set_string(key, value);
        });
        buttons.push(button);
        flow.append(button);
    }
    if (custom)
        flow.append(custom);
    const sync = () => {
        syncing = true;
        const index = choices.findIndex(([value]) => value === settings.get_string(key));
        if (index >= 0)
            buttons[index].active = true;
        else
            buttons.forEach(button => (button.active = false));
        syncing = false;
    };
    const changed = settings.connect(`changed::${key}`, sync);
    row.connect('destroy', () => settings.disconnect(changed));
    sync();
    box.append(flow);
    row.set_child(box);
    return row;
}

// The assistant's look: a live preview of it in the island's pill (listening, thinking, glad), its shape,
// its colour and the light it brings to the island.
function lookGroup(settings) {
    const group = new Adw.PreferencesGroup({title: 'Look', description: 'How the assistant looks, and the light it brings to the island.'});
    const bot = new Bot(lookOf(settings));
    const cache = {};
    const motion = {time: 0, level: 0};
    const preview = new Gtk.DrawingArea({content_height: 128, hexpand: true});
    preview.set_draw_func((area, cr, width, height) => {
        const w = Math.min(380, width - 32), h = 72, x = Math.round((width - w) / 2), y = Math.round((height - h) / 2);
        cr.translate(x, y);
        const r = 26;
        cr.moveTo(0, 0);
        cr.lineTo(w, 0);
        cr.arc(w - r, h - r, r, 0, Math.PI / 2);
        cr.arc(r, h - r, r, Math.PI / 2, Math.PI);
        cr.closePath();
        cr.setSourceRGBA(0, 0, 0, 1);
        cr.fillPreserve();
        cr.save();
        cr.clip();
        paintRim(cr, {left: 0, right: w, top: 0, radius: r}, h, bot.palette.glow, motion, 1, cache);
        cr.restore();
        cr.save();
        cr.translate(16, (h - 40) / 2 - 3);
        bot.paint(cr, 40);
        cr.restore();
        const layout = PangoCairo.create_layout(cr);
        layout.set_font_description(Pango.FontDescription.from_string('Sans 600 11'));
        layout.set_text(motion.caption, -1);
        const [, extents] = layout.get_pixel_extents();
        cr.moveTo(68, (h - extents.height) / 2 - 3);
        cr.setSourceRGBA(1, 1, 1, motion.dim ? 0.6 : 0.95);
        PangoCairo.show_layout(cr, layout);
    });
    // A little play, over and over: it listens to you speak, thinks, then is glad it got it done.
    let start = null;
    let form = null;
    preview.add_tick_callback((area, clock) => {
        const now = clock.get_frame_time() / 1e6;
        start ??= now;
        const t = now - start, at = t % 10;
        const [next, caption, dim] = at < 4.5 ? ['listening', 'Listening…', true] : at < 7 ? ['thinking', 'Searching the web…', true]
            : ['success', 'LibreOffice is installed.', false];
        if (next !== form) {
            form = next;
            bot.setForm(form);
        }
        const speaking = at > 0.8 && at < 3.6 ? Math.max(0, Math.sin(at * 9) * 0.5 + Math.sin(at * 3.7) * 0.4) : 0;
        motion.level = form === 'listening' ? speaking : form === 'thinking' ? 0.34 + 0.08 * Math.sin(t * 1.8) : 0.15;
        motion.time = t * (form === 'thinking' ? 1.6 : 1);
        motion.caption = caption;
        motion.dim = dim;
        bot.step(t, null, form === 'listening' ? speaking : 0);
        area.queue_draw();
        return GLib.SOURCE_CONTINUE;
    });
    group.add(new Adw.PreferencesRow({child: preview, activatable: false}));

    const tiles = [];
    const shapes = pickerRow(settings, 'bot-shape', 'Shape', Object.entries(SHAPES).map(([shape, {label}]) => {
        const tile = botTile(34, {...lookOf(settings), shape});
        tiles.push([shape, tile]);
        return [shape, tile.area, label];
    }), {perLine: 4, least: 4});
    group.add(shapes);

    // A colour of your own: the picker's own button, showing the colour once there is one.
    const customTile = botTile(26, {shape: 'circle', palette: paletteFor(settings.get_string('bot-color'))});
    const customIcon = new Gtk.Image({icon_name: 'color-select-symbolic', pixel_size: 18});
    const customColor = new Gtk.ToggleButton({css_classes: ['flat'], tooltip_text: 'A colour of your own', halign: Gtk.Align.CENTER});
    const syncCustom = () => {
        const color = settings.get_string('bot-color');
        const own = color.startsWith('#');
        if (own)
            customTile.update({shape: 'circle', palette: paletteFor(color)});
        customColor.child = own ? customTile.area : customIcon;
        customColor.active = own;
    };
    customColor.connect('clicked', () => {
        syncCustom();
        const initial = new Gdk.RGBA();
        initial.parse(settings.get_string('bot-color').startsWith('#') ? settings.get_string('bot-color') : '#8e7dff');
        new Gtk.ColorDialog({title: 'Assistant colour', with_alpha: false}).choose_rgba(customColor.get_root(), initial, null,
            (dialog, result) => {
                try {
                    settings.set_string('bot-color', hexOf(dialog.choose_rgba_finish(result)));
                } catch {
                    // Cancelled: as it was.
                }
            });
    });
    const colors = pickerRow(settings, 'bot-color', 'Colour', Object.entries(COLORS).map(([color, {label}]) =>
        [color, botTile(26, {shape: 'circle', palette: paletteFor(color)}).area, label]), {custom: customColor, perLine: 6, least: 6});
    syncCustom();
    group.add(colors);

    const glow = new Adw.ComboRow({title: 'Glow', subtitle: 'The light along the island\'s edge',
        model: Gtk.StringList.new(['Match', 'Classic', 'Custom'])});
    const glowColor = new Gtk.ColorDialogButton({dialog: new Gtk.ColorDialog({title: 'Glow colour', with_alpha: false}),
        valign: Gtk.Align.CENTER});
    glow.add_suffix(glowColor);
    let syncingGlow = false;
    const syncGlow = () => {
        syncingGlow = true;
        const value = settings.get_string('bot-glow');
        glow.selected = value === 'match' ? 0 : value === 'classic' ? 1 : 2;
        glowColor.visible = glow.selected === 2;
        if (value.startsWith('#')) {
            const rgba = new Gdk.RGBA();
            rgba.parse(value);
            glowColor.rgba = rgba;
        }
        syncingGlow = false;
    };
    glow.connect('notify::selected', () => {
        if (syncingGlow)
            return;
        settings.set_string('bot-glow', ['match', 'classic', hexOf(glowColor.rgba)][glow.selected]);
    });
    glowColor.connect('notify::rgba', () => {
        if (!syncingGlow && glow.selected === 2)
            settings.set_string('bot-glow', hexOf(glowColor.rgba));
    });
    group.add(glow);

    // Each change shows at once: the preview morphs, the tiles take the new colour.
    const changed = ['bot-shape', 'bot-color', 'bot-glow'].map(key => settings.connect(`changed::${key}`, () => {
        const look = lookOf(settings);
        bot.palette = look.palette;
        bot.setShape(look.shape);
        for (const [shape, tile] of tiles)
            tile.update({...look, shape});
        syncCustom();
        syncGlow();
    }));
    group.connect('destroy', () => changed.forEach(id => settings.disconnect(id)));
    syncGlow();
    return group;
}

/** The AI agents isled found installed: `{provider, title, subtitle}` each. */
function agentsFound() {
    let agents = {};
    try {
        const proxy = Gio.DBusProxy.new_for_bus_sync(Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE,
            null, DAEMON, DAEMON_PATH, AGENTS_INTERFACE, null);
        agents = JSON.parse(proxy.get_cached_property('Agents')?.unpack() ?? '{}');
    } catch (e) {
        console.warn(`Isle: could not ask which AI agents are installed: ${e.message}`);
    }
    return [
        {provider: 'claude', title: 'Claude Code', subtitle: 'Allow, deny or always allow, and when it is done'},
        {provider: 'codex', title: 'Codex', subtitle: 'Allow or deny, and when it is done · trust the hook once in /hooks'},
    ].filter(({provider}) => agents[provider]?.found);
}

function switchRow(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

/** The AI CLIs the voice assistant can ask, in the order "Automatic" tries them, signed-in ones first (as isled does). */
const AI_PROVIDERS = [
    {
        id: 'claude', name: 'Claude Code', command: 'claude', modelKey: 'voice-claude-model',
        about: 'What Claude answers with',
        models: () => [
            ['haiku', 'Haiku (fastest, less reliable)'],
            ['sonnet', 'Sonnet'],
            ['opus', 'Opus (smartest, slower)'],
            ['', 'Claude Code\'s default'],
        ],
    },
    {
        id: 'codex', name: 'Codex', command: 'codex', modelKey: 'voice-codex-model',
        about: 'What Codex answers with, with little reasoning, to be quick',
        models: () => [['', 'Codex\'s default'], ...codexModels()],
    },
    {
        id: 'agy', name: 'Antigravity', command: 'agy', modelKey: 'voice-agy-model',
        about: 'What agy answers with',
        models: () => [
            ['gemini-3.8-flash-low', 'Gemini Flash (fastest)'],
            ['gemini-3.8-flash-medium', 'Gemini Flash (medium)'],
            ['gemini-3.8-flash-high', 'Gemini Flash (high)'],
            ['claude-sonnet-4-6', 'Claude Sonnet'],
        ],
    },
];

/** Where Claude Code keeps its settings and sign-in: `$CLAUDE_CONFIG_DIR`, else ~/.claude. */
function claudeConfigDir() {
    return GLib.getenv('CLAUDE_CONFIG_DIR') || GLib.build_filenamev([GLib.get_home_dir(), '.claude']);
}

/** The user's own Codex home: `$CODEX_HOME`, else ~/.codex. */
function codexHome() {
    return GLib.getenv('CODEX_HOME') || GLib.build_filenamev([GLib.get_home_dir(), '.codex']);
}

/** Whether AI `id` has a sign-in, checked as isled does (brain.rs `signed_in`). */
function signedIn(id) {
    const exists = (...parts) => GLib.file_test(GLib.build_filenamev(parts), GLib.FileTest.EXISTS);
    const env = name => Boolean(GLib.getenv(name));
    switch (id) {
    case 'claude': {
        if (exists(claudeConfigDir(), '.credentials.json') ||
            ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'].some(env))
            return true;
        // An API key or a cloud set in its settings.json.
        try {
            const [, bytes] = GLib.file_get_contents(GLib.build_filenamev([claudeConfigDir(), 'settings.json']));
            const json = JSON.parse(new TextDecoder().decode(bytes));
            const kept = JSON.stringify(['env', 'apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'forceLoginMethod']
                .filter(key => key in json).map(key => [key, json[key]]));
            return ['apiKeyHelper', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_'].some(key => kept.includes(key));
        } catch {
            return false;
        }
    }
    case 'codex':
        return exists(codexHome(), 'auth.json') || env('OPENAI_API_KEY');
    case 'agy':
        return exists(GLib.get_home_dir(), '.gemini/antigravity-cli/antigravity-oauth-token');
    default:
        return false;
    }
}

/** `command` on the PATH or where installers and Node version managers put it, as isled looks; else null. */
// The same places isled looks in (brain.rs `install_dirs`), for an AI installed with npm, nvm, Homebrew…
function findProgram(command) {
    const home = GLib.get_home_dir();
    const env = (name, fallback) => GLib.getenv(name) || fallback;
    const dirs = [
        GLib.build_filenamev([home, '.local/bin']), GLib.build_filenamev([home, '.npm-global/bin']),
        GLib.build_filenamev([env('BUN_INSTALL', `${home}/.bun`), 'bin']),
        GLib.build_filenamev([env('VOLTA_HOME', `${home}/.volta`), 'bin']),
        env('PNPM_HOME', `${home}/.local/share/pnpm`),
        ...['.local/share/fnm/aliases/default/bin', '.fnm/aliases/default/bin', '.claude/local',
            '.local/share/mise/shims', '.asdf/shims', '.yarn/bin', '.linuxbrew/bin', '.nix-profile/bin']
            .map(dir => GLib.build_filenamev([home, dir])),
        '/home/linuxbrew/.linuxbrew/bin', '/run/current-system/sw/bin',
    ];
    return GLib.find_program_in_path(command) ?? [...dirs, ...nvmBins(home), '/usr/local/bin']
        .map(dir => GLib.build_filenamev([dir, command]))
        .find(path => GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE)) ?? null;
}

/** nvm's Nodes' bin folders, newest first. */
function nvmBins(home) {
    const xdg = GLib.build_filenamev([GLib.get_user_config_dir(), 'nvm']);
    const dir = GLib.getenv('NVM_DIR') ||
        (GLib.file_test(xdg, GLib.FileTest.IS_DIR) ? xdg : GLib.build_filenamev([home, '.nvm']));
    const root = GLib.build_filenamev([dir, 'versions', 'node']);
    const versions = [];
    try {
        const children = Gio.File.new_for_path(root).enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        for (let info = children.next_file(null); info; info = children.next_file(null))
            versions.push(info.get_name());
    } catch {
        return [];
    }
    const parts = name => name.replace(/^v/, '').split('.').map(Number);
    versions.sort((a, b) => {
        const [x, y] = [parts(a), parts(b)];
        const differ = x.findIndex((n, i) => n !== y[i]);
        return differ < 0 ? 0 : (y[differ] ?? 0) - (x[differ] ?? 0);
    });
    return versions.map(name => GLib.build_filenamev([root, name, 'bin']));
}

/** The models Codex lists, from the cache it keeps (Isle's own home for it, else the user's). */
function codexModels() {
    for (const dir of [[GLib.get_user_data_dir(), 'isle', 'codex'], [codexHome()]]) {
        try {
            const [, bytes] = GLib.file_get_contents(GLib.build_filenamev([...dir, 'models_cache.json']));
            const models = JSON.parse(new TextDecoder().decode(bytes)).models ?? [];
            return models.filter(m => m.visibility === 'list').map(m => [m.slug, m.display_name ?? m.slug]);
        } catch {
            // Not there, or not readable: the next place.
        }
    }
    return [];
}

/** The AI providers signed in here, as rows to switch: Claude Code's sign-in, and Codex's (or its logs). */
// Where isled reads them (usage.rs): Claude Code's config dir, the user's Codex home and Isle's own.
function usageProviders() {
    const providers = [];
    try {
        const [, bytes] = GLib.file_get_contents(GLib.build_filenamev([claudeConfigDir(), '.credentials.json']));
        const plan = JSON.parse(new TextDecoder().decode(bytes)).claudeAiOauth?.subscriptionType ?? '';
        providers.push({key: 'usage-claude', title: 'Claude',
            subtitle: `${plan ? `${plan[0].toUpperCase()}${plan.slice(1)} plan, ` : ''}signed in with Claude Code`});
    } catch {
        // Not signed in to Claude Code.
    }
    const signedIn = GLib.file_test(GLib.build_filenamev([codexHome(), 'auth.json']), GLib.FileTest.EXISTS);
    const sessions = [[codexHome(), 'sessions'], [GLib.get_user_data_dir(), 'isle', 'codex', 'sessions']];
    if (signedIn || sessions.some(dir => GLib.file_test(GLib.build_filenamev(dir), GLib.FileTest.IS_DIR)))
        providers.push({key: 'usage-codex', title: 'ChatGPT', subtitle: 'Signed in with Codex'});
    return providers;
}

/** A drop-down for a string key with `choices`: [[value, label], …]. */
function choiceRow(settings, key, title, subtitle, choices) {
    const row = new Adw.ComboRow({
        title,
        subtitle,
        model: Gtk.StringList.new(choices.map(([, label]) => label)),
    });
    const sync = () => {
        const index = choices.findIndex(([value]) => value === settings.get_string(key));
        row.selected = Math.max(0, index);
    };
    sync();
    const changed = settings.connect(`changed::${key}`, sync);
    row.connect('notify::selected', () => {
        const value = choices[row.selected]?.[0];
        if (value !== undefined && value !== settings.get_string(key))
            settings.set_string(key, value);
    });
    row.connect('destroy', () => settings.disconnect(changed));
    return row;
}

function spinRow(settings, key, title, subtitle, min, max) {
    const row = Adw.SpinRow.new_with_range(min, max, 1);
    row.title = title;
    row.subtitle = subtitle;
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

/** A row showing `key`'s shortcut; clicking it records a new one. */
function shortcutRow(settings, key, title, subtitle) {
    const row = new Adw.ActionRow({title, subtitle, activatable: true});
    const shown = new Gtk.ShortcutLabel({disabled_text: 'Off', valign: Gtk.Align.CENTER});
    const sync = () => (shown.accelerator = settings.get_strv(key)[0] ?? '');
    settings.connect(`changed::${key}`, sync);
    sync();
    row.add_suffix(shown);
    row.connect('activated', () => recordShortcut(row.get_root(), accelerator =>
        settings.set_strv(key, accelerator ? [accelerator] : [])));
    return row;
}

/** Waits for a key combination with a modifier, then hands it to `done`; Esc cancels, Backspace clears it. */
function recordShortcut(window, done) {
    const dialog = new Adw.Window({transient_for: window, modal: true, title: 'Shortcut', default_width: 420, default_height: 240});
    dialog.set_content(new Adw.StatusPage({
        title: 'Press the new shortcut',
        description: 'With Super, Ctrl or Alt. Esc cancels; Backspace turns it off.',
        icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic',
    }));
    const keys = new Gtk.EventControllerKey();
    keys.connect('key-pressed', (_keys, keyval, keycode, state) => {
        const modifiers = state & Gtk.accelerator_get_default_mod_mask();
        if (!modifiers && keyval === Gdk.KEY_Escape) {
            dialog.close();
        } else if (!modifiers && keyval === Gdk.KEY_BackSpace) {
            done('');
            dialog.close();
        } else if (modifiers & (Gdk.ModifierType.SUPER_MASK | Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.ALT_MASK) &&
            Gtk.accelerator_valid(keyval, modifiers)) {
            // Shift alone would take a capital letter from every app.
            done(Gtk.accelerator_name_with_keycode(null, keyval, keycode, modifiers));
            dialog.close();
        }
        return Gdk.EVENT_STOP;
    });
    dialog.add_controller(keys);
    dialog.present();
}

/** Asks, then clears everything but pinned items from the clipboard history. */
function confirmClear(window) {
    confirm(window, {
        heading: 'Clear clipboard history?',
        body: 'Everything you copied is removed. Pinned items stay.',
        action: 'Clear',
    }, () => Gio.DBus.session.call(DAEMON, DAEMON_PATH, CLIPBOARD_INTERFACE, 'Clear', null, null,
        Gio.DBusCallFlags.NONE, -1, null, null));
}

/** Asks `heading` (with `body`) and runs `onYes` if the user picks `action`, a destructive one. */
function confirm(window, {heading, body, action}, onYes) {
    // AlertDialog since libadwaita 1.5 (GNOME 46); MessageDialog is its deprecated forerunner.
    const dialog = Adw.AlertDialog ? new Adw.AlertDialog({heading, body})
        : new Adw.MessageDialog({transient_for: window, heading, body});
    dialog.add_response('cancel', 'Cancel');
    dialog.add_response('yes', action);
    dialog.set_response_appearance('yes', Adw.ResponseAppearance.DESTRUCTIVE);
    dialog.connect('response', (_dialog, response) => {
        if (response === 'yes')
            onYes();
    });
    if (Adw.AlertDialog)
        dialog.present(window);
    else
        dialog.present();
}

/** Runs `isled --report` and puts what it says on the clipboard, saying so on `row`. */
/** Where updating is explained, and the command that updates a one-line install. */
const UPDATE_HELP = 'https://github.com/zickrian/isle/blob/main/docs/install.md#updating';
const INSTALL_COMMAND = 'curl -fsSL https://raw.githubusercontent.com/zickrian/isle/main/get.sh | bash';

/** Whether version `a` ("1.3.0") is newer than `b`, number by number (as isled's updates.rs). */
function isNewer(a, b) {
    const parts = v => v.split('.').map(part => parseInt(part, 10) || 0);
    const [x, y] = [parts(a), parts(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        if ((x[i] ?? 0) !== (y[i] ?? 0))
            return (x[i] ?? 0) > (y[i] ?? 0);
    }
    return false;
}

/** "today", "yesterday" or the date, for when isled last asked GitHub. */
function checkedWhen(ms) {
    const then = GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000));
    const now = GLib.DateTime.new_now_local();
    const days = now.get_day_of_year() - then.get_day_of_year() + 365 * (now.get_year() - then.get_year());
    return days <= 0 ? 'today' : days === 1 ? 'yesterday' : then.format('%e %b').trim();
}

/** The About page's update status (up to date, or the newer version with how to get it) and the switch to
 * ask GitHub; both follow what isled last found (its updates.json) as it changes. */
function updateRows(settings, window, version, packaged) {
    const status = new Adw.ActionRow();
    const icon = new Gtk.Image({valign: Gtk.Align.CENTER});
    status.add_prefix(icon);
    const how = new Gtk.Button({label: 'How to update', valign: Gtk.Align.CENTER, css_classes: ['flat']});
    how.connect('clicked', () => new Gtk.UriLauncher({uri: UPDATE_HELP}).launch(window, null, null));
    const copy = new Gtk.Button({label: 'Copy command', valign: Gtk.Align.CENTER, tooltip_text: INSTALL_COMMAND});
    copy.connect('clicked', () => {
        window.get_display().get_clipboard().set(INSTALL_COMMAND);
        copy.label = 'Copied';
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            copy.label = 'Copy command';
            return GLib.SOURCE_REMOVE;
        });
    });
    status.add_suffix(how);
    status.add_suffix(copy);
    const check = switchRow(settings, 'check-updates', 'Check for new versions', 'Asks GitHub once a day; nothing else is sent');

    const file = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_data_dir(), 'isle', 'updates.json']));
    const sync = () => {
        let checked = null;
        try {
            checked = JSON.parse(new TextDecoder().decode(file.load_contents(null)[1]));
        } catch {}
        const on = settings.get_boolean('check-updates');
        const newer = on && Boolean(checked?.latest) && isNewer(checked.latest, version);
        how.visible = newer;
        copy.visible = newer && !packaged;
        icon.css_classes = newer ? ['accent'] : on && checked?.at_ms ? ['success'] : ['dim-label'];
        if (!on) {
            icon.icon_name = 'software-update-available-symbolic';
            status.title = 'Not checking for new versions';
            status.subtitle = 'Turn it on below to hear when one is out';
        } else if (newer) {
            icon.icon_name = 'software-update-available-symbolic';
            status.title = `Isle ${checked.latest} is out`;
            status.subtitle = packaged ? 'Install its new package, then log out and back in'
                : 'Run the install command again, then log out and back in';
        } else if (checked?.at_ms) {
            icon.icon_name = 'object-select-symbolic';
            status.title = 'You’re up to date';
            status.subtitle = `Checked ${checkedWhen(checked.at_ms)}`;
        } else {
            icon.icon_name = 'software-update-available-symbolic';
            status.title = 'Not checked yet';
            status.subtitle = 'Isle asks GitHub once a day';
        }
    };
    // isled writes it after each look (switched on, or once a day): the row follows while open.
    const monitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null);
    monitor.connect('changed', () => sync());
    const changed = settings.connect('changed::check-updates', () => sync());
    window.connect('close-request', () => {
        monitor.cancel();
        settings.disconnect(changed);
        return false;
    });
    sync();
    return [status, check];
}

function copyReport(window, row) {
    const isled = findProgram('isled');
    if (!isled) {
        row.subtitle = 'isled was not found; is Isle installed?';
        return;
    }
    const process = Gio.Subprocess.new([isled, '--report'], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
    process.communicate_utf8_async(null, null, (_process, result) => {
        try {
            const [, output] = process.communicate_utf8_finish(result);
            window.get_display().get_clipboard().set(output);
            row.subtitle = 'Copied: paste it into the report on GitHub';
        } catch (e) {
            row.subtitle = `Could not make the report: ${e.message}`;
        }
    });
}

/** Lists the ignored apps, each with a remove button, and a search to add one. */
function fillIgnoredApps(group, settings) {
    const key = 'clipboard-ignored-apps';
    const apps = Gio.AppInfo.get_all()
        .filter(app => app.should_show() && app.get_id())
        .sort((a, b) => a.get_display_name().localeCompare(b.get_display_name()));
    let rows = [];

    const add = new Adw.ComboRow({
        title: 'Add an app',
        model: Gtk.StringList.new(['Choose…', ...apps.map(app => app.get_display_name())]),
        // Search needs to know what text to match.
        expression: new Gtk.PropertyExpression(Gtk.StringObject, null, 'string'),
        enable_search: true,
    });
    add.connect('notify::selected', () => {
        const app = apps[add.selected - 1];
        if (!app)
            return;
        const ids = settings.get_strv(key);
        if (!ids.includes(app.get_id()))
            settings.set_strv(key, [...ids, app.get_id()]);
        add.selected = 0;
    });

    const refresh = () => {
        rows.forEach(row => group.remove(row));
        // Only apps on this computer; the built-in list names others too.
        rows = settings.get_strv(key).map(id => [id, DesktopAppInfo.new(id)]).filter(([, app]) => app).map(([id, app]) => {
            const row = new Adw.ActionRow({title: app.get_display_name()});
            if (app.get_icon())
                row.add_prefix(new Gtk.Image({gicon: app.get_icon(), pixel_size: 24}));
            const remove = new Gtk.Button({icon_name: 'list-remove-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat']});
            remove.set_tooltip_text('Keep copies from this app again');
            remove.connect('clicked', () => settings.set_strv(key, settings.get_strv(key).filter(other => other !== id)));
            row.add_suffix(remove);
            return row;
        });
        // Keep "Add an app" last.
        group.remove(add);
        rows.forEach(row => group.add(row));
        group.add(add);
    };
    group.add(add);
    const changed = settings.connect(`changed::${key}`, refresh);
    group.connect('destroy', () => settings.disconnect(changed));
    refresh();
}
