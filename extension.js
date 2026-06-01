/* Claude Quota — GNOME Shell extension (GNOME 48/49, ESM)
 *
 * Top-bar indicator that runs a helper script (check_quota.py) and shows
 * Claude.ai usage buckets, with:
 *   - emoji face that reflects load (😀 → 💀)
 *   - dropdown with full stats + per-bucket progress bars
 *   - burn-rate / ETA-to-limit estimate from local history
 *   - a 5h-usage sparkline
 *   - desktop notifications on threshold crossings and session resets
 *   - scroll over the indicator to cycle what's shown; middle-click refreshes
 *
 * The helper script is spawned ASYNCHRONOUSLY (Gio.Subprocess) — never block
 * the shell main loop. The last good reading is cached so a transient failure
 * dims the panel instead of blanking it.
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

const BUCKETS = [
    {key: 'session_5h',    setting: 'show-session', label: 'Session (5h)', suffix: ''},
    {key: 'weekly_total',  setting: 'show-weekly',  label: 'Weekly (7d)',  suffix: 'w'},
    {key: 'weekly_opus',   setting: 'show-opus',    label: 'Opus (7d)',    suffix: 'o'},
    {key: 'weekly_sonnet', setting: 'show-sonnet',  label: 'Sonnet (7d)',  suffix: 's'},
];

// scroll over the indicator cycles these panel presets
// [session, weekly, opus, sonnet]
const PRESETS = [
    [true,  true,  false, false],  // session + weekly  (default)
    [true,  false, false, false],  // session only
    [false, true,  false, false],  // weekly only
    [true,  true,  true,  true],   // everything
];

const ETA_WINDOW_S = 1800;   // look back 30 min for burn-rate
const MAX_SAMPLES   = 720;    // ~24h at 2-min cadence
const SPARK_POINTS  = 60;     // sparkline width in samples
const RESET_DROP    = 15;     // a used% drop >= this means the window reset

function _now() {
    return Math.floor(GLib.get_real_time() / 1e6);
}

function _levelColor(used, warn, crit) {
    if (used >= crit) return [0.88, 0.11, 0.14];   // red
    if (used >= warn) return [0.90, 0.65, 0.04];   // amber
    return [0.20, 0.80, 0.42];                     // green
}

function _emojiFor(used, warn, crit, stale) {
    if (stale) return '😴';
    if (used >= 100) return '💀';
    if (used >= crit) return '😰';
    if (used >= warn) return '😬';
    if (used >= 50)   return '🙂';
    return '😀';
}

function _fmtDuration(secs) {
    secs = Math.max(0, Math.round(secs));
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    if (h >= 1) return `${h}h${m ? ` ${m}m` : ''}`;
    if (m >= 1) return `${m}m`;
    return '<1m';
}

function _roundRect(cr, x, y, w, h, r) {
    r = Math.min(r, h / 2, w / 2);
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

/* A thin rounded progress bar drawn with Cairo. */
const ProgressBar = GObject.registerClass(
class ProgressBar extends St.DrawingArea {
    _init() {
        super._init({style_class: 'claude-bar', height: 8, x_expand: true});
        this._frac = 0;
        this._color = [0.5, 0.5, 0.5];
        this.connect('repaint', () => this._draw());
    }

    setValue(frac, color) {
        this._frac = Math.max(0, Math.min(1, frac));
        this._color = color;
        this.queue_repaint();
    }

    _draw() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        // track
        cr.setSourceRGBA(1, 1, 1, 0.12);
        _roundRect(cr, 0, 0, w, h, h / 2);
        cr.fill();
        // fill
        const fw = Math.max(h, w * this._frac);
        cr.setSourceRGBA(this._color[0], this._color[1], this._color[2], 1);
        _roundRect(cr, 0, 0, fw, h, h / 2);
        cr.fill();
        cr.$dispose();
    }
});

