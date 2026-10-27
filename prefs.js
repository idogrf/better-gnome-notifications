import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Gsk from 'gi://Gsk';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import * as Options from './options.js';
import {GLASS, SHRINK, SPREAD, parseHex, tintStart} from './look.js';
import {compileRules, matchRule} from './rules.js';

const NEW_RULE = {name: 'New rule', app: '', title: '', body: '', color: '#8cc8ff', action: 'show'};

const PATTERN_FIELDS = [
    ['app', 'App name'],
    ['title', 'Title'],
    ['body', 'Body'],
];

// What a rule's test sends where the rule has no pattern to match.
const TEST_APP = 'Better GNOME Notifications';
const TEST_BODY = 'Test from the settings window';
const BURST_DELAY = 600;
const BURST_RULES = 4;

// The preview: a corner of the desktop with the stack drawn at real size.
const PREVIEW_HEIGHT = 230;
const PREVIEW_RADIUS = 12;
// Room kept beside the stack, so a wide stack doesn't fill the preview.
const PREVIEW_ROOM = 260;
const TOP_BAR = 32;
const BANNER_MARGIN = 10;
// How far each sample card's countdown has run, front to back.
const SAMPLE_COUNTDOWNS = [0.62, 0.84, 0.45, 0.92, 0.3];
// Banner text sizes in pixels, as in stylesheet.css.
const TEXT = {
    small: {header: 11, title: 13, body: 12.5, icon: 30},
    medium: {header: 12, title: 14.5, body: 13.5, icon: 34},
};
const INK = {dark: [244, 246, 250], light: [27, 29, 34]};

const CSS = `
.bn-choice { padding: 6px; border-radius: 12px; }
.bn-choice:checked { background: alpha(var(--accent-bg-color), 0.15); box-shadow: inset 0 0 0 2px var(--accent-bg-color); }
.bn-chip { font-size: smaller; font-weight: bold; padding: 2px 8px; border-radius: 99px; background: alpha(currentColor, 0.1); }
.bn-chip.blocked { color: var(--error-color); }
`;

function rect(x, y, width, height) {
    return new Graphene.Rect().init(x, y, width, height);
}

function rounded(x, y, width, height, radius) {
    const shape = new Gsk.RoundedRect();
    shape.init_from_rect(rect(x, y, width, height), radius);
    return shape;
}

function rgba([r, g, b], alpha = 1) {
    return new Gdk.RGBA({red: r / 255, green: g / 255, blue: b / 255, alpha});
}

