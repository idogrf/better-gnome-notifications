import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageList from 'resource:///org/gnome/shell/ui/messageList.js';
import {NotificationDestroyedReason, Urgency} from 'resource:///org/gnome/shell/ui/messageTray.js';

import {FrostedBackdrop} from './backdrop.js';
import {SHRINK, SPREAD, styleBanner} from './look.js';

const MOVE_TIME = 380;
const EXIT_TIME = 260;
const BODY_FADE_TIME = 180;

// Space between cards when the deck fans out.
const GAP = 8;
// How long the pointer can be off the deck before it folds back, so moving
// across the gap between fanned cards doesn't fold it.
const FOLD_DELAY = 300;
// Like gnome-shell: a user idle for longer than this hasn't seen a banner yet,
// so its timer waits until they're back.
const IDLE_TIME = 1000;

// Entrances: each gives a card's off-screen offset, which it slides in from
// and out to. `side` is -1 for a left deck, 1 for a right one and 0 for a
// centered one; `edge` is -1 at the top, 1 at the bottom.
const ENTRANCES = {
    slide: ({side, edge, width, height}) => side
        ? {translation_x: side * width, translation_y: 0, opacity: 255}
        : {translation_x: 0, translation_y: edge * height, opacity: 0},
};

const ON_SCREEN = {translation_x: 0, translation_y: 0, opacity: 255};

// One notification's banner and its timer.
class Card {
    constructor(notification, color) {
        this.notification = notification;
        this.color = color;
        this.critical = notification.urgency === Urgency.CRITICAL;

        this.banner = new MessageList.NotificationMessage(notification);
        this.banner.can_focus = false;
        this.banner._header.expandButton.visible = false;

        this.countdown = new St.Widget({style_class: 'bn-countdown', x_expand: true});
        this.countdown.set_pivot_point(0, 0.5);
        this.banner.child.add_child(this.countdown);

        // Hover is tracked on the whole card, so the deck can tell when the
        // pointer is anywhere on it.
        this.actor = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            track_hover: true,
        });
        this.actor.add_child(this.banner);

        // The card's drop shadow, drawn by a rounded widget with no fill
        // under the banner. On the banner itself St draws a square shadow
        // (its fill is a gradient or see-through), which shows around the
        // corners and through the glass.
        this.shadow = new St.Widget({style_class: 'bn-card-shadow'});
        this.shadow.add_constraint(new Clutter.BindConstraint({
            source: this.banner,
            coordinate: Clutter.BindCoordinate.ALL,
        }));
        this.actor.insert_child_below(this.shadow, this.banner);

        this.backdrop = null;
        this.front = null;
        this.total = 0;
        this.remaining = 0;
        this.startedAt = 0;
        this.timeoutId = 0;
    }
}

/**
 * The stack of banners in a corner of the primary monitor.
 *
 * Takes over from the message tray's single banner: up to `max-cards` cards,
 * newest in front, each leaving when its own timer runs out. Hovering the
 * deck fans it out and pauses every timer.
 */
export class Deck {
    constructor(settings) {
        this._settings = settings;
        this._cards = [];
        this._fanned = false;
        this._foldId = 0;
        this._userWatchId = 0;
        this._layoutLaterId = 0;
        this._unredirectDisabled = false;
        this._idleMonitor = global.backend.get_core_idle_monitor();

        // Covers the work area but isn't reactive, so clicks between the
        // cards reach the windows underneath.
        this.actor = new St.Widget({name: 'bn-deck', visible: false});
        this.actor.add_constraint(new Layout.MonitorConstraint({primary: true, work_area: true}));
        Main.layoutManager.addChrome(this.actor);

        Main.panel.statusArea.dateMenu.menu.connectObject(
            'open-state-changed', () => this._updateVisible(), this);
        Main.sessionMode.connectObject('updated', () => {
            if (!Main.sessionMode.hasNotifications)
                this.clear();
        }, this);
        this._settings.connectObject(
            'changed::max-cards', () => this._trim(),
            'changed::countdown', () => this._cards.forEach(card => this._styleCard(card)),
            'changed', () => this.restyle(),
            this);
    }

    destroy() {
        this.clear(false);
        this._settings.disconnectObject(this);
        Main.panel.statusArea.dateMenu.menu.disconnectObject(this);
        Main.sessionMode.disconnectObject(this);
        if (this._foldId)
            GLib.source_remove(this._foldId);
        if (this._userWatchId)
            this._idleMonitor.remove_watch(this._userWatchId);
        if (this._layoutLaterId)
            global.compositor.get_laters().remove(this._layoutLaterId);
        this._setUnredirect(true);
        Main.layoutManager.removeChrome(this.actor);
        this.actor.destroy();
    }

