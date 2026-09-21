/** @odoo-module **/

import { Component, onWillUnmount, useRef, useState, xml } from "@odoo/owl";
import { _t } from "@web/core/l10n/translation";

/**
 * Period selection as a two-handle slider with a playback control.
 *
 * The slider snaps to month boundaries rather than free days. That is not a
 * simplification but the analytically correct granularity: revenue comparisons
 * run over months, quarters and years, and a day-precise slider mostly produces
 * periods that cannot be compared sensibly.
 *
 * Behind the handles sits the revenue curve of the entire history, so choosing
 * a period is not blind: seasonality and outliers are visible before you pick.
 *
 * Playback is *not* driven from here. This component only reports the toggle;
 * the dashboard advances the window and waits for each request to finish before
 * the next step. Driving it from a timer here would queue requests faster than
 * the server answers them.
 */
export class TimeRangeSlider extends Component {
    static template = xml`
<div class="o_geo_slider">
        <div class="o_geo_slider_header">
            <div class="d-flex align-items-center gap-2">
                <button class="btn btn-sm o_geo_play"
                        t-att-class="props.playing ? 'btn-primary' : 'btn-outline-primary'"
                        t-att-title="playTitle"
                        t-on-click="onPlayToggle">
                    <i t-att-class="props.playing ? 'fa fa-pause' : 'fa fa-play'"/>
                </button>
                <div>
                    <span class="o_geo_slider_label"><t t-esc="label"/></span>
                    <span class="text-muted ms-2">
                        <t t-esc="monthCountLabel"/>
                        · <t t-esc="props.formatValue(selectedAmount)"/>
                    </span>
                </div>
            </div>
            <div class="btn-group btn-group-sm">
                <button t-foreach="presets" t-as="preset" t-key="preset.key"
                        class="btn"
                        t-att-class="isPresetActive(preset.key) ? 'btn-primary' : 'btn-outline-secondary'"
                        t-on-click="() => this.applyPreset(preset.key)">
                    <t t-esc="preset.label"/>
                </button>
            </div>
        </div>

        <!-- The revenue curve and the slider share one area: the bars show
             monthly revenue, the selection highlights the active span. -->
        <div class="o_geo_slider_track" t-ref="track"
             t-on-pointerdown="onTrackDown"
             t-on-pointermove="onPointerMove"
             t-on-pointerup="onPointerUp"
             t-on-pointercancel="onPointerUp">

            <div class="o_geo_spark">
                <div t-foreach="bars" t-as="bar" t-key="bar.index"
                     class="o_geo_spark_bar"
                     t-att-class="{ 'o_geo_spark_bar_active': bar.active }"
                     t-attf-style="left: {{bar.left}}%; width: {{bar.width}}%; height: {{bar.height}}%"
                     t-att-title="bar.period.key"/>
            </div>

            <div class="o_geo_slider_rail"/>
            <div class="o_geo_slider_selection"
                 t-attf-style="left: {{selection.left}}%; width: {{selection.width}}%"/>

            <div class="o_geo_slider_handle o_geo_slider_handle_from"
                 t-attf-style="left: {{selection.left}}%"
                 tabindex="0" role="slider"
                 t-att-aria-label="startOfPeriodLabel"
                 t-att-aria-valuemin="0"
                 t-att-aria-valuemax="maxIndex"
                 t-att-aria-valuenow="state.fromIndex"
                 t-att-aria-valuetext="fromPeriodKey"
                 t-on-pointerdown="(ev) => this.onHandleDown('from', ev)"
                 t-on-keydown="(ev) => this.onHandleKeydown('from', ev)"/>

            <div class="o_geo_slider_handle o_geo_slider_handle_to"
                 t-attf-style="left: {{selection.left + selection.width}}%"
                 tabindex="0" role="slider"
                 t-att-aria-label="endOfPeriodLabel"
                 t-att-aria-valuemin="0"
                 t-att-aria-valuemax="maxIndex"
                 t-att-aria-valuenow="state.toIndex"
                 t-att-aria-valuetext="toPeriodKey"
                 t-on-pointerdown="(ev) => this.onHandleDown('to', ev)"
                 t-on-keydown="(ev) => this.onHandleKeydown('to', ev)"/>
        </div>

        <div class="o_geo_slider_scale text-muted">
            <span><t t-esc="firstPeriodKey"/></span>
            <span><t t-esc="lastPeriodKey"/></span>
        </div>
    </div>
    `;
    static props = {
        periods: { type: Array },
        fromIndex: { type: Number },
        toIndex: { type: Number },
        formatValue: { type: Function },
        onChange: { type: Function },
        playing: { type: Boolean, optional: true },
        onPlayToggle: { type: Function, optional: true },
        // Report continuously while dragging (true) or only on release.
        liveUpdate: { type: Boolean, optional: true },
    };
    static defaultProps = { liveUpdate: true, playing: false };

