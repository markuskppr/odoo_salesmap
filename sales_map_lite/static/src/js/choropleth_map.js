/** @odoo-module **/

import { Component, onMounted, onWillUnmount, useRef, useState, xml } from "@odoo/owl";
import { _t } from "@web/core/l10n/translation";
import { buildPaths, projectToScreen, projectionFor } from "./projection";
import { symbolRadius } from "./color_scale";

/**
 * Choropleth map in plain SVG.
 *
 * Two decisions shape this component:
 *
 * 1. No tile service, no mapping library. A basemap adds nothing to an area map
 *    of statistical regions, whereas a CDN dependency inside the Odoo backend
 *    routinely fails against content security policies and air-gapped
 *    instances.
 *
 * 2. Pan and zoom do not go through component state; they set the SVG group's
 *    transform attribute directly. Having the framework re-render on every
 *    mouse move would visibly stutter with thousands of areas, and the
 *    projection itself only ever runs once per geometry.
 */
export class ChoroplethMap extends Component {
    static template = xml`
<div class="o_geo_map_wrapper">
        <svg t-ref="svg"
             class="o_geo_map_svg"
             t-att-viewBox="'0 0 ' + state.viewport.width + ' ' + state.viewport.height"
             t-att-width="state.viewport.width"
             t-att-height="state.viewport.height"
             preserveAspectRatio="xMidYMid meet"
             t-on-wheel="onWheel"
             t-on-pointerdown="onPointerDown"
             t-on-pointermove="onPointerMove"
             t-on-pointerup="onPointerUp"
             t-on-pointercancel="onPointerUp"
             t-on-pointerleave="onRegionLeave">

            <g t-ref="layer">
                <!-- Areas. vector-effect keeps border lines the same weight while
                     zooming; without it they turn into thick bands. -->
                <path t-foreach="paths" t-as="item" t-key="item.properties.key"
                      t-att-d="item.d"
                      t-att-class="classFor(item.properties)"
                      t-att-fill="fillFor(item.properties)"
                      vector-effect="non-scaling-stroke"
                      t-on-pointerenter="(ev) => this.onRegionEnter(item.properties, ev)"
                      t-on-pointermove="onRegionMove"
                      t-on-pointerleave="onRegionLeave"
                      t-on-click="() => this.onRegionClick(item.properties)"/>

                <!-- Orientation outlines ABOVE the areas. Underneath they would
                     be hidden exactly where they are needed: inside a sales
                     territory. Only this way can you tell which countries a
                     freely cut territory covers. Drawn twice, a light halo then
                     a dark line: a single colour disappears against some
                     classes of the palette. No fill and no pointer events, so
                     the areas below stay clickable. -->
                <g t-if="referencePaths.length" class="o_geo_reference">
                    <path t-foreach="referencePaths" t-as="ref"
                          t-key="'halo_' + ref.properties.key"
                          t-att-d="ref.d"
                          class="o_geo_reference_halo"
                          vector-effect="non-scaling-stroke"/>
                    <path t-foreach="referencePaths" t-as="ref"
                          t-key="ref.properties.key"
                          t-att-d="ref.d"
                          class="o_geo_reference_path"
                          vector-effect="non-scaling-stroke"/>
                </g>

                <!-- Customer locations -->
                <g t-if="props.showPoints" class="o_geo_points">
                    <circle t-foreach="pointItems" t-as="point" t-key="point.id"
                            t-att-cx="point.cx" t-att-cy="point.cy" t-att-r="point.r"
                            class="o_geo_point"
                            vector-effect="non-scaling-stroke"
                            t-on-pointerenter="(ev) => this.onPointEnter(point, ev)"
                            t-on-pointerleave="onRegionLeave"
                            t-on-click="() => this.onPointClick(point)"/>
                </g>
            </g>
        </svg>

        <!-- Map controls -->
        <div class="o_geo_map_controls btn-group-vertical shadow-sm">
            <button class="btn btn-light btn-sm" t-att-title="zoomInTitle"
                    t-on-click="() => this.zoomBy(1.5)">
                <i class="fa fa-plus"/>
            </button>
            <button class="btn btn-light btn-sm" t-att-title="zoomOutTitle"
                    t-on-click="() => this.zoomBy(1/1.5)">
                <i class="fa fa-minus"/>
            </button>
            <button class="btn btn-light btn-sm" t-att-title="resetViewTitle"
                    t-on-click="resetView">
                <i class="fa fa-compress"/>
            </button>
        </div>
        <div class="o_geo_zoom_badge badge text-bg-light" t-if="state.zoom > 1">
            <t t-esc="state.zoom"/>×
        </div>

        <!-- Legend -->
        <div class="o_geo_legend shadow-sm" t-if="legendEntries.length">
            <div class="o_geo_legend_title text-muted">
                <t t-esc="legendTitle"/>
            </div>
            <div t-foreach="legendEntries" t-as="entry" t-key="entry_index"
                 class="o_geo_legend_row">
                <span class="o_geo_legend_swatch"
                      t-attf-style="background-color: {{entry.color}}"/>
                <span class="o_geo_legend_label"><t t-esc="entry.label"/></span>
            </div>
            <div class="o_geo_legend_row text-muted">
                <span class="o_geo_legend_swatch o_geo_legend_swatch_empty"/>
                <span class="o_geo_legend_label"><t t-esc="noRevenueLabel"/></span>
            </div>
        </div>

        <!-- Tooltip -->
        <div class="o_geo_tooltip shadow" t-ref="tooltip"
             t-att-class="{ 'd-none': !state.hover }">
            <t t-if="state.hover">
                <div class="o_geo_tooltip_title">
                    <t t-esc="state.hover.name"/>
                    <span class="text-muted ms-1" t-if="state.hover.code">
                        <t t-esc="state.hover.code"/>
                    </span>
                </div>
                <t t-if="state.hover.row">
                    <div class="o_geo_tooltip_metric">
                        <t t-esc="props.formatValue(state.hover.row.amount)"/>
                    </div>
                    <div class="o_geo_tooltip_details text-muted">
                        <t t-esc="hoverOrdersText"/>
                        <t t-if="state.hover.row.partner_count">
                            · <t t-esc="hoverCustomersText"/>
                        </t>
                        <t t-if="state.hover.row.share">
                            · <t t-esc="state.hover.row.share.toFixed(1)"/>%
                        </t>
                    </div>
                    <div class="o_geo_tooltip_details"
                         t-if="state.hover.row.growth !== null and state.hover.row.growth !== undefined">
                        <span t-att-class="state.hover.row.growth >= 0 ? 'text-success' : 'text-danger'">
                            <t t-esc="state.hover.row.growth > 0 ? '+' : ''"/><t t-esc="state.hover.row.growth.toFixed(1)"/>%
                        </span>
                        <span class="text-muted"> <t t-esc="vsComparisonPeriodLabel"/></span>
                    </div>
                </t>
                <div class="o_geo_tooltip_details text-muted" t-else="">
                    <t t-esc="noRevenueInPeriodLabel"/>
                </div>
            </t>
        </div>
    </div>
    `;
    static props = {
        features: { type: Array },
        valuesByKey: { type: Object },
        scale: { type: Object },
        level: { type: String, optional: true },
        points: { type: Object, optional: true },
        showPoints: { type: Boolean, optional: true },
        metric: { type: String, optional: true },
        formatValue: { type: Function },
        onRegionClick: { type: Function, optional: true },
        onPointClick: { type: Function, optional: true },
        selectedKey: { type: [String, { value: null }], optional: true },
        // Outlines for orientation (country borders). Without them, freely cut
        // sales territories cannot be placed on the map: you see shapes but do
        // not recognise the geography.
        referenceFeatures: { type: Array, optional: true },
    };
    static defaultProps = {
        showPoints: false,
        metric: "amount",
        selectedKey: null,
        referenceFeatures: [],
        level: "country",
    };

