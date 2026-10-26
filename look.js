// How a banner looks: its fill, color style and style classes.

// The banner's horizontal padding plus border in stylesheet.css. St adds them
// on top of the CSS width, so they come off the width setting.
const BANNER_CHROME = 24;

// A full stack is this much taller than its front card; the extra height is
// shared out between the cards behind, so more cards means thinner edges.
export const SPREAD = 0.3;
// Each card further back is this much narrower.
export const SHRINK = 0.05;

// The banner's base fill as [r, g, b, alpha], by tone and material. `stacked`
// is for cards that aren't in front: they skip the blur, so they need a
// denser fill to stay readable.
export const GLASS = {
    dark: {
        solid: [40, 42, 49, 1],
        translucent: [40, 42, 49, 0.78],
        frost: [40, 42, 49, 0.55],
        stacked: [40, 42, 49, 0.86],
    },
    light: {
        solid: [246, 247, 250, 1],
        translucent: [246, 247, 250, 0.82],
        frost: [246, 247, 250, 0.62],
        stacked: [246, 247, 250, 0.9],
    },
};

// Color styles: each turns the base fill and the app's color (null when no
// rule gives one) into the banner's background as St CSS.
const STYLES = {
    tint: (glass, color) => {
        if (!color)
            return `background-color: ${rgba(glass)};`;
        return 'background-gradient-direction: horizontal;' +
            `background-gradient-start: ${rgba(tintStart(glass, color))};` +
            `background-gradient-end: ${rgba(glass)};`;
    },
};

// The colored end of the tint, which fades into the glass. It is a little
// more opaque than the glass, so the wash still reads over a busy desktop.
export function tintStart(glass, color) {
    const start = mix(glass, color, 0.55);
    start[3] = Math.min(1, glass[3] + 0.15);
    return start;
}

export function parseHex(hex) {
    const match = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
    if (!match)
        return null;
    const value = parseInt(match[1], 16);
    return [value >> 16, (value >> 8) & 0xff, value & 0xff];
}

function mix(glass, color, amount) {
    const channels = color.map((channel, i) => Math.round(glass[i] + (channel - glass[i]) * amount));
    return [...channels, glass[3]];
}

function rgba([r, g, b, a]) {
    return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/**
 * Style a banner for its place in the deck.
 *
 * @param {St.Widget} banner - The NotificationMessage to style.
 * @param {Gio.Settings} settings - The extension's settings.
 * @param {object} params - What the banner shows.
 * @param {number[]|null} params.color - The app's color from its rule, as [r, g, b].
 * @param {boolean} params.critical - Whether the notification is critical.
 * @param {boolean} params.front - Whether the banner is the deck's front card.
 * @param {boolean} params.overOverview - Whether the overview is behind it.
 * @returns {string} The material the banner ended up with; 'frost' means it
 *   needs a frosted backdrop.
 */
export function styleBanner(banner, settings, {color, critical, front, overOverview}) {
    const tone = settings.get_string('tone');
    const style = STYLES[settings.get_string('style')] ?? STYLES.tint;

    let material = settings.get_string('material');
    if (material === 'frost' && !front)
        material = 'stacked';
    // The frosted backdrop blurs the windows, so over the overview it would
    // show the desktop instead of what's really behind the banner.
    else if (material === 'frost' && overOverview)
        material = 'translucent';

    banner.set_style_class_name([
        'message', 'notification-banner', 'bn-banner',
        `bn-${tone}`, `bn-${material}`, `bn-text-${settings.get_string('text-size')}`,
        ...critical ? ['bn-critical'] : [],
    ].join(' '));
    banner.set_style(
        `width: ${settings.get_int('width') - BANNER_CHROME}px;` +
        `border-radius: ${settings.get_int('corner-radius')}px;` +
        style(GLASS[tone][material], color));

    return material;
}