    // Shows `notification`, or brings it back to the front with a fresh
    // timer if it's already showing and was updated.
    add(notification, color) {
        notification.acknowledged = true;
        notification.playSound();

        const shown = this._cards.find(card => card.notification === notification);
        if (shown) {
            this._stopTimer(shown);
            this._cards.splice(this._cards.indexOf(shown), 1);
            this._cards.unshift(shown);
            this._startCountdown(shown);
            this._layout();
            return;
        }

        const card = new Card(notification, color);
        card.banner.connectObject(
            'close', () => this._remove(card),
            'notify::hover', () => this._onBannerHover(card),
            'notify::height', () => this._queueLayout(),
            this);
        notification.connectObject('activated', () => this._remove(card), card.actor);
        card.actor.connect('notify::hover', () => this._onHover());
        // A right click clears the card, as its close button does. Handled
        // on press: the banner's click gesture takes every button and
        // claims the release, so a release never reaches the card.
        card.actor.connect('button-press-event', (_actor, event) => {
            if (event.get_button() !== Clutter.BUTTON_SECONDARY)
                return Clutter.EVENT_PROPAGATE;
            card.banner.close();
            return Clutter.EVENT_STOP;
        });

        this.actor.add_child(card.actor);
        this._cards.unshift(card);
        this._styleCard(card);

        if (card.critical || notification.source.policy.forceExpanded)
            card.banner.expand(false);

        // Start at its resting place, off-screen, then slide in from there.
        this._layout(false, card);
        Object.assign(card.actor, this._offscreen(card));
        card.actor.ease({
            ...ON_SCREEN,
            duration: MOVE_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUINT,
        });

        if (this._idleMonitor.get_idletime() > IDLE_TIME)
            this._waitForUser();
        this._startCountdown(card);

        this._trim();
        this._layout();
        this._updateVisible();
    }

    // Removes every banner at once, without animation; the notifications
    // stay in the list.
    clear(updateVisible = true) {
        for (const card of this._cards) {
            this._stopTimer(card);
            card.actor.destroy();
        }
        this._cards = [];
        this._fanned = false;
        if (updateVisible)
            this._updateVisible();
    }

    // Reapplies the look and layout, after a setting changed.
    restyle() {
        for (const card of this._cards)
            card.front = null;
        this._cards.forEach(card => this._styleCard(card));
        this._layout();
    }

    _geometry(card) {
        const [edge, side] = this._settings.get_string('position').split('-');
        const [, width] = card.actor.get_preferred_width(-1);
        const [, height] = card.actor.get_preferred_height(width);
        return {
            side: {left: -1, center: 0, right: 1}[side],
            edge: {top: -1, bottom: 1}[edge],
            width,
            height,
        };
    }

    _offscreen(card) {
        const entrance = ENTRANCES[this._settings.get_string('entrance')] ?? ENTRANCES.slide;
        return entrance(this._geometry(card));
    }

