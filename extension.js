import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageList from 'resource:///org/gnome/shell/ui/messageList.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {FdoNotificationDaemonSource} from 'resource:///org/gnome/shell/ui/notificationDaemon.js';

import {Deck} from './deck.js';
import {styleListed, unstyleListed} from './look.js';
import {compileRules, matchRule} from './rules.js';

const {Urgency, NotificationDestroyedReason} = MessageTray;

// Settings the notification list's entries are restyled for.
const LIST_KEYS = ['style-list', 'rules', 'style', 'tone', 'material', 'text-size', 'corner-radius'];

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

        // Notifications that arrived while the screen was locked, shown once
        // it unlocks. The extension keeps running while locked for this: if
        // it were disabled, gnome-shell's own tray would queue them and show
        // them as stock banners on unlock.
        this._held = [];
        Main.sessionMode.connectObject('updated', () => this._showHeld(), this);

        this._injections = new InjectionManager();
        this._injectAddNotification();
        this._injectBanners();
        this._injectGrouping();
        this._injectList();

        this._settings.connectObject('changed', (_, key) => {
            if (LIST_KEYS.includes(key))
                this._styleList();
        }, this);
        this._styleList();
    }

    disable() {
        this._listMessages().forEach(unstyleListed);

        this._injections.clear();
        this._injections = null;

        this._deck.destroy();
        this._deck = null;

        Main.sessionMode.disconnectObject(this);
        this._held = null;

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
                if (Main.sessionMode.isLocked) {
                    extension._hold(notification);
                    return;
                }
                if (!Main.sessionMode.hasNotifications)
                    return;

                const limited = this._busy || Main.layoutManager.primaryMonitor?.inFullscreen;
                if (limited && !notification.forFeedback && notification.urgency !== Urgency.CRITICAL)
                    return;

                extension._deck.add(notification, extension._ruleFor.get(notification)?.color ?? null);
            });
    }

    // Only the newest few are kept: the deck couldn't show more at once.
    _hold(notification) {
        if (this._held.includes(notification))
            return;
        this._held.push(notification);
        this._held.splice(0, this._held.length - this._settings.get_int('max-cards'));
    }

    // Requests banners for the held notifications again, oldest first so the
    // newest ends up in front, skipping any dismissed or read while locked.
    _showHeld() {
        if (!Main.sessionMode.hasNotifications || this._held.length === 0)
            return;

        const held = this._held;
        this._held = [];
        for (const notification of held) {
            if (notification.source?.notifications.includes(notification))
                Main.messageTray._onNotificationRequestBanner(notification.source, notification);
        }
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

    // Styles each entry the notification list adds like a banner.
    _injectList() {
        const extension = this;
        this._injections.overrideMethod(MessageList.NotificationMessageGroup.prototype, '_addNotification',
            original => function (notification) {
                original.call(this, notification);
                const message = this._notificationToMessage.get(notification);
                if (message)
                    extension._styleMessage(message);
            });
    }

    // The entries in the date menu's notification list. The list keeps one
    // group per source, which holds that source's notifications.
    _listMessages() {
        const view = Main.panel.statusArea.dateMenu?._messageList?._messageView;
        if (!view)
            return [];
        return [...view._notificationSourceToGroup.values()]
            .flatMap(group => [...group._notificationToMessage.values()]);
    }

    _styleList() {
        this._listMessages().forEach(message => this._styleMessage(message));
    }

    // Matched afresh rather than with the rule kept from arrival, so an
    // edited rule recolors what's already in the list.
    _styleMessage(message) {
        const notification = message.notification;
        if (!notification || !this._settings.get_boolean('style-list')) {
            unstyleListed(message);
            return;
        }

        const rule = matchRule(this._rules, notification.source?.title, notification.title, notification.body);
        styleListed(message, this._settings, {
            color: rule?.color ?? null,
            critical: notification.urgency === Urgency.CRITICAL,
        });
    }
}