/* A small sparkline of recent 5h usage. */
const Sparkline = GObject.registerClass(
class Sparkline extends St.DrawingArea {
    _init() {
        super._init({style_class: 'claude-spark', height: 38, x_expand: true});
        this._pts = [];
        this._color = [0.20, 0.80, 0.42];
        this.connect('repaint', () => this._draw());
    }

    setData(values, color) {
        this._pts = values.slice(-SPARK_POINTS);
        this._color = color;
        this.queue_repaint();
    }

    _draw() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const pad = 2;
        const n = this._pts.length;
        if (n < 2) {
            cr.$dispose();
            return;
        }
        const dx = (w - 2 * pad) / (n - 1);
        const yOf = v => h - pad - (Math.max(0, Math.min(100, v)) / 100) * (h - 2 * pad);

        // area fill
        cr.moveTo(pad, h - pad);
        this._pts.forEach((v, i) => cr.lineTo(pad + i * dx, yOf(v)));
        cr.lineTo(pad + (n - 1) * dx, h - pad);
        cr.closePath();
        cr.setSourceRGBA(this._color[0], this._color[1], this._color[2], 0.18);
        cr.fill();

        // line
        this._pts.forEach((v, i) => {
            const x = pad + i * dx, y = yOf(v);
            if (i === 0) cr.moveTo(x, y); else cr.lineTo(x, y);
        });
        cr.setSourceRGBA(this._color[0], this._color[1], this._color[2], 1);
        cr.setLineWidth(1.5);
        cr.stroke();
        cr.$dispose();
    }
});