    setup() {
        this.svgRef = useRef("svg");
        this.layerRef = useRef("layer");
        this.tooltipRef = useRef("tooltip");

        this.state = useState({
            viewport: { width: 900, height: 560 },
            hover: null,
            zoom: 1,
        });

        // Not reactive: touched on every mouse move.
        this.view = { scale: 1, x: 0, y: 0 };
        this.drag = null;
        this._geometrySignature = null;
        this._paths = [];
        this._referencePaths = [];
        this._transform = null;

        onMounted(() => {
            this._observer = new ResizeObserver(() => this._measure());
            if (this.svgRef.el?.parentElement) {
                this._observer.observe(this.svgRef.el.parentElement);
            }
            this._measure();
        });
        onWillUnmount(() => this._observer?.disconnect());
    }

    _measure() {
        const container = this.svgRef.el?.parentElement;
        if (!container) {
            return;
        }
        const width = Math.max(320, container.clientWidth);
        const height = Math.max(320, container.clientHeight || 560);
        if (
            Math.abs(width - this.state.viewport.width) > 1 ||
            Math.abs(height - this.state.viewport.height) > 1
        ) {
            this.state.viewport = { width, height };
            this._geometrySignature = null; // projection must be refitted
        }
    }

    // ------------------------------------------------------------------
    // Geometry
    // ------------------------------------------------------------------