function roundedPath(cr, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    cr.newPath();
    cr.arc(x + width - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + width - r, y + height - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + height - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

function setSource(cr, [r, g, b, a]) {
    cr.setSourceRGBA(r / 255, g / 255, b / 255, a);
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

// Builds text a pattern matches, for the simple patterns rules use: plain
// text, escaped characters, ^ and $, and alternatives such as (a|b), of which
// it takes the first. Returns null for anything else.
function sampleFor(pattern) {
    let text = pattern.replace(/^\^/, '').replace(/(^|[^\\])\$$/, '$1');
    text = text.replace(/\((?:\?:)?([^()]*)\)/g, (_, inner) => inner.split('|')[0]);
    text = text.split('|')[0];
    if (/\\[A-Za-z0-9]/.test(text) || /(^|[^\\])[.*+?^${}()[\]|]/.test(text))
        return null;
    text = text.replace(/\\(.)/g, '$1');
    return new RegExp(pattern, 'i').test(text) ? text : null;
}

// The notification a rule's test sends, built so the rule's own patterns
// match it, or {error} when a pattern is too complex to build from.
function testFor(rule) {
    const test = {
        app: rule.app ? sampleFor(rule.app) : TEST_APP,
        title: rule.title ? sampleFor(rule.title) : `Test for ${rule.name}`,
        body: rule.body ? sampleFor(rule.body) : TEST_BODY,
    };
    const failed = PATTERN_FIELDS.find(([field]) => test[field] === null);
    if (failed)
        return {error: `The ${failed[1].toLowerCase()} pattern is too complex to build a test from`};

    if (rule.body && new RegExp(rule.body, 'i').test(`${test.body}\n${TEST_BODY}`))
        test.body = `${test.body}\n${TEST_BODY}`;
    return test;
}

// GNOME's day/night wallpapers are XML slideshows: a start time, then images
// and cross-fades that repeat. Returns the image showing now.
function slideshowImage(path) {
    const [, bytes] = GLib.file_get_contents(path);
    const xml = new TextDecoder().decode(bytes);
    const tag = (name, text) => new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(text)?.[1] ?? null;
    const number = (name, text) => Number(tag(name, text) ?? 0);

    const start = /<starttime>([\s\S]*?)<\/starttime>/.exec(xml)?.[1] ?? '';
    const startTime = GLib.DateTime.new_local(number('year', start) || 2000, number('month', start) || 1,
        number('day', start) || 1, number('hour', start), number('minute', start), number('second', start));

    const slides = [...xml.matchAll(/<(static|transition)[^>]*>([\s\S]*?)<\/\1>/g)].map(([, kind, inner]) => ({
        duration: number('duration', inner),
        file: kind === 'static' ? tag('file', inner) : null,
        from: tag('from', inner),
        to: tag('to', inner),
    }));
    const total = slides.reduce((sum, slide) => sum + slide.duration, 0);
    if (total === 0)
        return slides[0]?.file ?? null;

    let offset = (GLib.DateTime.new_now_local().difference(startTime) / 1e6) % total;
    if (offset < 0)
        offset += total;
    for (const slide of slides) {
        if (offset < slide.duration)
            return slide.file ?? (offset < slide.duration / 2 ? slide.from : slide.to);
        offset -= slide.duration;
    }
    return null;
}

function loadWallpaper() {
    const background = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
    const key = Adw.StyleManager.get_default().dark ? 'picture-uri-dark' : 'picture-uri';
    const uri = background.get_string(key) || background.get_string('picture-uri');
    if (!uri)
        return null;

    try {
        let path = Gio.File.new_for_uri(uri).get_path();
        if (path?.endsWith('.xml'))
            path = slideshowImage(path);
        return path ? Gdk.Texture.new_from_filename(path) : null;
    } catch (e) {
        console.warn(`Better GNOME Notifications: can't load the wallpaper for the preview: ${e.message}`);
        return null;
    }
}

// The desktop corner the stack sits in, with sample cards drawn the way the
// extension draws them: same sizes, glass, tint and stack shape.
class Preview extends Gtk.Widget {
    static {
        GObject.registerClass(this);
    }

    constructor(prefs) {
        super({hexpand: true, height_request: PREVIEW_HEIGHT});
        this._prefs = prefs;
    }

    vfunc_snapshot(snapshot) {
        const settings = this._prefs._settings;
        const width = settings.get_int('width');
        const max = settings.get_int('max-cards');
        const [vertical, horizontal] = settings.get_string('position').split('-');
        const top = vertical === 'top';

        const widgetWidth = this.get_width();
        const widgetHeight = this.get_height();
        const scale = Math.min(1, widgetWidth / (width + PREVIEW_ROOM));
        const screenWidth = widgetWidth / scale;
        const screenHeight = widgetHeight / scale;

        snapshot.push_rounded_clip(rounded(0, 0, widgetWidth, widgetHeight, PREVIEW_RADIUS));
        snapshot.save();
        snapshot.scale(scale, scale);

        const wallpaper = () => this._drawWallpaper(snapshot, screenWidth, screenHeight, horizontal, top);
        wallpaper();
        if (top)
            this._drawTopBar(snapshot, screenWidth);

        const cards = this._prefs._sampleCards();
        const look = this._look();
        const layouts = this._layouts(cards[0], width, look);
        const height = layouts.height;
        const radius = settings.get_int('corner-radius');
        const peek = max > 1 ? SPREAD * height / (max - 1) : 0;

        const x = horizontal === 'left' ? BANNER_MARGIN
            : horizontal === 'center' ? (screenWidth - width) / 2
                : screenWidth - BANNER_MARGIN - width;

        for (let i = cards.length - 1; i >= 0; i--) {
            const shrink = 1 - SHRINK * i;
            const y = top
                ? TOP_BAR + BANNER_MARGIN + i * peek
                : screenHeight - BANNER_MARGIN - i * peek - height * shrink;

            if (i === 0 && look.material === 'frost') {
                snapshot.push_rounded_clip(rounded(x, y, width, height, radius));
                snapshot.push_blur(30);
                wallpaper();
                snapshot.pop();
                snapshot.append_color(rgba([0, 0, 0], 0.15), rect(x, y, width, height));
                snapshot.pop();
            }

            snapshot.save();
            snapshot.translate(new Graphene.Point().init(x + width * (1 - shrink) / 2, y));
            snapshot.scale(shrink, shrink);
            this._drawCard(snapshot, width, height, radius, cards[i], i, look, i === 0 ? layouts : null);
            snapshot.restore();
        }

        snapshot.restore();
        snapshot.pop();
    }

    _look() {
        const settings = this._prefs._settings;
        return {
            tone: settings.get_string('tone'),
            material: settings.get_string('material'),
            text: TEXT[settings.get_string('text-size')] ?? TEXT.small,
            countdown: settings.get_boolean('countdown'),
        };
    }

    _drawWallpaper(snapshot, screenWidth, screenHeight, horizontal, top) {
        const texture = this._prefs._wallpaper;
        if (!texture) {
            snapshot.append_color(rgba([43, 47, 56]), rect(0, 0, screenWidth, screenHeight));
            return;
        }

        // Shown at no more than half size, so the preview shows some of
        // the picture rather than a blur of one corner of it.
        const scale = Math.max(screenWidth / texture.width, screenHeight / texture.height, 0.5);
        const width = texture.width * scale;
        const height = texture.height * scale;
        const x = horizontal === 'left' ? 0 : horizontal === 'center' ? (screenWidth - width) / 2 : screenWidth - width;
        const y = top ? 0 : screenHeight - height;
        snapshot.append_texture(texture, rect(x, y, width, height));
    }

    _drawTopBar(snapshot, screenWidth) {
        snapshot.append_color(rgba([0, 0, 0], 0.82), rect(0, 0, screenWidth, TOP_BAR));

        const clock = this._layout(GLib.DateTime.new_now_local().format('%a %e %b  %H:%M'), 13, Pango.Weight.BOLD);
        const [clockWidth, clockHeight] = clock.get_pixel_size();
        snapshot.save();
        snapshot.translate(new Graphene.Point().init((screenWidth - clockWidth) / 2, (TOP_BAR - clockHeight) / 2));
        snapshot.append_layout(clock, rgba([255, 255, 255]));
        snapshot.restore();
    }

    _layout(text, size, weight = Pango.Weight.NORMAL) {
        const layout = this.create_pango_layout(text);
        const font = Pango.FontDescription.from_string(Gtk.Settings.get_default().gtk_font_name);
        font.set_absolute_size(size * Pango.SCALE);
        font.set_weight(weight);
        layout.set_font_description(font);
        return layout;
    }

    // Lays out the front card's text and works out the card height from it,
    // with the banner's padding and border from stylesheet.css.
    _layouts(card, width, {text, countdown}) {
        const textX = 1 + 10 + text.icon + 10;
        const textWidth = width - textX - 12 - 1;

        const app = this._layout(card.name, text.header, Pango.Weight.MEDIUM);
        const time = this._layout('now', text.header, Pango.Weight.MEDIUM);
        const title = this._layout('New message', text.title, Pango.Weight.BOLD);
        const body = this._layout(`This is how a banner from ${card.name} looks.`, text.body);
        for (const layout of [app, title, body]) {
            layout.set_width(textWidth * Pango.SCALE);
            layout.set_ellipsize(Pango.EllipsizeMode.END);
        }
        body.set_wrap(Pango.WrapMode.WORD_CHAR);
        body.set_height(-2);

        const lines = [app, title, body].map(layout => layout.get_pixel_size()[1]);
        const content = Math.max(text.icon + 2, lines[0] + lines[1] + lines[2] + 2);
        const height = 1 + 9 + content + (countdown ? 10 : 0) + 11 + 1;
        return {app, time, title, body, lines, textX, textWidth, height};
    }

    _drawCard(snapshot, width, height, radius, card, index, {tone, material, text, countdown}, layouts) {
        const front = index === 0;
        const glass = GLASS[tone][material === 'frost' && !front ? 'stacked' : material];

        snapshot.append_outset_shadow(rounded(0, 0, width, height, radius),
            rgba([0, 0, 0], front ? 0.32 : 0.22), 0, front ? 8 : 4, 0, front ? 24 : 12);

        // Drawn with render nodes rather than Cairo: a Cairo node under the
        // preview's scale lands offset by the card's position times the
        // scale a second time, pulling the fill away from the text.
        const ink = INK[tone];
        const shape = rounded(0, 0, width, height, radius);
        const bounds = rect(0, 0, width, height);
        snapshot.push_rounded_clip(shape);
        if (card.color) {
            const start = tintStart(glass, card.color);
            snapshot.append_linear_gradient(bounds,
                new Graphene.Point().init(0, 0), new Graphene.Point().init(width, 0), [
                    new Gsk.ColorStop({offset: 0, color: rgba(start, start[3])}),
                    new Gsk.ColorStop({offset: 1, color: rgba(glass, glass[3])}),
                ]);
        } else {
            snapshot.append_color(rgba(glass, glass[3]), bounds);
        }
        snapshot.pop();
        const edge = tone === 'dark' ? rgba([255, 255, 255], 0.09) : rgba([0, 0, 0], 0.1);
        snapshot.append_border(shape, [1, 1, 1, 1], [edge, edge, edge, edge]);

        if (layouts) {
            snapshot.push_rounded_clip(rounded(11, 12, text.icon, text.icon, 8));
            snapshot.append_color(card.color ? rgba(card.color) : rgba(ink, 0.16),
                rect(11, 12, text.icon, text.icon));
            snapshot.pop();

            if (countdown) {
                const lineWidth = width - 11 - 13;
                snapshot.append_color(rgba(ink, 0.35),
                    rect(11, height - 12 - 2, lineWidth * card.countdown, 2));
            }
        }

        if (!layouts)
            return;

        const letter = this._layout(card.name.slice(0, 1).toUpperCase() || '?', text.title, Pango.Weight.BOLD);
        const [letterWidth, letterHeight] = letter.get_pixel_size();
        const place = (layout, x, y, color) => {
            snapshot.save();
            snapshot.translate(new Graphene.Point().init(x, y));
            snapshot.append_layout(layout, color);
            snapshot.restore();
        };
        place(letter, 11 + (text.icon - letterWidth) / 2, 12 + (text.icon - letterHeight) / 2,
            card.color ? rgba([255, 255, 255]) : rgba(ink));

        const {app, time, title, body, lines, textX, textWidth} = layouts;
        const top = 10;
        place(app, textX, top, rgba(ink, 0.5));
        place(time, textX + textWidth - time.get_pixel_size()[0], top, rgba(ink, 0.5));
        place(title, textX, top + lines[0], rgba(ink));
        place(body, textX, top + lines[0] + lines[1] + 2, rgba(ink, 0.74));
    }
}

// A small drawing for a choice button or a rule's color dot.
// `draw(cr, width, height)` paints it.
class Picture extends Gtk.DrawingArea {
    static {
        GObject.registerClass(this);
    }

    constructor(height, draw) {
        super({hexpand: true, content_height: height});
        this.set_draw_func((_area, cr, width, areaHeight) => draw(cr, width, areaHeight));
    }
}

// A glass sample over a busy pattern, so solid, translucent and frosted
// look different: solid hides the pattern, frosted blurs it.
class GlassSwatch extends Gtk.Widget {
    static {
        GObject.registerClass(this);
    }

    constructor(look) {
        super({hexpand: true, height_request: 64});
        this._look = look;
    }

    vfunc_snapshot(snapshot) {
        const width = this.get_width();
        const height = this.get_height();
        const {tone, material} = this._look();
        const glass = GLASS[tone][material];
        const glassWidth = width * 0.72;
        const glassX = (width - glassWidth) / 2;
        const glassY = (height - 34) / 2;

        snapshot.push_rounded_clip(rounded(0, 0, width, height, 9));
        this._drawPattern(snapshot, width, height);
        if (material === 'frost') {
            snapshot.push_rounded_clip(rounded(glassX, glassY, glassWidth, 34, 8));
            snapshot.push_blur(6);
            this._drawPattern(snapshot, width, height);
            snapshot.pop();
            snapshot.pop();
        }

        const cr = snapshot.append_cairo(rect(0, 0, width, height));
        roundedPath(cr, glassX + 0.5, glassY + 0.5, glassWidth - 1, 33, 8);
        setSource(cr, glass);
        cr.fillPreserve();
        setSource(cr, tone === 'dark' ? [255, 255, 255, 0.12] : [0, 0, 0, 0.12]);
        cr.setLineWidth(1);
        cr.stroke();
        cr.$dispose();
        snapshot.pop();
    }

    _drawPattern(snapshot, width, height) {
        const cr = snapshot.append_cairo(rect(0, 0, width, height));
        setSource(cr, [38, 40, 46, 1]);
        cr.paint();

        setSource(cr, [255, 255, 255, 0.13]);
        cr.setLineWidth(5);
        for (let x = -height; x < width; x += 11) {
            cr.moveTo(x, height);
            cr.lineTo(x + height, 0);
        }
        cr.stroke();

        for (const [cx, cy, r, color] of [
            [0.34, 0.42, 13, [234, 67, 53]],
            [0.6, 0.62, 15, [66, 133, 244]],
            [0.78, 0.3, 8, [244, 197, 66]],
        ]) {
            cr.arc(width * cx, height * cy, r, 0, 2 * Math.PI);
            setSource(cr, [...color, 1]);
            cr.fill();
        }
        cr.$dispose();
    }
}

export default class BetterGnomeNotificationsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._settings = this.getSettings();
        this._window = window;
        this._wallpaper = loadWallpaper();
        this._pictures = [];
        this._handlers = [];
        this._focus = 0;
        this._expanded = -1;
        this._lastTest = new Map();
        this._burstIds = [];

        const css = new Gtk.CssProvider();
        css.load_from_string(CSS);
        Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), css,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

        this._watch('changed', () => this._redraw());
        window.connect('close-request', () => {
            this._handlers.forEach(id => this._settings.disconnect(id));
            this._burstIds.forEach(id => GLib.source_remove(id));
            return false;
        });

        window.set_default_size(720, 900);
        window.add(this._appearancePage());
        window.add(this._appsPage());
        window.add(this._behaviorPage());
    }

    _watch(signal, callback) {
        this._handlers.push(this._settings.connect(signal, callback));
    }

    _redraw() {
        this._pictures.forEach(picture => picture.queue_draw());
    }

    _toast(title) {
        this._window.add_toast(new Adw.Toast({title, timeout: 3}));
    }

    _previewGroup() {
        const preview = new Preview(this);
        this._pictures.push(preview);
        const group = new Adw.PreferencesGroup();
        group.add(preview);
        return group;
    }

    // The front card shows the rule last opened on the Apps page; the cards
    // behind it show the rules after it.
    _sampleCards() {
        const rules = this._loadRules();
        const max = this._settings.get_int('max-cards');
        if (rules.length === 0)
            return [{name: 'App', color: null, countdown: SAMPLE_COUNTDOWNS[0]}];

        const focus = Math.min(this._focus, rules.length - 1);
        return Array.from({length: Math.min(max, rules.length)}, (_, i) => {
            const rule = rules[(focus + i) % rules.length];
            return {name: rule.name, color: parseHex(rule.color), countdown: SAMPLE_COUNTDOWNS[i]};
        });
    }

    _choiceRow(key, title, options) {
        // One choice is nothing to pick from; show it, ready for more.
        if (options.length === 1) {
            const row = new Adw.ActionRow({title, subtitle: 'The only one so far'});
            row.add_suffix(new Gtk.Label({label: options[0][1], css_classes: ['dim-label']}));
            return row;
        }

        const row = new Adw.ComboRow({
            title,
            model: Gtk.StringList.new(options.map(([, label]) => label)),
        });
        const sync = () => {
            row.selected = Math.max(0, options.findIndex(([value]) => value === this._settings.get_string(key)));
        };
        sync();
        row.connect('notify::selected', () => this._settings.set_string(key, options[row.selected][0]));
        this._watch(`changed::${key}`, sync);
        return row;
    }

    // A grid of picture buttons, one per option, that sets `key`.
    _pictureChoice(key, options, picture, columns = options.length) {
        const grid = new Gtk.Grid({column_spacing: 10, row_spacing: 10, column_homogeneous: true});
        const buttons = options.map(([value, label], index) => {
            const content = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6});
            const drawing = picture(value);
            this._pictures.push(drawing);
            content.append(drawing);
            content.append(new Gtk.Label({label}));

            const button = new Gtk.ToggleButton({child: content, css_classes: ['flat', 'bn-choice']});
            button.connect('toggled', () => {
                if (button.active)
                    this._settings.set_string(key, value);
            });
            grid.attach(button, index % columns, Math.floor(index / columns), 1, 1);
            return button;
        });
        buttons.slice(1).forEach(button => button.set_group(buttons[0]));

        const sync = () => {
            const index = options.findIndex(([value]) => value === this._settings.get_string(key));
            buttons[Math.max(0, index)].active = true;
        };
        sync();
        this._watch(`changed::${key}`, sync);
        return grid;
    }

    _scaleRow(key, title, step) {
        const [lower, upper] = this._settings.settings_schema.get_key(key).get_range().deepUnpack()[1].deepUnpack();
        const scale = new Gtk.Scale({
            adjustment: new Gtk.Adjustment({lower, upper, step_increment: step}),
            draw_value: true,
            value_pos: Gtk.PositionType.RIGHT,
            digits: 0,
            hexpand: true,
            width_request: 220,
            valign: Gtk.Align.CENTER,
        });
        scale.set_format_value_func((_scale, value) => `${value} px`);
        scale.set_value(this._settings.get_int(key));
        scale.connect('value-changed', () => {
            const value = Math.round(scale.get_value() / step) * step;
            if (value !== scale.get_value())
                scale.set_value(value);
            else if (value !== this._settings.get_int(key))
                this._settings.set_int(key, value);
        });
        this._watch(`changed::${key}`, () => scale.set_value(this._settings.get_int(key)));

        const row = new Adw.ActionRow({title});
        row.add_suffix(scale);
        return row;
    }

    _spinRow(key, title, subtitle, step) {
        const range = this._settings.settings_schema.get_key(key).get_range().deepUnpack()[1].deepUnpack();
        const row = Adw.SpinRow.new_with_range(range[0], range[1], step);
        row.title = title;
        row.subtitle = subtitle;
        this._settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _switchRow(key, title, subtitle) {
        const row = new Adw.SwitchRow({title, subtitle});
        this._settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _toggles(options, active) {
        const group = new Adw.ToggleGroup({valign: Gtk.Align.CENTER});
        for (const [value, label] of options)
            group.add(new Adw.Toggle({name: String(value), label}));
        group.active_name = String(active);
        return group;
    }

    _burstGroup(subtitle) {
        const row = new Adw.ActionRow({title: 'Send a test burst', subtitle});
        const button = new Gtk.Button({
            child: new Adw.ButtonContent({icon_name: 'mail-send-symbolic', label: 'Send burst'}),
            css_classes: ['suggested-action'],
            valign: Gtk.Align.CENTER,
        });
        button.connect('clicked', () => this._sendBurst());
        row.add_suffix(button);

        const group = new Adw.PreferencesGroup({title: 'Try it'});
        group.add(row);
        return group;
    }

    _appearancePage() {
        const page = new Adw.PreferencesPage({
            title: 'Appearance',
            icon_name: 'applications-graphics-symbolic',
        });
        page.add(this._previewGroup());

        const position = new Adw.PreferencesGroup({title: 'Position', description: 'Where banners appear.'});
        position.add(this._pictureChoice('position', Options.POSITIONS, value => this._screenPicture(value), 3));
        page.add(position);

        const material = new Adw.PreferencesGroup({title: 'Material'});
        material.add(this._pictureChoice('material', Options.MATERIALS, value =>
            new GlassSwatch(() => ({tone: this._settings.get_string('tone'), material: value}))));
        page.add(material);

        const tone = new Adw.PreferencesGroup({title: 'Tone'});
        tone.add(this._pictureChoice('tone', Options.TONES, value =>
            new GlassSwatch(() => ({tone: value, material: this._settings.get_string('material')}))));
        page.add(tone);

        const size = new Adw.PreferencesGroup({title: 'Text and size'});
        const textRow = new Adw.ActionRow({title: 'Text size'});
        const textSize = this._toggles(Options.TEXT_SIZES, this._settings.get_string('text-size'));
        this._settings.bind('text-size', textSize, 'active-name', Gio.SettingsBindFlags.DEFAULT);
        textRow.add_suffix(textSize);
        size.add(textRow);
        size.add(this._scaleRow('width', 'Width', 10));
        size.add(this._scaleRow('corner-radius', 'Corner radius', 1));
        page.add(size);

        const style = new Adw.PreferencesGroup({title: 'Style'});
        style.add(this._choiceRow('style', 'Color style', Options.STYLES));
        style.add(this._choiceRow('entrance', 'Entrance', Options.ENTRANCES));
        page.add(style);

        page.add(this._burstGroup(
            'Sends notifications from your first few app rules, then a critical one, to your desktop.'));
        return page;
    }

    // A small screen with a banner in the corner `value` names.
    _screenPicture(value) {
        const [vertical, horizontal] = value.split('-');
        return new Picture(56, (cr, width, height) => {
            const screenWidth = Math.min(width, height * 2.2);
            const x = (width - screenWidth) / 2;
            roundedPath(cr, x, 0, screenWidth, height, 7);
            setSource(cr, [27, 27, 31, 1]);
            cr.fillPreserve();
            cr.clip();
            setSource(cr, [255, 255, 255, 0.08]);
            cr.rectangle(x, 0, screenWidth, height * 0.08);
            cr.fill();

            const bannerWidth = screenWidth * 0.28;
            const bannerHeight = height * 0.18;
            const bannerX = horizontal === 'left' ? x + screenWidth * 0.05
                : horizontal === 'center' ? x + (screenWidth - bannerWidth) / 2
                    : x + screenWidth * 0.95 - bannerWidth;
            const bannerY = vertical === 'top' ? height * 0.16 : height * 0.9 - bannerHeight;
            roundedPath(cr, bannerX, bannerY, bannerWidth, bannerHeight, 3);
            if (this._settings.get_string('position') === value) {
                const accent = Adw.StyleManager.get_default().get_accent_color_rgba();
                cr.setSourceRGBA(accent.red, accent.green, accent.blue, 1);
            } else {
                setSource(cr, [255, 255, 255, 0.3]);
            }
            cr.fill();
        });
    }

    _behaviorPage() {
        const page = new Adw.PreferencesPage({
            title: 'Behavior',
            icon_name: 'preferences-system-symbolic',
        });
        page.add(this._previewGroup());

        const banners = new Adw.PreferencesGroup({
            title: 'Banners',
            description: 'Timers pause while the pointer is on the stack, and wait until you are back at the computer.',
        });

        const stackRow = new Adw.ActionRow({
            title: 'Stack size',
            subtitle: 'Most banners on screen at once. Past this, the oldest leaves early and stays in the list.',
        });
        const stack = this._toggles([1, 2, 3, 4, 5].map(n => [n, String(n)]), this._settings.get_int('max-cards'));
        stack.connect('notify::active-name', () => this._settings.set_int('max-cards', Number(stack.active_name)));
        this._watch('changed::max-cards', () => {
            stack.active_name = String(this._settings.get_int('max-cards'));
        });
        stackRow.add_suffix(stack);
        banners.add(stackRow);

        banners.add(this._spinRow('normal-timeout', 'Normal timeout', 'In seconds', 1));
        banners.add(this._spinRow('critical-timeout', 'Critical timeout', 'In seconds', 5));
        banners.add(this._switchRow('countdown', 'Show countdown',
            'A line on each banner that shrinks as its time runs out.'));
        banners.add(this._spinRow('rate-limit', 'Rate limit',
            'After an app shows a banner, its next notifications skip the banner ' +
            'for this many milliseconds and only go to the list. 0 turns it off.', 250));
        page.add(banners);

        const list = new Adw.PreferencesGroup({title: 'Notification list'});
        list.add(this._switchRow('group-by-app', 'Group notifications by app',
            'When off, every notification gets its own entry in the list.'));
        list.add(this._switchRow('style-list', 'Match the banners',
            'Entries take the banners’ app colors, tone, material, text size and corner ' +
            'radius. Frost shows as plain glass, since the menu is solid behind them.'));
        page.add(list);

        page.add(this._burstGroup('See the stack size, timeouts and countdown in action.'));
        return page;
    }

    _appsPage() {
        const page = new Adw.PreferencesPage({
            title: 'Apps',
            icon_name: 'view-list-symbolic',
        });
        page.add(this._previewGroup());

        this._rulesGroup = new Adw.PreferencesGroup({
            title: 'App rules',
            description: 'Checked from the top; the first rule that matches a notification ' +
                'decides its color and whether it shows. Patterns are case-insensitive ' +
                'regular expressions. Leave a pattern empty to match anything.',
        });

        const addButton = new Gtk.Button({
            child: new Adw.ButtonContent({icon_name: 'list-add-symbolic', label: 'Add rule'}),
            css_classes: ['flat'],
            valign: Gtk.Align.CENTER,
        });
        addButton.connect('clicked', () => {
            const rules = this._loadRules();
            this._expanded = this._focus = rules.length;
            this._saveRules([...rules, {...NEW_RULE}]);
        });
        this._rulesGroup.header_suffix = addButton;

        page.add(this._rulesGroup);

        this._ruleRows = [];
        this._watch('changed::rules', () => {
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
                subtitle: 'Every notification shows, in neutral glass. Use Add rule to make one.',
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
        const row = new Adw.ExpanderRow({title: rule.name, subtitle: describe(rule), subtitle_lines: 1});

        const dot = new Picture(14, (cr, width, height) => {
            cr.arc(width / 2, height / 2, 7, 0, 2 * Math.PI);
            setSource(cr, [...parseHex(rule.color) ?? [140, 200, 255], 1]);
            cr.fill();
        });
        Object.assign(dot, {hexpand: false, content_width: 14, valign: Gtk.Align.CENTER});
        row.add_prefix(dot);

        const chip = new Gtk.Label({css_classes: ['bn-chip'], valign: Gtk.Align.CENTER});
        const syncChip = () => {
            chip.visible = rule.action !== 'show';
            chip.label = rule.action === 'block' ? 'Blocked' : 'List only';
            if (rule.action === 'block')
                chip.add_css_class('blocked');
            else
                chip.remove_css_class('blocked');
        };
        syncChip();
        row.add_suffix(chip);

        const testButton = new Gtk.Button({
            child: new Adw.ButtonContent({icon_name: 'mail-send-symbolic', label: 'Test'}),
            css_classes: ['flat'],
            valign: Gtk.Align.CENTER,
        });
        testButton.connect('clicked', () => this._sendTest(index));
        row.add_suffix(testButton);

        const testRow = new Adw.ActionRow({title: 'Send a test', subtitle_lines: 1});
        const sendButton = new Gtk.Button({
            child: new Adw.ButtonContent({icon_name: 'mail-send-symbolic', label: 'Send'}),
            valign: Gtk.Align.CENTER,
        });
        sendButton.connect('clicked', () => this._sendTest(index));
        testRow.add_suffix(sendButton);

        const syncTest = () => {
            const test = testFor(rule);
            testButton.sensitive = sendButton.sensitive = !test.error;
            testButton.tooltip_text = test.error ?? `Send a test for ${rule.name}`;
            testRow.subtitle = test.error ?? `Sends app “${test.app}”, title “${test.title}”`;
        };
        syncTest();

        const name = new Adw.EntryRow({title: 'Name', text: rule.name, show_apply_button: true});
        name.connect('apply', () => {
            rule.name = name.text;
            row.title = rule.name;
            this._saveRules(rules, false);
            syncTest();
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
                syncTest();
            });
            row.add_row(entry);
        }

        const colorRow = new Adw.ActionRow({title: 'Color', subtitle: rule.color});
        const color = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({with_alpha: false}),
            valign: Gtk.Align.CENTER,
        });
        const initial = new Gdk.RGBA();
        if (initial.parse(rule.color ?? ''))
            color.rgba = initial;
        color.connect('notify::rgba', () => {
            const {red, green, blue} = color.rgba;
            rule.color = `#${[red, green, blue].map(channel =>
                Math.round(channel * 255).toString(16).padStart(2, '0')).join('')}`;
            colorRow.subtitle = rule.color;
            dot.queue_draw();
            this._saveRules(rules, false);
        });
        colorRow.add_suffix(color);
        row.add_row(colorRow);

        const actionRow = new Adw.ActionRow({title: 'Action'});
        const action = this._toggles(
            Options.RULE_ACTIONS.map(([value, label]) => [value, value === 'silence' ? 'List only' : label]),
            rule.action ?? 'show');
        action.connect('notify::active-name', () => {
            rule.action = action.active_name;
            syncChip();
            this._saveRules(rules, false);
        });
        actionRow.add_suffix(action);
        row.add_row(actionRow);

        row.add_row(testRow);

        const manage = new Adw.ActionRow({title: 'Order'});
        const move = (icon, tooltip, offset) => {
            const button = new Gtk.Button({
                icon_name: icon,
                tooltip_text: tooltip,
                has_frame: false,
                valign: Gtk.Align.CENTER,
                sensitive: rules[index + offset] !== undefined,
            });
            button.connect('clicked', () => {
                [rules[index + offset], rules[index]] = [rules[index], rules[index + offset]];
                this._expanded = this._focus = index + offset;
                this._saveRules(rules);
            });
            manage.add_suffix(button);
        };
        move('go-up-symbolic', 'Move up', -1);
        move('go-down-symbolic', 'Move down', 1);

        const remove = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            tooltip_text: 'Delete rule',
            has_frame: false,
            valign: Gtk.Align.CENTER,
        });
        remove.connect('clicked', () => {
            this._expanded = -1;
            this._focus = 0;
            this._saveRules(rules.filter((_, i) => i !== index));
        });
        manage.add_suffix(remove);
        row.add_row(manage);

        row.expanded = this._expanded === index;
        row.connect('notify::expanded', () => {
            if (row.expanded) {
                this._expanded = this._focus = index;
                this._redraw();
            } else if (this._expanded === index) {
                this._expanded = -1;
            }
        });

        return row;
    }

    // notify-send rather than a D-Bus call from here: the shell names a
    // notification after the window it comes from, which would make every
    // test "Extensions" instead of the app name the rule matches.
    _notify({app, title, body}, critical = false) {
        try {
            Gio.Subprocess.new([
                'notify-send', `--app-name=${app}`, ...critical ? ['--urgency=critical'] : [], '--', title, body,
            ], Gio.SubprocessFlags.NONE);
            return true;
        } catch (e) {
            this._toast(`Couldn't send the test: ${e.message}`);
            return false;
        }
    }

    // Sends the rule's test, then says what will happen to it. The checks
    // mirror the extension's, so a test that shows no banner says why.
    _sendTest(index) {
        const rules = this._loadRules();
        const rule = rules[index];
        const test = testFor(rule);
        if (test.error || !this._notify(test))
            return;

        const compiled = compileRules(JSON.stringify(rules));
        const match = matchRule(compiled, test.app, test.title, test.body);
        const now = Date.now();
        const last = this._lastTest.get(index);
        const rateLimit = this._settings.get_int('rate-limit');
        const banners = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'}).get_boolean('show-banners');

        if (match !== compiled[index]) {
            this._toast(match
                ? `Sent, but “${rules[compiled.indexOf(match)].name}” comes first and matched it`
                : `Sent, but “${rule.name}” didn't match it`);
        } else if (rule.action === 'block') {
            this._toast(`Sent. “${rule.name}” blocks it, so it won't show`);
        } else if (rule.action === 'silence') {
            this._toast(`Sent. “${rule.name}” puts it in the list without a banner`);
        } else if (!banners) {
            this._toast('Sent. Do Not Disturb is on, so it only went to the list');
        } else if (rateLimit > 0 && last !== undefined && now - last < rateLimit) {
            this._toast('Sent, but the rate limit kept it to the list. Try again in a moment');
            return;
        } else {
            this._toast(`Sent a test for ${rule.name}`);
        }
        this._lastTest.set(index, now);
    }

    // A few rules' tests, then a critical one, spaced out like a real burst.
    _sendBurst() {
        const tests = this._loadRules()
            .filter(rule => (rule.action ?? 'show') === 'show')
            .map(rule => testFor(rule))
            .filter(test => !test.error)
            .slice(0, BURST_RULES);
        const critical = {
            app: TEST_APP,
            title: 'Critical test',
            body: `Critical notifications stay for ${this._settings.get_int('critical-timeout')} seconds.`,
        };

        const sends = [...tests.map(test => () => this._notify(test)), () => this._notify(critical, true)];
        sends.forEach((send, i) => {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, i * BURST_DELAY, () => {
                this._burstIds.splice(this._burstIds.indexOf(id), 1);
                send();
                return GLib.SOURCE_REMOVE;
            });
            this._burstIds.push(id);
        });
        this._toast(`Sending ${sends.length} test notifications`);
    }
}