const ClaudeIndicator = GObject.registerClass(
class ClaudeIndicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.0, 'Claude Quota');
        this._ext = ext;
        this._settings = ext.getSettings();
        this._lastResult = null;
        this._stale = false;
        this._timerId = 0;
        this._cancellable = null;

        this._history = [];           // [{t, vals:{key:used}}]
        this._state = {};             // per-bucket {band, used} for notifications
        this._primed = false;         // suppress notifications on first reading
        this._historyFile = this._historyPath();
        this._loadHistory();

        this._label = new St.Label({
            text: '… ',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'claude-quota-label',
        });
        this.add_child(this._label);

        this._buildMenu();

        this._settingsChangedId = this._settings.connect('changed', (_s, key) => {
            if (key === 'refresh-interval') this._restartTimer();
            else { this._syncSwitches(); this._render(); }
        });

        // scroll to cycle presets, middle-click to refresh
        this.connect('scroll-event', (_a, event) => {
            const dir = event.get_scroll_direction();
            if (dir === Clutter.ScrollDirection.UP) this._cyclePreset(-1);
            else if (dir === Clutter.ScrollDirection.DOWN) this._cyclePreset(1);
            else return Clutter.EVENT_PROPAGATE;
            return Clutter.EVENT_STOP;
        });
        this.connect('button-press-event', (_a, event) => {
            if (event.get_button() === 2) { this._refresh(); return Clutter.EVENT_STOP; }
            return Clutter.EVENT_PROPAGATE;
        });

        this._refresh();
        this._restartTimer();
    }

    // ----- menu -----------------------------------------------------------
    _buildMenu() {
        this._headerItem = new PopupMenu.PopupMenuItem('Claude usage', {
            reactive: false, style_class: 'claude-quota-header',
        });
        this.menu.addMenuItem(this._headerItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._rows = {};
        for (const b of BUCKETS) {
            // switch row: toggle == "show this bucket in the panel"
            const item = new PopupMenu.PopupSwitchMenuItem(
                b.label, this._settings.get_boolean(b.setting));
            const stat = new St.Label({
                text: '—',
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'claude-quota-menu-value',
            });
            item.insert_child_below(stat, item.get_last_child());
            item.connect('toggled', (_i, state) =>
                this._settings.set_boolean(b.setting, state));
            this.menu.addMenuItem(item);

            // bar row right beneath it
            const barItem = new PopupMenu.PopupBaseMenuItem({
                reactive: false, can_focus: false, style_class: 'claude-bar-row',
            });
            const bar = new ProgressBar();
            barItem.add_child(bar);
            this.menu.addMenuItem(barItem);

            this._rows[b.key] = {item, stat, bar, barItem};
        }

        // sparkline
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._sparkLabel = new PopupMenu.PopupMenuItem('5h trend', {
            reactive: false, style_class: 'claude-quota-header',
        });
        this.menu.addMenuItem(this._sparkLabel);
        this._sparkItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false, can_focus: false, style_class: 'claude-spark-row',
        });
        this._spark = new Sparkline();
        this._sparkItem.add_child(this._spark);
        this.menu.addMenuItem(this._sparkItem);

        // actions
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const refreshItem = new PopupMenu.PopupMenuItem('Refresh now');
        refreshItem.connect('activate', () => this._refresh());
        this.menu.addMenuItem(refreshItem);
        const prefsItem = new PopupMenu.PopupMenuItem('Settings…');
        prefsItem.connect('activate', () => this._ext.openPreferences());
        this.menu.addMenuItem(prefsItem);
    }

    _cyclePreset(delta) {
        const cur = BUCKETS.map(b => this._settings.get_boolean(b.setting));
        let idx = PRESETS.findIndex(p => p.every((v, i) => v === cur[i]));
        idx = ((idx < 0 ? 0 : idx) + delta + PRESETS.length) % PRESETS.length;
        const next = PRESETS[idx];
        BUCKETS.forEach((b, i) => this._settings.set_boolean(b.setting, next[i]));
    }

    // ----- timer / fetch --------------------------------------------------
    _restartTimer() {
        if (this._timerId) { GLib.source_remove(this._timerId); this._timerId = 0; }
        const interval = Math.max(15, this._settings.get_int('refresh-interval'));
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _refresh() {
        if (this._cancellable) this._cancellable.cancel();
        this._cancellable = new Gio.Cancellable();
        const py = this._settings.get_string('python-path');
        const script = this._settings.get_string('script-path');

        let proc;
        try {
            proc = Gio.Subprocess.new([py, script],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            this._markStale(`spawn failed: ${e.message}`);
            return;
        }
        proc.communicate_utf8_async(null, this._cancellable, (p, res) => {
            let out;
            try {
                [, out] = p.communicate_utf8_finish(res);
            } catch (e) {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    this._markStale(e.message);
                return;
            }
            let data;
            try { data = JSON.parse(out); }
            catch { this._markStale('bad JSON from script'); return; }
            if (!data || data.ok !== true) {
                this._markStale(data?.error || 'script error');
                return;
            }
            this._onData(data);
        });
    }

    _onData(data) {
        this._lastResult = data;
        this._stale = false;
        this._recordHistory(data);
        this._checkAlerts(data);
        this._primed = true;
        this._render();
    }

    _markStale(reason) {
        this._stale = true;
        log(`[claude-quota] stale: ${reason}`);
        this._render();
    }

    // ----- history / burn-rate -------------------------------------------
    _historyPath() {
        const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'claude-quota']);
        GLib.mkdir_with_parents(dir, 0o755);
        return GLib.build_filenamev([dir, 'history.json']);
    }

    _loadHistory() {
        try {
            const [ok, bytes] = GLib.file_get_contents(this._historyFile);
            if (ok) {
                const txt = new TextDecoder().decode(bytes);
                this._history = JSON.parse(txt).slice(-MAX_SAMPLES);
            }
        } catch { this._history = []; }
    }

    _saveHistory() {
        try {
            GLib.file_set_contents(this._historyFile, JSON.stringify(this._history));
        } catch (e) { log(`[claude-quota] history save failed: ${e.message}`); }
    }

    _recordHistory(data) {
        const vals = {};
        for (const b of BUCKETS) {
            const v = data[b.key];
            if (v) vals[b.key] = v.used_percent;
        }
        this._history.push({t: _now(), vals});
        if (this._history.length > MAX_SAMPLES)
            this._history = this._history.slice(-MAX_SAMPLES);
        this._saveHistory();
    }

    // returns {ratePerHour, etaSecs} or null
    _burnRate(key) {
        const now = _now();
        const recent = this._history.filter(s =>
            s.vals[key] !== undefined && now - s.t <= ETA_WINDOW_S);
        if (recent.length < 2) return null;
        const a = recent[0], b = recent[recent.length - 1];
        const dt = b.t - a.t;
        if (dt < 120) return null;
        const dv = b.vals[key] - a.vals[key];
        const ratePerHour = (dv / dt) * 3600;
        if (ratePerHour <= 0.1) return {ratePerHour, etaSecs: null};
        const remaining = Math.max(0, 100 - b.vals[key]);
        return {ratePerHour, etaSecs: (remaining / ratePerHour) * 3600};
    }

    // ----- notifications --------------------------------------------------
    _checkAlerts(data) {
        if (!this._settings.get_boolean('notifications')) {
            // still update baseline so we don't fire a backlog when re-enabled
            for (const b of BUCKETS) {
                const v = data[b.key];
                if (v) this._state[b.key] = {used: v.used_percent, band: this._band(v.used_percent)};
            }
            return;
        }
        const warn = this._settings.get_int('warn-threshold');
        const crit = this._settings.get_int('crit-threshold');
        for (const b of BUCKETS) {
            const v = data[b.key];
            if (!v) continue;
            const used = v.used_percent;
            const band = this._band(used);
            const prev = this._state[b.key];
            this._state[b.key] = {used, band};
            if (!this._primed || !prev) continue;

            // reset detected: usage dropped sharply
            if (prev.used - used >= RESET_DROP) {
                Main.notify('Claude — limit reset 🟢',
                    `${b.label} back to ${Math.round(used)}% used.`);
                continue;
            }
            // threshold crossed upward
            if (band > prev.band) {
                const emoji = band === 2 ? '🛑' : '⚠️';
                Main.notify(`Claude — ${b.label} ${emoji}`,
                    `${Math.round(used)}% used · resets in ${v.resets_in}`);
            }
        }
    }

    _band(used) {
        const warn = this._settings.get_int('warn-threshold');
        const crit = this._settings.get_int('crit-threshold');
        if (used >= crit) return 2;
        if (used >= warn) return 1;
        return 0;
    }

    // ----- rendering ------------------------------------------------------
    _usedOf(key) {
        const b = this._lastResult?.[key];
        return b ? b.used_percent : null;
    }

    _render() {
        this._renderPanel();
        this._renderMenu();
    }

    _renderPanel() {
        const warn = this._settings.get_int('warn-threshold');
        const crit = this._settings.get_int('crit-threshold');
        const parts = [];
        let maxShown = 0;
        for (const b of BUCKETS) {
            if (!this._settings.get_boolean(b.setting)) continue;
            const used = this._usedOf(b.key);
            if (used === null) continue;
            maxShown = Math.max(maxShown, used);
            parts.push(`${Math.round(used)}%${b.suffix}`);
        }
        const body = parts.length ? parts.join(' · ') : (this._lastResult ? 'n/a' : '…');
        const icon = this._settings.get_boolean('emoji-icon')
            ? _emojiFor(maxShown, warn, crit, this._stale)
            : 'C';
        this._label.text = this._stale ? `${icon} ⚠ ${body}` : `${icon} ${body}`;

        this._label.remove_style_class_name('claude-quota-warn');
        this._label.remove_style_class_name('claude-quota-crit');
        this._label.remove_style_class_name('claude-quota-stale');
        if (this._stale) this._label.add_style_class_name('claude-quota-stale');
        else if (maxShown >= crit) this._label.add_style_class_name('claude-quota-crit');
        else if (maxShown >= warn) this._label.add_style_class_name('claude-quota-warn');
    }

    _renderMenu() {
        const r = this._lastResult;
        const warn = this._settings.get_int('warn-threshold');
        const crit = this._settings.get_int('crit-threshold');
        const showEta = this._settings.get_boolean('show-eta');
        const dim = this._stale ? ' · stale' : '';

        for (const b of BUCKETS) {
            const row = this._rows[b.key];
            const bucket = r?.[b.key];
            if (bucket) {
                const used = bucket.used_percent;
                let text = `${Math.round(used)}% · ${bucket.resets_in}`;
                if (showEta) {
                    const br = this._burnRate(b.key);
                    if (br && br.ratePerHour > 0.1) {
                        text += ` · ↑${br.ratePerHour.toFixed(1)}%/h`;
                        if (br.etaSecs !== null) text += ` · ~${_fmtDuration(br.etaSecs)}`;
                    }
                }
                row.stat.text = text + dim;
                row.bar.setValue(used / 100, _levelColor(used, warn, crit));
                row.barItem.visible = true;
            } else {
                row.stat.text = r ? '—' : '…';
                row.bar.setValue(0, [0.5, 0.5, 0.5]);
                row.barItem.visible = !!(r === null);
            }
        }

        // sparkline of 5h usage
        const showSpark = this._settings.get_boolean('show-sparkline');
        this._sparkLabel.visible = showSpark;
        this._sparkItem.visible = showSpark;
        if (showSpark) {
            const series = this._history
                .map(s => s.vals.session_5h)
                .filter(v => v !== undefined);
            const last = series.length ? series[series.length - 1] : 0;
            this._spark.setData(series, _levelColor(last, warn, crit));
        }

        this._headerItem.label.text = this._stale
            ? 'Claude usage — stale, last good shown'
            : 'Claude usage';
    }

    _syncSwitches() {
        for (const b of BUCKETS) {
            const row = this._rows[b.key];
            const want = this._settings.get_boolean(b.setting);
            if (row.item.state !== want) row.item.setToggleState(want);
        }
    }

    destroy() {
        if (this._timerId) { GLib.source_remove(this._timerId); this._timerId = 0; }
        if (this._cancellable) { this._cancellable.cancel(); this._cancellable = null; }
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
        this._saveHistory();
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
