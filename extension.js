import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {FdoNotificationDaemonSource} from 'resource:///org/gnome/shell/ui/notificationDaemon.js';

import {Deck} from './deck.js';
import {compileRules, matchRule} from './rules.js';

const {Urgency, NotificationDestroyedReason} = MessageTray;

export default class BetterGnomeNotificationsExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._settings.connectObject('changed::rules', () => this._loadRules(), this);
        this._loadRules();

        // The rule each notification matched, looked up again when its banner shows.
        this._ruleFor = new WeakMap();
        // When each sender last got a banner, for rate limiting.
        this._lastBanner = new Map();

        this._deck = new Deck(this._settings);

        this._injections = new InjectionManager();
        this._injectAddNotification();
        this._injectBanners();
        this._injectGrouping();
    }

    disable() {
        this._injections.clear();
        this._injections = null;

        this._deck.destroy();
        this._deck = null;

        this._settings.disconnectObject(this);
        this._settings = null;
        this._rules = null;
        this._ruleFor = null;
        this._lastBanner = null;
    }

    _loadRules() {
        this._rules = compileRules(this._settings.get_string('rules'));
    }

    // True when `sender` had a banner less than the rate limit ago. Only
    // banners that show restart the clock, so a steady stream still gets one
    // through every interval.
    _isRateLimited(sender) {
        const limit = this._settings.get_int('rate-limit');
        if (limit === 0)
            return false;

        const now = Date.now();
        const last = this._lastBanner.get(sender);
        if (last !== undefined && now - last < limit)
            return true;

        this._lastBanner.set(sender, now);
        return false;
    }

    // Applies rules and the rate limit as a notification arrives. Setting
    // `acknowledged` before the source asks for a banner skips the banner
    // while the notification still lands in the list.
    _injectAddNotification() {
        const extension = this;
        this._injections.overrideMethod(MessageTray.Source.prototype, 'addNotification',
            original => function (notification) {
                if (this.notifications.includes(notification)) {
                    original.call(this, notification);
                    return;
                }

                const rule = matchRule(extension._rules, this.title, notification.title, notification.body);
                if (rule)
                    extension._ruleFor.set(notification, rule);

                // Web apps all arrive as the browser, so a matched rule
                // counts as its own sender: WhatsApp doesn't hold up Gmail.
                const sender = rule?.id ?? this.title;
                const action = rule?.action ?? 'show';
                if (action !== 'show' ||
                    (notification.urgency !== Urgency.CRITICAL && extension._isRateLimited(sender)))
                    notification.acknowledged = true;

                original.call(this, notification);

                // Added first so the source tidies itself up once it is empty.
                if (action === 'block')
                    notification.destroy(NotificationDestroyedReason.DISMISSED);
            });
    }

    // Sends banners to the deck instead of the tray's single banner. The
    // checks mirror gnome-shell's own _onNotificationRequestBanner and
    // _updateState: Do Not Disturb and fullscreen let only critical
    // notifications through.
    _injectBanners() {
        const extension = this;
        this._injections.overrideMethod(MessageTray.MessageTray.prototype, '_onNotificationRequestBanner',
            () => function (_source, notification) {
                if (notification.acknowledged || notification.urgency === Urgency.LOW)
                    return;
                if (!notification.source.policy.showBanners && notification.urgency !== Urgency.CRITICAL)
                    return;
                if (!Main.sessionMode.hasNotifications)
                    return;

                const limited = this._busy || Main.layoutManager.primaryMonitor?.inFullscreen;
                if (limited && !notification.forFeedback && notification.urgency !== Urgency.CRITICAL)
                    return;

                extension._deck.add(notification, extension._ruleFor.get(notification)?.color ?? null);
            });
    }

    // GNOME keeps one source per app, which the notification list shows as a
    // group. With grouping off, every notification gets a fresh source.
    _injectGrouping() {
        const extension = this;
        const daemon = Main.notificationDaemon._fdoNotificationDaemon;

        this._injections.overrideMethod(daemon, '_getSourceForApp',
            original => function (sender, app) {
                if (extension._settings.get_boolean('group-by-app'))
                    return original.call(this, sender, app);
                const source = new FdoNotificationDaemonSource(sender, app);
                Main.messageTray.add(source);
                return source;
            });

        this._injections.overrideMethod(daemon, '_getSourceForPidAndName',
            original => function (sender, pid, appName) {
                if (extension._settings.get_boolean('group-by-app'))
                    return original.call(this, sender, pid, appName);
                const source = new FdoNotificationDaemonSource(sender, null);
                Main.messageTray.add(source);
                return source;
            });
    }
}
