// App rules: reading them from settings and matching a notification against
// them. Shared by the extension and its preferences, so it must not import
// anything from the shell.

import {parseHex} from './look.js';

export function compileRules(json) {
    let rules;
    try {
        rules = JSON.parse(json);
    } catch (e) {
        console.warn(`Better GNOME Notifications: ignoring unreadable rules: ${e.message}`);
        return [];
    }

    const compile = pattern => {
        if (!pattern)
            return null;
        try {
            return new RegExp(pattern, 'i');
        } catch (e) {
            console.warn(`Better GNOME Notifications: ignoring bad pattern ${pattern}: ${e.message}`);
            return /$^/;
        }
    };

    return rules.map((rule, index) => ({
        id: `rule ${index}`,
        action: rule.action ?? 'show',
        color: parseHex(rule.color),
        app: compile(rule.app),
        title: compile(rule.title),
        body: compile(rule.body),
    }));
}

// The first rule every non-empty pattern of which matches, or null.
export function matchRule(rules, appName, title, body) {
    return rules.find(rule =>
        (!rule.app || rule.app.test(appName ?? '')) &&
        (!rule.title || rule.title.test(title ?? '')) &&
        (!rule.body || rule.body.test(body ?? ''))) ?? null;
}
