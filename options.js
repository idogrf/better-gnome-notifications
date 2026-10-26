// Every choice the settings offer, as [value, label] in the order the settings
// window lists them. Shared by the extension and its preferences, so it must
// not import anything from the shell.
//
// To add a color style or an entrance: list it here, add it to the key's
// <choices> in the schema, and implement it in the matching table in
// extension.js (STYLES or ENTRANCES).

export const STYLES = [
    ['tint', 'Tinted glass'],
];

export const POSITIONS = [
    ['top-left', 'Top left'],
    ['top-center', 'Top center'],
    ['top-right', 'Top right'],
    ['bottom-left', 'Bottom left'],
    ['bottom-center', 'Bottom center'],
    ['bottom-right', 'Bottom right'],
];

export const MATERIALS = [
    ['solid', 'Solid'],
    ['translucent', 'Translucent'],
    ['frost', 'Frosted'],
];

export const TONES = [
    ['dark', 'Dark'],
    ['light', 'Light'],
];

export const TEXT_SIZES = [
    ['small', 'Small'],
    ['medium', 'Medium'],
];

export const ENTRANCES = [
    ['slide', 'Slide in'],
];

export const RULE_ACTIONS = [
    ['show', 'Show'],
    ['silence', 'List only, no banner'],
    ['block', 'Block'],
];