    setup() {
        this.trackRef = useRef("track");
        this.state = useState({
            fromIndex: this.props.fromIndex,
            toIndex: this.props.toIndex,
            dragging: null,
        });
        this._lastProps = { from: this.props.fromIndex, to: this.props.toIndex };
        this._debounceHandle = null;
        onWillUnmount(() => this._clearDebounce());
    }

    /**
     * Adopt changes coming from outside (a preset, or the playback advancing)
     * without disturbing an in-progress drag gesture.
     */
    willUpdateProps(nextProps) {
        if (this.state.dragging) {
            return;
        }
        if (
            nextProps.fromIndex !== this._lastProps.from ||
            nextProps.toIndex !== this._lastProps.to
        ) {
            this.state.fromIndex = nextProps.fromIndex;
            this.state.toIndex = nextProps.toIndex;
            this._lastProps = { from: nextProps.fromIndex, to: nextProps.toIndex };
        }
    }

    get count() {
        return this.props.periods.length;
    }

    get maxIndex() {
        return Math.max(0, this.count - 1);
    }

    get maxAmount() {
        let max = 0;
        for (const period of this.props.periods) {
            if (period.amount > max) {
                max = period.amount;
            }
        }
        return max || 1;
    }

    /** Bars of the revenue curve, marking the active span. */
    get bars() {
        const max = this.maxAmount;
        const width = 100 / this.count;
        return this.props.periods.map((period, index) => ({
            period,
            index,
            left: index * width,
            width,
            // Minimum height so low-revenue months do not vanish entirely and
            // the slider stays graspable there.
            height: period.amount > 0
                ? Math.max(4, (period.amount / max) * 100)
                : 1,
            active: index >= this.state.fromIndex && index <= this.state.toIndex,
        }));
    }

    get selection() {
        const width = 100 / this.count;
        return {
            left: this.state.fromIndex * width,
            width: (this.state.toIndex - this.state.fromIndex + 1) * width,
        };
    }

    get label() {
        const from = this.props.periods[this.state.fromIndex];
        const to = this.props.periods[this.state.toIndex];
        if (!from || !to) {
            return "";
        }
        return `${this._monthLabel(from)} – ${this._monthLabel(to)}`;
    }

    get selectedAmount() {
        let sum = 0;
        for (let index = this.state.fromIndex; index <= this.state.toIndex; index++) {
            sum += this.props.periods[index]?.amount ?? 0;
        }
        return sum;
    }

    get monthCount() {
        return this.state.toIndex - this.state.fromIndex + 1;
    }

    get monthCountLabel() {
        const count = this.monthCount;
        return count === 1
            ? _t("%(count)s month", { count })
            : _t("%(count)s months", { count });
    }

    get startOfPeriodLabel() {
        return _t("Start of period");
    }

    get endOfPeriodLabel() {
        return _t("End of period");
    }

    // These getters keep optional access out of the template: OWL's expression
    // compiler does not handle optional chaining reliably, and an empty period
    // grid must not break the view.
    get firstPeriodKey() {
        return this.props.periods.length ? this.props.periods[0].key : "";
    }

    get lastPeriodKey() {
        const periods = this.props.periods;
        return periods.length ? periods[periods.length - 1].key : "";
    }

    get fromPeriodKey() {
        return this.props.periods[this.state.fromIndex]?.key ?? "";
    }

    get toPeriodKey() {
        return this.props.periods[this.state.toIndex]?.key ?? "";
    }

    _monthLabel(period) {
        const date = new Date(period.year, period.month - 1, 1);
        return date.toLocaleDateString(undefined, {
            month: "short",
            year: "numeric",
        });
    }

    // ------------------------------------------------------------------
    // Drag gesture
    // ------------------------------------------------------------------

    _indexFromEvent(event) {
        const track = this.trackRef.el;
        if (!track) {
            return 0;
        }
        const rect = track.getBoundingClientRect();
        const ratio = (event.clientX - rect.left) / rect.width;
        const index = Math.floor(ratio * this.count);
        return Math.max(0, Math.min(this.count - 1, index));
    }

    onHandleDown(which, event) {
        event.preventDefault();
        event.stopPropagation();
        this.state.dragging = which;
        event.target.setPointerCapture?.(event.pointerId);
    }