    /**
     * Projected paths. Only recomputed when geometry, level or viewport
     * actually changed -- not on every period or colour change.
     */
    get paths() {
        const signature = [
            this.props.level,
            this.props.features.length,
            this.props.features[0]?.properties?.key ?? "",
            this.props.features[this.props.features.length - 1]?.properties?.key ?? "",
            Math.round(this.state.viewport.width),
            Math.round(this.state.viewport.height),
            this.props.referenceFeatures.length,
        ].join("|");
        if (signature !== this._geometrySignature) {
            const viewport = {
                width: this.state.viewport.width,
                height: this.state.viewport.height,
                padding: 12,
                projection: projectionFor(this.props.level),
            };
            const result = buildPaths(this.props.features, viewport);
            this._paths = result.items;
            this._transform = result.transform;
            // Reference outlines adopt the data layer's transform: the data
            // decides the framing, the outlines only add context and are
            // clipped at the edge.
            this._referencePaths =
                this.props.referenceFeatures.length && this._transform
                    ? buildPaths(
                          this.props.referenceFeatures, viewport, this._transform,
                      ).items
                    : [];
            this._geometrySignature = signature;
        }
        return this._paths;
    }

    get referencePaths() {
        // Touching "paths" guarantees both layers are built together and share
        // one transform.
        void this.paths;
        return this._referencePaths;
    }

    get pointItems() {
        if (!this.props.showPoints || !this._transform) {
            return [];
        }
        const items = this.props.points?.items ?? [];
        if (!items.length) {
            return [];
        }
        const maxAmount = items[0].amount || 1;
        const result = [];
        for (const item of items) {
            const screen = projectToScreen(item.lon, item.lat, this._transform);
            if (!screen) {
                continue;
            }
            result.push({
                ...item,
                cx: Math.round(screen[0] * 10) / 10,
                cy: Math.round(screen[1] * 10) / 10,
                r: Math.round(symbolRadius(item.amount, maxAmount) * 10) / 10,
            });
        }
        return result;
    }

    // ------------------------------------------------------------------
    // Translated static labels -- literal _t() calls in getters so they
    // re-resolve on every render, after translations are loaded.
    // ------------------------------------------------------------------

    get zoomInTitle() {
        return _t("Zoom in");
    }

    get zoomOutTitle() {
        return _t("Zoom out");
    }

    get resetViewTitle() {
        return _t("Reset view");
    }

    get legendTitle() {
        return this.props.metric === "growth" ? _t("Change") : _t("Classes");
    }

    get noRevenueLabel() {
        return _t("no revenue");
    }

    get vsComparisonPeriodLabel() {
        return _t("vs. comparison period");
    }

    get noRevenueInPeriodLabel() {
        return _t("no revenue in the selected period");
    }

    get hoverOrdersText() {
        return _t("%(count)s orders", { count: this.state.hover?.row?.order_count });
    }

    get hoverCustomersText() {
        return _t("%(count)s customers", { count: this.state.hover?.row?.partner_count });
    }

    // ------------------------------------------------------------------
    // Presentation
    // ------------------------------------------------------------------

    valueFor(key) {
        return this.props.valuesByKey[key] ?? null;
    }

    fillFor(properties) {
        const row = this.valueFor(properties.key);
        if (!row) {
            return null; // no data: fill comes from the stylesheet
        }
        const metric = this.props.metric;
        const value = metric === "growth" ? row.growth : row[metric];
        if (!Number.isFinite(value)) {
            return null;
        }
        return this.props.scale.colorFor(value);
    }

    classFor(properties) {
        const classes = ["o_geo_region"];
        if (!this.valueFor(properties.key)) {
            classes.push("o_geo_region_empty");
        }
        if (this.props.selectedKey && properties.key === this.props.selectedKey) {
            classes.push("o_geo_region_selected");
        }
        return classes.join(" ");
    }

    // ------------------------------------------------------------------
    // Interaction
    // ------------------------------------------------------------------

    _applyView() {
        const layer = this.layerRef.el;
        if (layer) {
            layer.setAttribute(
                "transform",
                `translate(${this.view.x} ${this.view.y}) scale(${this.view.scale})`,
            );
        }
        // Only for the zoom indicator; rounded so not every wheel tick
        // re-renders the toolbar.
        const rounded = Math.round(this.view.scale * 10) / 10;
        if (rounded !== this.state.zoom) {
            this.state.zoom = rounded;
        }
    }

