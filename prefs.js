import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import * as Options from './options.js';

const NEW_RULE = {name: 'New rule', app: '', title: '', body: '', color: '#8cc8ff', action: 'show'};

const PATTERN_FIELDS = [
    ['app', 'App name'],
    ['title', 'Title'],
    ['body', 'Body'],
];

function choiceRow(settings, key, title, options) {
    const row = new Adw.ComboRow({
        title,
        model: Gtk.StringList.new(options.map(([, label]) => label)),
    });
    const sync = () => {
        row.selected = Math.max(0, options.findIndex(([value]) => value === settings.get_string(key)));
    };
    sync();
    row.connect('notify::selected', () => settings.set_string(key, options[row.selected][0]));
    settings.connect(`changed::${key}`, sync);
    return row;
}

function spinRow(settings, key, title, subtitle, step) {
    const range = settings.settings_schema.get_key(key).get_range().deepUnpack()[1].deepUnpack();
    const row = Adw.SpinRow.new_with_range(range[0], range[1], step);
    row.title = title;
    row.subtitle = subtitle;
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function isValidPattern(pattern) {
    try {
        new RegExp(pattern, 'i');
        return true;
    } catch {
        return false;
    }
}

function describe(rule) {
    const parts = PATTERN_FIELDS
        .filter(([field]) => rule[field])
        .map(([field, label]) => `${label}: ${rule[field]}`);
    return parts.length > 0 ? parts.join('   ') : 'Matches every notification';
}

export default class BetterGnomeNotificationsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._settings = this.getSettings();
        window.search_enabled = true;

        window.add(this._appearancePage());
        window.add(this._appsPage());
        window.add(this._behaviorPage());
    }

    _appearancePage() {
        const page = new Adw.PreferencesPage({
            title: 'Appearance',
            icon_name: 'applications-graphics-symbolic',
        });

        const banner = new Adw.PreferencesGroup({
            title: 'Banner',
            description: 'Applies to the next banner that appears.',
        });
        banner.add(choiceRow(this._settings, 'position', 'Position', Options.POSITIONS));
        banner.add(choiceRow(this._settings, 'style', 'Color style', Options.STYLES));
        banner.add(choiceRow(this._settings, 'material', 'Material', Options.MATERIALS));
        banner.add(choiceRow(this._settings, 'tone', 'Tone', Options.TONES));
        banner.add(choiceRow(this._settings, 'text-size', 'Text size', Options.TEXT_SIZES));
        banner.add(choiceRow(this._settings, 'entrance', 'Entrance', Options.ENTRANCES));
        page.add(banner);

        const size = new Adw.PreferencesGroup({title: 'Size'});
        size.add(spinRow(this._settings, 'width', 'Width', 'In pixels', 10));
        size.add(spinRow(this._settings, 'corner-radius', 'Corner radius', 'In pixels', 1));
        page.add(size);

        return page;
    }

    _behaviorPage() {
        const page = new Adw.PreferencesPage({
            title: 'Behavior',
            icon_name: 'preferences-system-symbolic',
        });

        const stack = new Adw.PreferencesGroup({
            title: 'Banners',
            description: 'Timers pause while the pointer is on the stack, and wait until you are active.',
        });
        stack.add(spinRow(this._settings, 'max-cards', 'Stack size',
            'Most banners on screen at once. Past this, the oldest leaves early; ' +
            'it stays in the list. 1 shows one at a time.', 1));
        stack.add(spinRow(this._settings, 'normal-timeout', 'Normal timeout', 'In seconds', 1));
        stack.add(spinRow(this._settings, 'critical-timeout', 'Critical timeout', 'In seconds', 5));

        const countdown = new Adw.SwitchRow({
            title: 'Show countdown',
            subtitle: 'A line on each banner that shrinks as its time runs out.',
        });
        this._settings.bind('countdown', countdown, 'active', Gio.SettingsBindFlags.DEFAULT);
        stack.add(countdown);
        page.add(stack);

        const group = new Adw.PreferencesGroup({title: 'Notification list'});
        group.add(spinRow(this._settings, 'rate-limit', 'Rate limit',
            'After an app shows a banner, its next notifications skip the banner ' +
            'for this many milliseconds and only go to the list. 0 turns it off.', 250));

        const grouping = new Adw.SwitchRow({
            title: 'Group notifications by app',
            subtitle: 'When off, every notification gets its own entry in the list.',
        });
        this._settings.bind('group-by-app', grouping, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(grouping);

        page.add(group);
        return page;
    }

    _appsPage() {
        const page = new Adw.PreferencesPage({
            title: 'Apps',
            icon_name: 'view-list-symbolic',
        });

        this._rulesGroup = new Adw.PreferencesGroup({
            title: 'App rules',
            description: 'Checked from the top; the first rule that matches a notification ' +
                'decides its color and whether it shows. Patterns are case-insensitive ' +
                'regular expressions. Leave a pattern empty to match anything.',
        });

        const addButton = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            tooltip_text: 'Add rule',
            has_frame: false,
            valign: Gtk.Align.CENTER,
        });
        addButton.connect('clicked', () => this._saveRules([...this._loadRules(), {...NEW_RULE}]));
        this._rulesGroup.header_suffix = addButton;

        page.add(this._rulesGroup);

        this._ruleRows = [];
        this._settings.connect('changed::rules', () => {
            if (!this._saving)
                this._rebuildRules();
        });
        this._rebuildRules();

        return page;
    }

    _loadRules() {
        try {
            return JSON.parse(this._settings.get_string('rules'));
        } catch {
            return [];
        }
    }

    _saveRules(rules, rebuild = true) {
        this._saving = !rebuild;
        this._settings.set_string('rules', JSON.stringify(rules));
        this._saving = false;
    }

    _rebuildRules() {
        for (const row of this._ruleRows)
            this._rulesGroup.remove(row);
        this._ruleRows = [];

        const rules = this._loadRules();
        if (rules.length === 0) {
            const empty = new Adw.ActionRow({
                title: 'No rules',
                subtitle: 'Every notification shows, in neutral glass. Use + to add one.',
                sensitive: false,
            });
            this._rulesGroup.add(empty);
            this._ruleRows.push(empty);
            return;
        }

        rules.forEach((rule, index) => {
            const row = this._ruleRow(rules, index);
            this._rulesGroup.add(row);
            this._ruleRows.push(row);
        });
    }

    // Edits change `rules` in place and save without rebuilding, so the row
    // being edited keeps its focus and stays expanded.
    _ruleRow(rules, index) {
        const rule = rules[index];
        const row = new Adw.ExpanderRow({title: rule.name, subtitle: describe(rule)});

        const color = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({with_alpha: false}),
            valign: Gtk.Align.CENTER,
        });
        const rgba = new Gdk.RGBA();
        if (rgba.parse(rule.color ?? ''))
            color.rgba = rgba;
        color.connect('notify::rgba', () => {
            const {red, green, blue} = color.rgba;
            rule.color = `#${[red, green, blue].map(channel =>
                Math.round(channel * 255).toString(16).padStart(2, '0')).join('')}`;
            this._saveRules(rules, false);
        });
        row.add_suffix(color);

        const name = new Adw.EntryRow({title: 'Name', text: rule.name, show_apply_button: true});
        name.connect('apply', () => {
            rule.name = name.text;
            row.title = rule.name;
            this._saveRules(rules, false);
        });
        row.add_row(name);

        for (const [field, label] of PATTERN_FIELDS) {
            const entry = new Adw.EntryRow({
                title: `${label} pattern`,
                text: rule[field] ?? '',
                show_apply_button: true,
            });
            entry.connect('changed', () => {
                if (isValidPattern(entry.text))
                    entry.remove_css_class('error');
                else
                    entry.add_css_class('error');
            });
            entry.connect('apply', () => {
                if (!isValidPattern(entry.text))
                    return;
                rule[field] = entry.text;
                row.subtitle = describe(rule);
                this._saveRules(rules, false);
            });
            row.add_row(entry);
        }

        const actions = Options.RULE_ACTIONS;
        const action = new Adw.ComboRow({
            title: 'Action',
            model: Gtk.StringList.new(actions.map(([, label]) => label)),
            selected: Math.max(0, actions.findIndex(([value]) => value === rule.action)),
        });
        action.connect('notify::selected', () => {
            rule.action = actions[action.selected][0];
            this._saveRules(rules, false);
        });
        row.add_row(action);

        const manage = new Adw.ActionRow({title: 'Order'});
        const up = new Gtk.Button({
            icon_name: 'go-up-symbolic',
            tooltip_text: 'Move up',
            has_frame: false,
            valign: Gtk.Align.CENTER,
            sensitive: index > 0,
        });
        up.connect('clicked', () => {
            [rules[index - 1], rules[index]] = [rules[index], rules[index - 1]];
            this._saveRules(rules);
        });
        manage.add_suffix(up);

        const remove = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            tooltip_text: 'Delete rule',
            has_frame: false,
            valign: Gtk.Align.CENTER,
        });
        remove.connect('clicked', () => this._saveRules(rules.filter((_, i) => i !== index)));
        manage.add_suffix(remove);
        row.add_row(manage);

        return row;
    }
}