    onTrackDown(event) {
        // Click on the track: bring the nearer handle to that spot.
        const index = this._indexFromEvent(event);
        const distanceToFrom = Math.abs(index - this.state.fromIndex);
        const distanceToTo = Math.abs(index - this.state.toIndex);
        const which = distanceToFrom <= distanceToTo ? "from" : "to";
        this._setIndex(which, index);
        this.state.dragging = which;
        this.trackRef.el.setPointerCapture?.(event.pointerId);
        this._emit(false);
    }

    onPointerMove(event) {
        if (!this.state.dragging) {
            return;
        }
        this._setIndex(this.state.dragging, this._indexFromEvent(event));
        if (this.props.liveUpdate) {
            this._emit(true);
        }
    }

    onPointerUp() {
        if (!this.state.dragging) {
            return;
        }
        this.state.dragging = null;
        this._emit(false);
    }

    _setIndex(which, index) {
        if (which === "from") {
            this.state.fromIndex = Math.min(index, this.state.toIndex);
        } else {
            this.state.toIndex = Math.max(index, this.state.fromIndex);
        }
    }

    // ------------------------------------------------------------------
    // Keyboard operation
    // ------------------------------------------------------------------

    /**
     * Without keyboard support the slider would be the only control on the
     * dashboard that cannot be used without a mouse.
     */
    onHandleKeydown(which, event) {
        const step = event.shiftKey ? 12 : 1;
        let index = which === "from" ? this.state.fromIndex : this.state.toIndex;
        switch (event.key) {
            case "ArrowLeft":
            case "ArrowDown":
                index -= step;
                break;
            case "ArrowRight":
            case "ArrowUp":
                index += step;
                break;
            case "Home":
                index = 0;
                break;
            case "End":
                index = this.count - 1;
                break;
            default:
                return;
        }
        event.preventDefault();
        this._setIndex(which, Math.max(0, Math.min(this.count - 1, index)));
        this._emit(false);
    }

    // ------------------------------------------------------------------
    // Reporting outwards
    // ------------------------------------------------------------------

    _clearDebounce() {
        if (this._debounceHandle) {
            clearTimeout(this._debounceHandle);
            this._debounceHandle = null;
        }
    }

    /**
     * Debounced while dragging, immediate on release. The map visibly follows
     * the gesture without firing a server request for every intermediate step.
     */
    _emit(isDragging) {
        this._clearDebounce();
        const payload = {
            fromIndex: this.state.fromIndex,
            toIndex: this.state.toIndex,
            dateFrom: this.props.periods[this.state.fromIndex]?.date_from,
            dateTo: this.props.periods[this.state.toIndex]?.date_to,
        };
        this._lastProps = { from: payload.fromIndex, to: payload.toIndex };
        if (isDragging) {
            this._debounceHandle = setTimeout(() => {
                this._debounceHandle = null;
                this.props.onChange(payload);
            }, 180);
        } else {
            this.props.onChange(payload);
        }
    }

    // ------------------------------------------------------------------
    // Presets and playback
    // ------------------------------------------------------------------

    get presets() {
        return [
            { key: "all", label: _t("All time") },
            { key: "ytd", label: _t("Year to date") },
            { key: "12m", label: _t("12 months") },
            { key: "quarter", label: _t("Last quarter") },
        ];
    }

    applyPreset(key) {
        const last = this.count - 1;
        let from = 0;
        const to = last;
        if (key === "12m") {
            from = Math.max(0, last - 11);
        } else if (key === "quarter") {
            from = Math.max(0, last - 2);
        } else if (key === "ytd") {
            const year = this.props.periods[last]?.year;
            const firstOfYear = this.props.periods.findIndex((p) => p.year === year);
            from = firstOfYear >= 0 ? firstOfYear : 0;
        }
        this.state.fromIndex = from;
        this.state.toIndex = to;
        this._emit(false);
    }

    isPresetActive(key) {
        const last = this.count - 1;
        if (this.state.toIndex !== last) {
            return false;
        }
        if (key === "all") {
            return this.state.fromIndex === 0;
        }
        if (key === "12m") {
            return this.state.fromIndex === Math.max(0, last - 11);
        }
        if (key === "quarter") {
            return this.state.fromIndex === Math.max(0, last - 2);
        }
        if (key === "ytd") {
            const year = this.props.periods[last]?.year;
            const firstOfYear = this.props.periods.findIndex((p) => p.year === year);
            return this.state.fromIndex === (firstOfYear >= 0 ? firstOfYear : 0);
        }
        return false;
    }

    onPlayToggle() {
        this.props.onPlayToggle?.();
    }

    get playTitle() {
        return this.props.playing
            ? _t("Pause")
            : _t("Play: move the selected window through time");
    }
}
