/* Claude Quota — preferences (libadwaita, GNOME 48/49) */

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ClaudeQuotaPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({title: 'Claude Quota', icon_name: 'utilities-system-monitor-symbolic'});
        window.add(page);

        // --- Panel display -------------------------------------------------
        const display = new Adw.PreferencesGroup({
            title: 'Shown in the panel',
            description: 'Which buckets appear in the top bar (also toggleable from the dropdown).',
        });
        page.add(display);

        const toggles = [
            ['show-session', 'Session (5h)'],
            ['show-weekly',  'Weekly (7d total)'],
            ['show-opus',    'Opus (7d)'],
            ['show-sonnet',  'Sonnet (7d)'],
        ];
        for (const [key, title] of toggles) {
            const row = new Adw.SwitchRow({title});
            display.add(row);
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        }

        // --- Behaviour toggles --------------------------------------------
        const feel = new Adw.PreferencesGroup({title: 'Look & feel'});
        page.add(feel);

        const featureToggles = [
            ['emoji-icon',     'Emoji face in the panel', 'Show 😀 → 💀 instead of a plain “C”.'],
            ['notifications',  'Desktop notifications',   'Alert on threshold crossings and limit resets.'],
            ['show-eta',       'Burn-rate & ETA',         'Estimate time-to-limit in the dropdown.'],
            ['show-sparkline', '5h usage sparkline',      'Mini trend chart in the dropdown.'],
        ];
        for (const [key, title, subtitle] of featureToggles) {
            const row = new Adw.SwitchRow({title, subtitle});
            feel.add(row);
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        }

        // --- Colour thresholds --------------------------------------------
        const colours = new Adw.PreferencesGroup({title: 'Colour thresholds (% used)'});
        page.add(colours);

        const warnRow = new Adw.SpinRow({
            title: 'Warn (amber)',
            adjustment: new Gtk.Adjustment({lower: 1, upper: 100, step_increment: 1}),
        });
        colours.add(warnRow);
        settings.bind('warn-threshold', warnRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        const critRow = new Adw.SpinRow({
            title: 'Critical (red)',
            adjustment: new Gtk.Adjustment({lower: 1, upper: 100, step_increment: 1}),
        });
        colours.add(critRow);
        settings.bind('crit-threshold', critRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        // --- Behaviour -----------------------------------------------------
        const behaviour = new Adw.PreferencesGroup({title: 'Data source & refresh'});
        page.add(behaviour);

        const intervalRow = new Adw.SpinRow({
            title: 'Refresh interval (seconds)',
            adjustment: new Gtk.Adjustment({lower: 15, upper: 3600, step_increment: 15}),
        });
        behaviour.add(intervalRow);
        settings.bind('refresh-interval', intervalRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        const pyRow = new Adw.EntryRow({title: 'Python path'});
        behaviour.add(pyRow);
        settings.bind('python-path', pyRow, 'text', Gio.SettingsBindFlags.DEFAULT);

        const scriptRow = new Adw.EntryRow({title: 'Quota script path'});
        behaviour.add(scriptRow);
        settings.bind('script-path', scriptRow, 'text', Gio.SettingsBindFlags.DEFAULT);

        const hint = new Adw.PreferencesGroup({
            description: 'The script must print quota JSON to stdout with an "ok": true field ' +
                'and buckets session_5h / weekly_total / weekly_opus / weekly_sonnet.',
        });
        page.add(hint);
    }
}