    onWheel(event) {
        event.preventDefault();
        const rect = this.svgRef.el.getBoundingClientRect();
        const pointerX = event.clientX - rect.left;
        const pointerY = event.clientY - rect.top;
        const factor = event.deltaY < 0 ? 1.18 : 1 / 1.18;
        const next = Math.min(24, Math.max(1, this.view.scale * factor));
        const applied = next / this.view.scale;
        // The point under the cursor stays where it is while zooming.
        this.view.x = pointerX - (pointerX - this.view.x) * applied;
        this.view.y = pointerY - (pointerY - this.view.y) * applied;
        this.view.scale = next;
        if (this.view.scale === 1) {
            this.view.x = 0;
            this.view.y = 0;
        }
        this._applyView();
    }

    onPointerDown(event) {
        if (event.button !== 0) {
            return;
        }
        this.drag = {
            startX: event.clientX,
            startY: event.clientY,
            originX: this.view.x,
            originY: this.view.y,
            moved: false,
        };
        this.svgRef.el.setPointerCapture?.(event.pointerId);
    }

    onPointerMove(event) {
        if (!this.drag) {
            return;
        }
        const dx = event.clientX - this.drag.startX;
        const dy = event.clientY - this.drag.startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
            this.drag.moved = true;
        }
        this.view.x = this.drag.originX + dx;
        this.view.y = this.drag.originY + dy;
        this._applyView();
    }

    onPointerUp(event) {
        this.svgRef.el?.releasePointerCapture?.(event.pointerId);
        this.drag = null;
    }

    onRegionEnter(properties, event) {
        this.state.hover = {
            name: properties.name,
            code: properties.code,
            row: this.valueFor(properties.key),
        };
        this._positionTooltip(event);
    }

    onRegionMove(event) {
        if (this.state.hover) {
            this._positionTooltip(event);
        }
    }

    onRegionLeave() {
        this.state.hover = null;
    }

    onPointEnter(point, event) {
        this.state.hover = {
            name: point.name,
            code: point.city || "",
            row: { amount: point.amount, order_count: point.order_count },
            isPoint: true,
        };
        this._positionTooltip(event);
    }

    onPointClick(point) {
        // Do not treat the end of a pan gesture as a click on the marker.
        if (this.drag?.moved) {
            return;
        }
        this.props.onPointClick?.(point);
    }

    _positionTooltip(event) {
        const tooltip = this.tooltipRef.el;
        const container = this.svgRef.el?.parentElement;
        if (!tooltip || !container) {
            return;
        }
        const rect = container.getBoundingClientRect();
        let x = event.clientX - rect.left + 14;
        let y = event.clientY - rect.top + 14;
        // Flip at the right and bottom edges so the tooltip stays inside the
        // map area.
        if (x + tooltip.offsetWidth > rect.width) {
            x = Math.max(4, x - tooltip.offsetWidth - 28);
        }
        if (y + tooltip.offsetHeight > rect.height) {
            y = Math.max(4, y - tooltip.offsetHeight - 28);
        }
        tooltip.style.transform = `translate(${x}px, ${y}px)`;
    }

    onRegionClick(properties) {
        // Do not treat the end of a pan gesture as a click on the area.
        if (this.drag?.moved) {
            return;
        }
        this.props.onRegionClick?.(properties, this.valueFor(properties.key));
    }

    resetView() {
        this.view = { scale: 1, x: 0, y: 0 };
        this._applyView();
    }

    zoomBy(factor) {
        const center = {
            x: this.state.viewport.width / 2,
            y: this.state.viewport.height / 2,
        };
        const next = Math.min(24, Math.max(1, this.view.scale * factor));
        const applied = next / this.view.scale;
        this.view.x = center.x - (center.x - this.view.x) * applied;
        this.view.y = center.y - (center.y - this.view.y) * applied;
        this.view.scale = next;
        if (this.view.scale === 1) {
            this.view.x = 0;
            this.view.y = 0;
        }
        this._applyView();
    }

    // ------------------------------------------------------------------
    // Legend
    // ------------------------------------------------------------------

    get legendEntries() {
        const { breaks, colors } = this.props.scale;
        if (!breaks.length) {
            return [];
        }
        const entries = [];
        for (let index = 0; index < colors.length; index++) {
            const lower = index === 0 ? null : breaks[index - 1];
            const upper = index < breaks.length ? breaks[index] : null;
            entries.push({
                color: colors[index],
                label: this._legendLabel(lower, upper),
            });
        }
        return entries;
    }

    _legendLabel(lower, upper) {
        const format = this.props.formatValue;
        if (lower === null) {
            return `< ${format(upper)}`;
        }
        if (upper === null) {
            return `≥ ${format(lower)}`;
        }
        return `${format(lower)} – ${format(upper)}`;
    }
}