    // Applies the card's look for where it sits: the front card is frosted
    // and shows its content, the ones behind are plain glass and only show
    // an edge until the deck fans out.
    _styleCard(card) {
        const front = this._cards[0] === card;
        const showBody = front || this._fanned;

        if (card.front !== front) {
            card.front = front;
            const material = styleBanner(card.banner, this._settings, {
                color: card.color,
                critical: card.critical,
                front,
                overOverview: Main.overview.visible,
            });

            const radius = this._settings.get_int('corner-radius');
            card.shadow.set_style(`border-radius: ${radius}px;`);
            card.shadow.set_style_class_name([
                'bn-card-shadow',
                ...front ? [] : ['bn-behind'],
                ...card.critical ? ['bn-critical'] : [],
            ].join(' '));

            if (material === 'frost' && !card.backdrop) {
                card.backdrop = new FrostedBackdrop(card.banner, radius, card.actor);
                card.actor.insert_child_above(card.backdrop.actor, card.shadow);
            } else if (material !== 'frost' && card.backdrop) {
                card.backdrop.destroy();
                card.backdrop = null;
            }
        }

        card.countdown.visible = this._settings.get_boolean('countdown');
        card.banner.child.ease({
            opacity: showBody ? 255 : 0,
            duration: BODY_FADE_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    // Places every card: stacked with the older ones peeking out behind the
    // front one, or fanned out in a column. `only` limits it to one card,
    // placed without animation.
    _layout(animate = true, only = null) {
        // The deck sits on the work area; read its size from the layout
        // manager, since the deck has none while it's hidden.
        const {width: workWidth, height: workHeight} =
            Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
        const max = this._settings.get_int('max-cards');
        const heights = this._cards.map(card => card.banner.height);
        const frontHeight = heights[0] ?? 0;
        const peek = max > 1 ? SPREAD * frontHeight / (max - 1) : 0;

        let offset = 0;
        this._cards.forEach((card, i) => {
            let y = 0;
            let scale = 1;
            if (this._fanned) {
                y = offset;
                offset += heights[i] + GAP;
            } else if (i > 0) {
                scale = 1 - SHRINK * i;
                y = frontHeight + peek * i - heights[i] * scale;
            }

            if (only && card !== only)
                return;

            const {side, edge, width, height} = this._geometry(card);
            const x = side < 0 ? 0 : side > 0 ? workWidth - width : Math.round((workWidth - width) / 2);
            card.actor.set_pivot_point(0.5, edge < 0 ? 0 : 1);
            card.actor.ease({
                x,
                y: edge < 0 ? y : workHeight - height - y,
                scale_x: scale,
                scale_y: scale,
                duration: animate ? MOVE_TIME : 0,
                mode: Clutter.AnimationMode.EASE_OUT_QUINT,
            });
        });

        // Front card on top.
        for (const card of [...this._cards].reverse())
            this.actor.set_child_above_sibling(card.actor, null);
        this._cards.forEach(card => this._styleCard(card));
    }

    // Lays out again once a banner's height settles, e.g. after it expands.
    _queueLayout() {
        if (this._layoutLaterId)
            return;
        this._layoutLaterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._layoutLaterId = 0;
            this._layout();
            return GLib.SOURCE_REMOVE;
        });
    }

    _remove(card, expired = false) {
        const index = this._cards.indexOf(card);
        if (index === -1)
            return;

        this._cards.splice(index, 1);
        this._stopTimer(card);
        card.banner.disconnectObject(this);
        card.actor.reactive = false;
        card.actor.ease({
            ...this._offscreen(card),
            duration: EXIT_TIME,
            mode: Clutter.AnimationMode.EASE_IN_CUBIC,
            onStopped: () => {
                card.actor.destroy();
                this._updateVisible();
            },
        });

        // Like gnome-shell, a transient notification is gone once its banner is.
        if (expired && card.notification.isTransient)
            card.notification.destroy(NotificationDestroyedReason.EXPIRED);

        // A card stops reporting the pointer once it's removed, so if it was
        // the one under the pointer the deck would never hear the pointer
        // leave, and would stay fanned with every timer paused.
        this._onHover();
        this._layout();
    }

    _trim() {
        const max = this._settings.get_int('max-cards');
        while (this._cards.length > max)
            this._remove(this._cards[this._cards.length - 1], true);
    }

    _paused() {
        return this._fanned || this._userWatchId !== 0;
    }

    _startCountdown(card) {
        card.total = 1000 * this._settings.get_int(card.critical ? 'critical-timeout' : 'normal-timeout');
        card.remaining = card.total;
        card.countdown.remove_all_transitions();
        card.countdown.scale_x = 1;
        this._startTimer(card);
    }

    _startTimer(card) {
        if (card.timeoutId || this._paused())
            return;

        card.startedAt = GLib.get_monotonic_time();
        card.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(1, Math.round(card.remaining)), () => {
            card.timeoutId = 0;
            this._remove(card, true);
            return GLib.SOURCE_REMOVE;
        });
        card.countdown.ease({
            scale_x: 0,
            duration: card.remaining,
            mode: Clutter.AnimationMode.LINEAR,
        });
    }

    _stopTimer(card) {
        if (!card.timeoutId)
            return;

        GLib.source_remove(card.timeoutId);
        card.timeoutId = 0;
        card.remaining -= (GLib.get_monotonic_time() - card.startedAt) / 1000;
        card.countdown.remove_all_transitions();
        card.countdown.scale_x = Math.max(0, card.remaining / card.total);
    }

    _waitForUser() {
        if (this._userWatchId)
            return;

        this._cards.forEach(card => this._stopTimer(card));
        this._userWatchId = this._idleMonitor.add_user_active_watch(() => {
            this._userWatchId = 0;
            this._cards.forEach(card => this._startTimer(card));
        });
    }

    _onHover() {
        const hovered = this._cards.some(card => card.actor.hover);

        if (hovered) {
            if (this._foldId) {
                GLib.source_remove(this._foldId);
                this._foldId = 0;
            }
            if (!this._fanned) {
                this._fanned = true;
                this._cards.forEach(card => this._stopTimer(card));
                this._layout();
            }
        } else if (this._fanned && !this._foldId) {
            this._foldId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FOLD_DELAY, () => {
                this._foldId = 0;
                this._fanned = false;
                this._cards.forEach(card => {
                    if (!card.critical)
                        card.banner.unexpand(true);
                    this._startTimer(card);
                });
                this._layout();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    // Like gnome-shell's banner, the card under the pointer expands to show
    // its full body and buttons.
    _onBannerHover(card) {
        if (card.banner.hover && this._fanned)
            card.banner.expand(true);
    }

    _updateVisible() {
        const menuOpen = Main.panel.statusArea.dateMenu.menu.isOpen;
        const visible = this.actor.get_n_children() > 0 && !menuOpen;
        this.actor.visible = visible;
        // Like gnome-shell: keep fullscreen windows composited while banners
        // are up, so the banners can draw on top of them.
        this._setUnredirect(!visible);
    }

    _setUnredirect(enabled) {
        if (enabled === !this._unredirectDisabled)
            return;
        this._unredirectDisabled = !enabled;
        if (enabled)
            global.compositor.enable_unredirect();
        else
            global.compositor.disable_unredirect();
    }
}
