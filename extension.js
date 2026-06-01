/* Claude Quota — GNOME Shell extension (GNOME 48/49, ESM)
 *
 * Top-bar indicator that runs a helper script (check_quota.py) and shows
 * Claude.ai usage buckets. Click it for a dropdown with full stats; each
 * row has a switch that toggles whether that bucket shows in the panel.
 *
 * Design notes:
 *  - The script is spawned ASYNCHRONOUSLY (Gio.Subprocess). Never block the
 *    shell main loop with a sync call.
 *  - The last successful reading is cached, so a transient failure (expired
 *    token, no network) dims the panel + marks it stale instead of blanking.
 */

import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// bucket key -> { settingsKey, label, shortSuffix }
const BUCKETS = [
    {key: 'session_5h',    setting: 'show-session', label: 'Session (5h)', suffix: ''},
    {key: 'weekly_total',  setting: 'show-weekly',  label: 'Weekly (7d)',  suffix: 'w'},
    {key: 'weekly_opus',   setting: 'show-opus',    label: 'Opus (7d)',    suffix: 'o'},
    {key: 'weekly_sonnet', setting: 'show-sonnet',  label: 'Sonnet (7d)',  suffix: 's'},
];

const ClaudeIndicator = GObject.registerClass(
class ClaudeIndicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.0, 'Claude Quota');
        this._ext = ext;
        this._settings = ext.getSettings();
        this._lastResult = null;   // last successful parse
        this._stale = false;
        this._timerId = 0;
        this._cancellable = null;

        // --- panel label -------------------------------------------------
        this._label = new St.Label({
            text: 'C …',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'claude-quota-label',
        });
        this.add_child(this._label);

        // --- dropdown menu ----------------------------------------------
        this._buildMenu();

        // react to settings changes (from prefs or the menu switches)
        this._settingsChangedId = this._settings.connect('changed', (_s, key) => {
            if (key === 'refresh-interval') {
                this._restartTimer();
            } else {
                this._syncSwitches();
                this._renderPanel();
            }
        });

        // first fetch + periodic timer
        this._refresh();
        this._restartTimer();
    }

    _buildMenu() {
        // header
        this._headerItem = new PopupMenu.PopupMenuItem('Claude usage', {
            reactive: false,
            style_class: 'claude-quota-header',
        });
        this.menu.addMenuItem(this._headerItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // one switch row per bucket: switch state == "show in panel"
        this._rows = {};
        for (const b of BUCKETS) {
            const item = new PopupMenu.PopupSwitchMenuItem(
                b.label, this._settings.get_boolean(b.setting));
            // a secondary value label glued to the right of the title
            const valueLabel = new St.Label({
                text: '—',
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'claude-quota-menu-value',
            });
            // insert value label just before the toggle switch
            item.add_child(valueLabel);
            item._valueLabel = valueLabel;
            item.connect('toggled', (_i, state) => {
                this._settings.set_boolean(b.setting, state);
            });
            this.menu.addMenuItem(item);
            this._rows[b.key] = item;
        }

        // extra usage (paid overage) — read-only info row
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._extraItem = new PopupMenu.PopupMenuItem('Extra usage: —', {reactive: false});
        this.menu.addMenuItem(this._extraItem);

        // actions
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const refreshItem = new PopupMenu.PopupMenuItem('Refresh now');
        refreshItem.connect('activate', () => this._refresh());
        this.menu.addMenuItem(refreshItem);

        const prefsItem = new PopupMenu.PopupMenuItem('Settings…');
        prefsItem.connect('activate', () => this._ext.openPreferences());
        this.menu.addMenuItem(prefsItem);
    }

    _restartTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
        const interval = Math.max(15, this._settings.get_int('refresh-interval'));
        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, interval, () => {
                this._refresh();
                return GLib.SOURCE_CONTINUE;
            });
    }

    _refresh() {
        // cancel any in-flight call so we never overlap
        if (this._cancellable)
            this._cancellable.cancel();
        this._cancellable = new Gio.Cancellable();

        const py = this._settings.get_string('python-path');
        const script = this._settings.get_string('script-path');

        let proc;
        try {
            proc = Gio.Subprocess.new(
                [py, script],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            this._markStale(`spawn failed: ${e.message}`);
            return;
        }

        proc.communicate_utf8_async(null, this._cancellable, (p, res) => {
            let ok, out;
            try {
                [ok, out] = p.communicate_utf8_finish(res);
            } catch (e) {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    this._markStale(e.message);
                return;
            }
            let data;
            try {
                data = JSON.parse(out);
            } catch (e) {
                this._markStale('bad JSON from script');
                return;
            }
            if (!data || data.ok !== true) {
                this._markStale(data?.error || 'script error');
                return;
            }
            this._lastResult = data;
            this._stale = false;
            this._render();
        });
    }

    _markStale(reason) {
        this._stale = true;
        log(`[claude-quota] stale: ${reason}`);
        this._render();   // keep last good numbers, just dim them
    }

    _render() {
        this._renderPanel();
        this._renderMenu();
    }

    _usedOf(key) {
        const b = this._lastResult?.[key];
        return b ? b.used_percent : null;
    }

    _renderPanel() {
        const parts = [];
        let maxShown = 0;
        for (const b of BUCKETS) {
            if (!this._settings.get_boolean(b.setting))
                continue;
            const used = this._usedOf(b.key);
            if (used === null)
                continue;
            maxShown = Math.max(maxShown, used);
            parts.push(`${Math.round(used)}%${b.suffix}`);
        }
        let text = parts.length ? parts.join(' · ') : (this._lastResult ? 'n/a' : '…');
        if (this._stale)
            text = `⚠ ${text}`;
        this._label.text = `C ${text}`;

        // colour
        this._label.remove_style_class_name('claude-quota-warn');
        this._label.remove_style_class_name('claude-quota-crit');
        this._label.remove_style_class_name('claude-quota-stale');
        if (this._stale) {
            this._label.add_style_class_name('claude-quota-stale');
        } else if (maxShown >= this._settings.get_int('crit-threshold')) {
            this._label.add_style_class_name('claude-quota-crit');
        } else if (maxShown >= this._settings.get_int('warn-threshold')) {
            this._label.add_style_class_name('claude-quota-warn');
        }
    }

    _renderMenu() {
        const r = this._lastResult;
        const dim = this._stale ? ' (stale)' : '';
        for (const b of BUCKETS) {
            const item = this._rows[b.key];
            const bucket = r?.[b.key];
            if (bucket) {
                item._valueLabel.text =
                    `${Math.round(bucket.used_percent)}% · ${bucket.resets_in}${dim}`;
            } else {
                item._valueLabel.text = r ? '—' : '…';
            }
        }
        const ex = r?.extra_usage;
        if (ex && ex.is_enabled) {
            const used = Math.round((ex.used_credits ?? 0));
            this._extraItem.label.text =
                `Extra usage: ${used} / ${ex.monthly_limit} cr (${Math.round(ex.utilization ?? 0)}%)`;
        } else {
            this._extraItem.label.text = 'Extra usage: off';
        }
        this._headerItem.label.text = this._stale
            ? 'Claude usage — stale, last good shown'
            : 'Claude usage';
    }

    _syncSwitches() {
        for (const b of BUCKETS) {
            const item = this._rows[b.key];
            const want = this._settings.get_boolean(b.setting);
            if (item.state !== want)
                item.setToggleState(want);
        }
    }

    destroy() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
        super.destroy();
    }
});

export default class ClaudeQuotaExtension extends Extension {
    enable() {
        this._indicator = new ClaudeIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
