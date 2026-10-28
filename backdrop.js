import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

const BLUR_RADIUS = 30;
const BLUR_BRIGHTNESS = 0.85;

// The blur samples this far past the banner's edges, so the edges blur
// against real desktop pixels instead of fading into transparency.
const BLEED = BLUR_RADIUS;

// How far the mask pulls in from the banner's edge, so the blur stays inside
// the banner's 1px border instead of peeking past its antialiased corners.
const MASK_INSET = 1;

// Masks whatever its actor paints to a rounded rectangle with antialiased
// corners, using the rectangle's signed distance field.
const RoundedMask = GObject.registerClass(
class RoundedMask extends Shell.GLSLEffect {
    constructor(radius) {
        super();
        this._radius = radius;
        this._sizeLocation = this.get_uniform_location('mask_size');
        this._radiusLocation = this.get_uniform_location('mask_radius');
        this._insetLocation = this.get_uniform_location('mask_inset');
    }

    vfunc_build_pipeline() {
        const declarations = `
            uniform sampler2D tex;
            uniform vec2 mask_size;
            uniform float mask_radius;
            uniform float mask_inset;
        `;
        const source = `
            vec2 point = cogl_tex_coord_in[0].xy * mask_size;
            float radius = max(mask_radius - mask_inset, 0.0);
            vec2 corner = abs(point - 0.5 * mask_size) - (0.5 * mask_size - mask_inset - radius);
            float outside = length(max(corner, 0.0)) + min(max(corner.x, corner.y), 0.0) - radius;
            float coverage = clamp(0.5 - outside, 0.0, 1.0);
            cogl_color_out = cogl_color_in * texture2D(tex, cogl_tex_coord_in[0].xy) * coverage;
        `;
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, declarations, source, true);
    }

    vfunc_paint_target(node, paintContext) {
        this.set_uniform_float(this._sizeLocation, 2, [this.actor.width, this.actor.height]);
        this.set_uniform_float(this._radiusLocation, 1, [this._radius]);
        this.set_uniform_float(this._insetLocation, 1, [MASK_INSET]);
        super.vfunc_paint_target(node, paintContext);
    }
});

/**
 * A blurred view of the windows and wallpaper behind a banner.
 *
 * GNOME's background blur can't be rounded: masking it needs an offscreen
 * pass, and an offscreen pass hides the framebuffer the blur reads from. So
 * this blurs a live clone of the window group instead, offset so the part
 * under the banner lines up with the real desktop, and masks that.
 *
 * Add `actor` to the banner's parent below the banner; it follows the
 * banner's allocation, and the clone follows `mover`'s movement.
 */
export class FrostedBackdrop {
    constructor(banner, radius, mover) {
        this.actor = new Clutter.Actor({clip_to_allocation: true});
        this.actor.add_effect(new RoundedMask(radius));
        this.actor.add_constraint(new Clutter.BindConstraint({
            source: banner,
            coordinate: Clutter.BindCoordinate.ALL,
        }));

        // Clipped to its allocation so the blur only processes the area
        // around the banner, not the whole clone.
        this._pane = new Clutter.Actor({clip_to_allocation: true, x: -BLEED, y: -BLEED});
        this._resizeId = 0;
        this._pane.add_effect(new Shell.BlurEffect({
            mode: Shell.BlurMode.ACTOR,
            radius: BLUR_RADIUS,
            brightness: BLUR_BRIGHTNESS,
        }));
        this.actor.add_child(this._pane);

        this._clone = new Clutter.Clone({source: global.window_group});
        this._pane.add_child(this._clone);

        this.actor.connect('notify::allocation', () => this._sync());
        this.actor.connect('destroy', () => {
            if (this._resizeId)
                global.compositor.get_laters().remove(this._resizeId);
            this._resizeId = 0;
        });
        mover.connectObject(
            'notify::translation-x', () => this._sync(),
            'notify::translation-y', () => this._sync(),
            'notify::allocation', () => this._sync(),
            this.actor);
    }

    _sync() {
        // While the banner is torn down the transformed position is NaN.
        const [x, y] = this.actor.get_transformed_position();
        if (!Number.isFinite(x) || !Number.isFinite(y))
            return;
        // This runs during allocation and on every frame of an animation, so
        // the clone moves by translation, which needs no relayout, and the
        // pane is resized before the next frame's layout instead of now:
        // resizing from inside a layout leaves the backdrop waiting for an
        // allocation, and Clutter warns about it.
        this._clone.set_translation(BLEED - x, BLEED - y, 0);
        if (this._resizeId === 0 && !this._fits()) {
            this._resizeId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
                this._resizeId = 0;
                this._pane.set_size(this.actor.width + 2 * BLEED, this.actor.height + 2 * BLEED);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _fits() {
        return this._pane.width === this.actor.width + 2 * BLEED &&
            this._pane.height === this.actor.height + 2 * BLEED;
    }

    destroy() {
        this.actor.destroy();
    }
}
