/** @odoo-module **/

import { Component, onWillStart, onWillUnmount, useState, xml } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { _t } from "@web/core/l10n/translation";
import { ChoroplethMap } from "./choropleth_map";
import { TimeRangeSlider } from "./time_range_slider";
import { RankingTable } from "./ranking_table";
import { buildScale, CLASSIFICATIONS } from "./color_scale";
import { FeatureIndex, nutsAncestor, isoCountryOfNuts, nutsPrefixOfIso } from "./geometry";
import { SalesDataLayer, REVENUE_BASES, PARTNER_BASES } from "./data_layer";

/**
 * Sales Map Lite -- the ZIP-installable edition.
 *
 * Everything runs client side: geometry ships as static GeoJSON, figures
 * come straight from the standard reporting models through the ORM as the
 * logged-in user (so access rights and multi-company isolation apply by
 * construction), and customer-to-region matching is point-in-polygon in the
 * browser. No Python, no new models, no server state -- which is exactly
 * what lets Apps > Import Module install it.
 */

const LEVELS = [
    { key: "country", label: "Countries", file: "countries" },
    { key: "nuts1", label: "Europe: NUTS 1", file: "nuts1" },
    { key: "nuts2", label: "Europe: NUTS 2", file: "nuts2" },
];
const DRILL_CHILD = { country: "nuts1", nuts1: "nuts2" };
const COMPARE_MODES = [
    { key: "none", label: "No comparison" },
    { key: "previous", label: "Previous period" },
    { key: "year", label: "Same period last year" },
];
const TOP_N = 15;
const STORAGE_KEY = "sales_map_lite.settings";

// ---------------------------------------------------------------------------
// Date helpers (pure string math on ISO dates, no timezone surprises)
// ---------------------------------------------------------------------------

function isoToUTC(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
}
function utcToIso(ms) {
    return new Date(ms).toISOString().slice(0, 10);
}
function addDays(iso, days) {
    return utcToIso(isoToUTC(iso) + days * 86400000);
}
function shiftYears(iso, years) {
    const [y, m, d] = iso.split("-").map(Number);
    const date = new Date(Date.UTC(y + years, m - 1, 1));
    const lastDay = new Date(Date.UTC(y + years, m, 0)).getUTCDate();
    date.setUTCDate(Math.min(d, lastDay));
    return date.toISOString().slice(0, 10);
}

export class SalesMapLiteDashboard extends Component {
    static components = { ChoroplethMap, TimeRangeSlider, RankingTable };
    static props = ["*"];

    /** Milliseconds each frame stays on screen during playback. */
    static PLAY_INTERVAL = 850;

    setup() {
        this.orm = useService("orm");
        this.action = useService("action");
        this.notification = useService("notification");
        this.data = new SalesDataLayer(this.orm);

        const stored = this._storedSettings();
        this.state = useState({
            loading: true,
            error: null,
            ready: false,
            empty: false,
            periods: [],
            source: null,
            currency: null,
            result: null,
            level: "country",
            drillStack: [],
            fromIndex: 0,
            toIndex: 0,
            compareMode: "previous",
            metric: "amount",
            classification: "quantile",
            classes: 5,
            showPoints: false,
            selectedKey: null,
            activeRanking: "regions",
            geometryLoading: false,
            playing: false,
            basis: stored.basis || "invoices",
            partnerBasis: stored.partnerBasis || "invoice",
        });

        this._geometryCache = new Map();
        this._features = [];
        this._nutsIndexes = null;
        this._assignments = new Map();
        this._currentPerPartner = null;
        this._requestToken = 0;
        this._playToken = 0;

        onWillStart(async () => {
            await this.loadEverything();
        });
        onWillUnmount(() => {
            this._playToken++;
        });
    }

    _storedSettings() {
        try {
            return JSON.parse(window.localStorage.getItem(STORAGE_KEY)) || {};
        } catch {
            return {};
        }
    }

    _storeSettings() {
        try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
                basis: this.state.basis,
                partnerBasis: this.state.partnerBasis,
            }));
        } catch {
            // Private windows may refuse storage; the dashboard works anyway.
        }
    }

    // ------------------------------------------------------------------
    // Loading
    // ------------------------------------------------------------------

    async loadEverything() {
        this.state.loading = true;
        this.state.error = null;
        try {
            this.source = await this.data.resolveSource(
                this.state.basis, this.state.partnerBasis,
            );
            this.state.source = {
                label: this.source.label,
                fallback: this.source.fallback,
                revenueBasis: this.source.revenueBasis,
                partnerBasis: this.source.partnerBasis,
                requestedPartnerBasis: this.source.requestedPartnerBasis,
            };
            // Independent of one another: the currency read does not need
            // the date bounds, and vice versa.
            const [, bounds] = await Promise.all([
                this._loadCurrency(),
                this.data.dateBounds(this.source),
            ]);
            this.state.empty = !bounds.min;
            const max = bounds.max || new Date().toISOString().slice(0, 10);
            const min = bounds.min || shiftYears(max, -1);
            this.state.periods = await this.data.monthSeries(this.source, min, max);
            const count = this.state.periods.length;
            // Default: the last twelve months.
            this.state.toIndex = Math.max(0, count - 1);
            this.state.fromIndex = Math.max(0, count - 12);

            await Promise.all([this.loadGeometry(), this.loadFigures()]);
            this.state.ready = true;
        } catch (error) {
            this.state.error = this._errorMessage(error);
        } finally {
            this.state.loading = false;
        }
    }

    async _loadCurrency() {
        // Figures are in company currency; take it from the user's current
        // company (cookies decide which one that is in multi-company).
        const [company] = await this.orm.searchRead(
            "res.company", [], ["currency_id"], { limit: 1 },
        );
        let currency = { symbol: "", position: "after", decimal_places: 2 };
        if (company?.currency_id) {
            const [record] = await this.orm.read(
                "res.currency", [company.currency_id[0]],
                ["symbol", "position", "decimal_places"],
            );
            currency = record;
        }
        this.state.currency = currency;
    }

    get currentParentCode() {
        const stack = this.state.drillStack;
        return stack.length ? stack[stack.length - 1].parentCode : null;
    }

    async _fetchGeometry(levelKey) {
        if (this._geometryCache.has(levelKey)) {
            return this._geometryCache.get(levelKey);
        }
        const level = LEVELS.find((entry) => entry.key === levelKey);
        const response = await fetch(`/sales_map_lite/static/data/${level.file}.json`);
        if (!response.ok) {
            throw new Error(_t("The boundaries could not be loaded (%s).", response.status));
        }
        const payload = await response.json();
        const features = (payload.features || []).map((feature) => ({
            ...feature,
            properties: {
                ...feature.properties,
                key: String(feature.properties.code),
                level: levelKey,
                attribution: payload.properties?.attribution || "",
            },
        }));
        this._geometryCache.set(levelKey, features);
        return features;
    }

    /** Features of the current level, filtered by the drill parent. */
    async loadGeometry() {
        this.state.geometryLoading = true;
        try {
            let features = await this._fetchGeometry(this.state.level);
            const parent = this.currentParentCode;
            if (parent) {
                if (this.state.level === "nuts1") {
                    const prefix = nutsPrefixOfIso(parent);
                    features = features.filter(
                        (f) => f.properties.code.slice(0, 2) === prefix,
                    );
                } else if (this.state.level === "nuts2") {
                    features = features.filter(
                        (f) => f.properties.code.startsWith(parent),
                    );
                }
            }
            // Which regions can be drilled into? Computed against the child
            // level's shipped codes.
            const childLevel = DRILL_CHILD[this.state.level];
            if (childLevel) {
                const children = await this._fetchGeometry(childLevel);
                const drillable = new Set();
                for (const child of children) {
                    if (childLevel === "nuts1") {
                        drillable.add(isoCountryOfNuts(child.properties.code));
                    } else {
                        drillable.add(child.properties.code.slice(0, 3));
                    }
                }
                features = features.map((feature) => ({
                    ...feature,
                    properties: {
                        ...feature.properties,
                        drill_level: drillable.has(feature.properties.code)
                            ? childLevel : null,
                    },
                }));
            }
            this._features = features;
        } finally {
            this.state.geometryLoading = false;
        }
    }

    async _ensureNutsIndexes() {
        if (!this._nutsIndexes) {
            const [nuts1, nuts2] = await Promise.all([
                this._fetchGeometry("nuts1"),
                this._fetchGeometry("nuts2"),
            ]);
            this._nutsIndexes = {
                nuts1: new FeatureIndex(nuts1, "code"),
                nuts2: new FeatureIndex(nuts2, "code"),
            };
        }
        return this._nutsIndexes;
    }

    /**
     * NUTS assignment of one customer, cached per coordinate. Exact
     * containment at NUTS 2, cascading to NUTS 1 for points in genuine gaps
     * of the finer tiling. (The full module additionally matches coastal
     * points to the nearest region within 25 km; the Lite edition reports
     * such edge cases as unassigned instead -- documented behaviour.)
     */
    _assign(info, indexes) {
        if (!info || (!info.lon && !info.lat)) {
            return { nuts1: null, nuts2: null };
        }
        const cacheKey = `${info.id}:${info.lon}:${info.lat}`;
        if (!this._assignments.has(cacheKey)) {
            const nuts2 = indexes.nuts2.lookup(info.lon, info.lat);
            let nuts1 = nuts2 ? nutsAncestor(nuts2, "nuts1") : null;
            if (!nuts1) {
                nuts1 = indexes.nuts1.lookup(info.lon, info.lat);
            }
            this._assignments.set(cacheKey, { nuts1, nuts2 });
        }
        return this._assignments.get(cacheKey);
    }

    // ------------------------------------------------------------------
    // Figures
    // ------------------------------------------------------------------

    _selectedRange() {
        const periods = this.state.periods;
        return {
            from: periods[this.state.fromIndex]?.date_from,
            to: periods[this.state.toIndex]?.date_to,
        };
    }

    _compareRange(from, to) {
        if (this.state.compareMode === "previous") {
            const span = (isoToUTC(to) - isoToUTC(from)) / 86400000 + 1;
            const prevTo = addDays(from, -1);
            return { from: addDays(prevTo, -(span - 1)), to: prevTo };
        }
        if (this.state.compareMode === "year") {
            return { from: shiftYears(from, -1), to: shiftYears(to, -1) };
        }
        return null;
    }

    async loadFigures() {
        const token = ++this._requestToken;
        const { from, to } = this._selectedRange();
        if (!from || !to) {
            this.state.result = this._emptyResult(from, to, null);
            this._currentPerPartner = null;
            return;
        }
        const compare = this._compareRange(from, to);
        const [current, previous] = await Promise.all([
            this.data.perPartner(this.source, from, to),
            compare
                ? this.data.perPartner(this.source, compare.from, compare.to)
                : Promise.resolve(new Map()),
        ]);
        const ids = [...new Set([...current.keys(), ...previous.keys()])];
        const [info, indexes] = await Promise.all([
            this.data.partnerInfo(ids),
            this._ensureNutsIndexes(),
        ]);
        if (token !== this._requestToken) {
            return;
        }
        // Kept for _partnersInSelection: the region popup's "Customers" and
        // "Sales Orders" actions need exactly this aggregation, and re-fetching
        // it from the server on every click would double the RPC cost of every
        // drill-through for no reason -- the figures on screen already are it.
        this._currentPerPartner = { from, to, data: current };
        this.state.result = this._compose(
            current, previous, info, indexes, from, to, compare,
        );
    }

    _emptyResult(from, to, compare) {
        return {
            options: { date_from: from, date_to: to, compare },
            totals: {
                amount: 0, order_count: 0, partner_count: 0, region_count: 0,
                previous_amount: 0, growth: null,
                unassigned_amount: 0, unassigned_share: 0, unassigned_partner_count: 0,
            },
            map: [],
            rankings: { regions: [], countries: [], cities: [], customers: [] },
            points: { items: [], total: 0, truncated: false },
        };
    }

    _levelKeys(info, level, indexes) {
        if (level === "country") {
            return info.countryCode ? [info.countryCode] : [];
        }
        const assigned = this._assign(info, indexes);
        const code = assigned[level];
        return code ? [code] : [];
    }

    _groupToLevel(perPartner, infoMap, level, indexes) {
        const buckets = new Map();
        const unassigned = { amount: 0, order_count: 0, partner_count: 0 };
        for (const [partnerId, values] of perPartner) {
            const info = infoMap.get(partnerId);
            const keys = this._levelKeys(info || {}, level, indexes);
            if (!keys.length) {
                unassigned.amount += values.amount;
                unassigned.order_count += values.order_count;
                unassigned.partner_count += 1;
                continue;
            }
            for (const key of keys) {
                const bucket = buckets.get(key) || {
                    amount: 0, order_count: 0, partner_count: 0,
                };
                bucket.amount += values.amount;
                bucket.order_count += values.order_count;
                bucket.partner_count += 1;
                buckets.set(key, bucket);
            }
        }
        return { buckets, unassigned };
    }

    _labelsFor(level, keys, infoMap) {
        const labels = new Map();
        const features = this._geometryCache.get(level) || [];
        for (const feature of features) {
            if (keys.has(feature.properties.code)) {
                labels.set(feature.properties.code, {
                    name: feature.properties.name,
                    code: feature.properties.code,
                    country_code: feature.properties.country_code,
                    center: feature.properties.center,
                });
            }
        }
        if (level === "country") {
            // A customer country with no shipped polygon (micro-states)
            // still deserves its name in the ranking.
            for (const info of infoMap.values()) {
                const code = info?.countryCode;
                if (code && keys.has(code) && !labels.has(code)) {
                    labels.set(code, {
                        name: info.countryName || code,
                        code, country_code: code, center: null,
                    });
                }
            }
        }
        return labels;
    }

    _growth(current, previous) {
        if (!previous) {
            return null;
        }
        return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
    }

    _buildRows(buckets, prevBuckets, labels, comparing) {
        const total = [...buckets.values()].reduce((s, b) => s + b.amount, 0);
        const rows = [];
        for (const [key, bucket] of buckets) {
            const label = labels.get(key) || {};
            const prev = prevBuckets.get(key)?.amount || 0;
            rows.push({
                key: String(key),
                id: null,
                code: label.code || String(key),
                name: label.name || _t("Unknown"),
                country_code: label.country_code || null,
                center: label.center || null,
                amount: Math.round(bucket.amount * 100) / 100,
                order_count: Math.round(bucket.order_count),
                partner_count: bucket.partner_count,
                share: total ? Math.round((bucket.amount / total) * 10000) / 100 : 0,
                previous_amount: Math.round(prev * 100) / 100,
                growth: comparing ? this._growth(bucket.amount, prev) : null,
            });
        }
        rows.sort((a, b) => b.amount - a.amount);
        rows.forEach((row, index) => (row.rank = index + 1));
        return rows;
    }

    _compose(current, previous, infoMap, indexes, from, to, compare) {
        const comparing = Boolean(compare);
        const level = this.state.level;

        const { buckets, unassigned } = this._groupToLevel(current, infoMap, level, indexes);
        const prev = comparing
            ? this._groupToLevel(previous, infoMap, level, indexes).buckets
            : new Map();
        const keys = new Set(buckets.keys());
        const mapRows = this._buildRows(
            buckets, prev, this._labelsFor(level, keys, infoMap), comparing,
        );

        // Country ranking: always country level, stable while zooming.
        let countryRows;
        if (level === "country") {
            countryRows = mapRows;
        } else {
            const grouped = this._groupToLevel(current, infoMap, "country", indexes);
            const prevCountry = comparing
                ? this._groupToLevel(previous, infoMap, "country", indexes).buckets
                : new Map();
            const countryKeys = new Set(grouped.buckets.keys());
            countryRows = this._buildRows(
                grouped.buckets, prevCountry,
                this._labelsFor("country", countryKeys, infoMap), comparing,
            );
        }

        // Cities, keyed country|city so identically named cities stay apart.
        const cityGroup = (source) => {
            const cities = new Map();
            for (const [partnerId, values] of source) {
                const info = infoMap.get(partnerId);
                const city = (info?.city || "").trim();
                if (!city) {
                    continue;
                }
                const key = `${info.countryCode || ""}|${city}`;
                const bucket = cities.get(key) || { amount: 0, order_count: 0, partner_count: 0 };
                bucket.amount += values.amount;
                bucket.order_count += values.order_count;
                bucket.partner_count += 1;
                cities.set(key, bucket);
            }
            return cities;
        };
        const cityBuckets = cityGroup(current);
        const cityLabels = new Map(
            [...cityBuckets.keys()].map((key) => [key, {
                name: key.split("|")[1], code: key.split("|")[0],
            }]),
        );
        const cityRows = this._buildRows(
            cityBuckets, comparing ? cityGroup(previous) : new Map(),
            cityLabels, comparing,
        );

        // Customers.
        const totalAmount = [...current.values()].reduce((s, v) => s + v.amount, 0);
        const customerRows = [...current.entries()].map(([partnerId, values]) => {
            const info = infoMap.get(partnerId) || {};
            const prevAmount = previous.get(partnerId)?.amount || 0;
            return {
                key: `partner_${partnerId}`,
                id: partnerId,
                name: info.name || _t("Unknown customer"),
                city: info.city,
                code: info.countryCode,
                country_code: info.countryCode,
                amount: Math.round(values.amount * 100) / 100,
                order_count: values.order_count,
                partner_count: 1,
                share: totalAmount
                    ? Math.round((values.amount / totalAmount) * 10000) / 100 : 0,
                previous_amount: Math.round(prevAmount * 100) / 100,
                growth: comparing ? this._growth(values.amount, prevAmount) : null,
            };
        });
        customerRows.sort((a, b) => b.amount - a.amount);
        const topCustomers = customerRows.slice(0, TOP_N);
        topCustomers.forEach((row, index) => (row.rank = index + 1));

        // Points layer.
        const points = [];
        for (const [partnerId, values] of current) {
            const info = infoMap.get(partnerId);
            if (!info || (!info.lon && !info.lat)) {
                continue;
            }
            points.push({
                id: partnerId, name: info.name, city: info.city,
                lon: info.lon, lat: info.lat,
                amount: Math.round(values.amount * 100) / 100,
                order_count: values.order_count,
            });
        }
        points.sort((a, b) => b.amount - a.amount);

        const totalOrders = [...current.values()].reduce((s, v) => s + v.order_count, 0);
        const totalPrev = [...previous.values()].reduce((s, v) => s + v.amount, 0);
        return {
            options: { date_from: from, date_to: to, compare },
            totals: {
                amount: Math.round(totalAmount * 100) / 100,
                order_count: totalOrders,
                partner_count: current.size,
                region_count: mapRows.length,
                previous_amount: Math.round(totalPrev * 100) / 100,
                growth: comparing ? this._growth(totalAmount, totalPrev) : null,
                unassigned_amount: Math.round(unassigned.amount * 100) / 100,
                unassigned_share: totalAmount
                    ? Math.round((unassigned.amount / totalAmount) * 1000) / 10 : 0,
                unassigned_partner_count: unassigned.partner_count,
            },
            map: mapRows,
            rankings: {
                regions: mapRows.slice(0, TOP_N),
                countries: countryRows.slice(0, TOP_N),
                cities: cityRows.slice(0, TOP_N),
                customers: topCustomers,
            },
            points: {
                items: points.slice(0, 1500),
                total: points.length,
                truncated: points.length > 1500,
            },
        };
    }

    async reload({ geometry = false } = {}) {
        try {
            if (geometry) {
                await this.loadGeometry();
            }
            await this.loadFigures();
        } catch (error) {
            this.notification.add(this._errorMessage(error), {
                type: "danger",
                title: _t("Analysis failed"),
            });
        }
    }

    _errorMessage(error) {
        return (
            error?.data?.message ||
            error?.message?.data?.message ||
            error?.message ||
            String(error)
        );
    }

    // ------------------------------------------------------------------
    // Playback
    // ------------------------------------------------------------------

    async togglePlay() {
        if (this.state.playing) {
            this.state.playing = false;
            this._playToken++;
            return;
        }
        const last = this.state.periods.length - 1;
        if (last <= 0) {
            return;
        }
        const span = this.state.toIndex - this.state.fromIndex;
        if (this.state.toIndex >= last) {
            this.state.fromIndex = 0;
            this.state.toIndex = Math.min(span, last);
            await this.reload();
        }
        this.state.playing = true;
        const token = ++this._playToken;
        while (this.state.playing && token === this._playToken) {
            if (this.state.toIndex >= last) {
                this.state.playing = false;
                break;
            }
            const started = Date.now();
            this.state.fromIndex += 1;
            this.state.toIndex += 1;
            await this.loadFigures().catch((error) => {
                this.state.playing = false;
                this.notification.add(this._errorMessage(error), { type: "danger" });
            });
            if (token !== this._playToken) {
                return;
            }
            const remaining =
                SalesMapLiteDashboard.PLAY_INTERVAL - (Date.now() - started);
            if (remaining > 0) {
                await new Promise((resolve) => setTimeout(resolve, remaining));
            }
        }
    }

    // ------------------------------------------------------------------
    // Translated static labels -- literal _t() calls in getters so they
    // re-resolve on every render, after translations are loaded. Mirrors
    // "metrics"/"rankingTabs" below, which already did this correctly.
    // ------------------------------------------------------------------

    get appTitle() {
        return _t("Sales Map");
    }

    get mapLevelGroupLabel() {
        return _t("Map level");
    }

    get worldLabel() {
        return _t("World");
    }

    get drillDownPathLabel() {
        return _t("Drill-down path");
    }

    get basisSelectTitle() {
        return _t("Which documents count as revenue");
    }

    get partnerBasisSelectTitle() {
        return _t("Which address decides where revenue is counted");
    }

    get metricSelectTitle() {
        return _t("Metric shown on the map");
    }

    get compareModeSelectTitle() {
        return _t("Which period the figures are compared against");
    }

    get classificationSelectTitle() {
        return _t("How the colour classes are formed");
    }

    get pointsToggleTitle() {
        return _t("Show customer locations as proportional circles");
    }

    get customersLabel() {
        return _t("Customers");
    }

    get loadingAnalysisLabel() {
        return _t("Loading analysis …");
    }

    get errorHeading() {
        return _t("The analysis could not be loaded");
    }

    get netRevenueLabel() {
        return _t("Net revenue in period");
    }

    get documentsKpiLabel() {
        return _t("Documents");
    }

    get emptyDatabaseMessage() {
        return _t(
            "No revenue documents were found on this database for the selected basis (%(basis)s). The map stays empty until sales orders or invoices exist.",
            { basis: this.state.source?.label ?? "" },
        );
    }

    get noRevenueInPeriodMessage() {
        return _t("No revenue in the selected period. Widen the period below.");
    }

    get loadingBoundariesLabel() {
        return _t("Loading boundaries …");
    }

    get noMapBasisLabel() {
        return _t("No map basis available");
    }

    get closeLabel() {
        return _t("Close");
    }

    get revenueLabel() {
        return _t("Revenue");
    }

    get shareLabel() {
        return _t("Share");
    }

    get noRevenueInPeriodShort() {
        return _t("No revenue in the selected period.");
    }

    get drillDownLabel() {
        return _t("Drill down");
    }

    get sourceLabelPrefix() {
        return _t("Source:");
    }

    get footerNote() {
        return _t("net (untaxed) amounts, company currency, converted at document-date rates");
    }

    get comparedAgainstLabel() {
        return _t("compared against");
    }

    get rankingEmptyLabel() {
        return _t("No revenue in the selected period.");
    }

    get openCustomersTitle() {
        return _t("Open the underlying customers");
    }

    // ------------------------------------------------------------------
    // Derived values for the template
    // ------------------------------------------------------------------

    get features() {
        return this._features;
    }

    get referenceFeatures() {
        return [];
    }

    get valuesByKey() {
        const map = {};
        for (const row of this.state.result?.map ?? []) {
            map[row.key] = row;
        }
        return map;
    }

    get scale() {
        const rows = this.state.result?.map ?? [];
        const metric = this.state.metric;
        const values = rows
            .map((row) => (metric === "growth" ? row.growth : row[metric]))
            .filter((value) => Number.isFinite(value));
        return buildScale(values, {
            classes: this.state.classes,
            method: this.state.classification,
            diverging: metric === "growth",
        });
    }

    // Labels below are built with literal _t() calls inside these getters --
    // not on the module-level constants above -- so they re-resolve on every
    // render (after translations are loaded) and stay extractable for .pot
    // generation, matching how "metrics" and "rankingTabs" already do it.
    // The constants stay the single source of truth for the *keys*.

    get classifications() {
        const LABELS = {
            quantile: () => _t("Quantiles (equal group size)"),
            equal: () => _t("Equal intervals"),
        };
        return CLASSIFICATIONS.map((entry) => ({ key: entry.key, label: LABELS[entry.key]() }));
    }

    get levels() {
        const LABELS = {
            country: () => _t("Countries"),
            nuts1: () => _t("Europe: NUTS 1"),
            nuts2: () => _t("Europe: NUTS 2"),
        };
        return LEVELS.map((entry) => ({ key: entry.key, label: LABELS[entry.key]() }));
    }

    get revenueBases() {
        const LABELS = {
            invoices: () => _t("Invoiced (net)"),
            orders: () => _t("Order intake (net)"),
        };
        return REVENUE_BASES.map((entry) => ({ key: entry.key, label: LABELS[entry.key]() }));
    }

    get partnerBases() {
        const LABELS = {
            invoice: () => _t("Invoice address"),
            shipping: () => _t("Delivery address"),
            commercial: () => _t("Commercial parent"),
        };
        return PARTNER_BASES.map((entry) => ({ key: entry.key, label: LABELS[entry.key]() }));
    }

    get compareModes() {
        const LABELS = {
            none: () => _t("No comparison"),
            previous: () => _t("Previous period"),
            year: () => _t("Same period last year"),
        };
        return COMPARE_MODES.map((entry) => ({ key: entry.key, label: LABELS[entry.key]() }));
    }

    get comparing() {
        return this.state.compareMode !== "none";
    }

    get compareLabel() {
        if (this.state.compareMode === "year") {
            return _t("vs. last year");
        }
        if (this.state.compareMode === "previous") {
            return _t("vs. prev. period");
        }
        return "";
    }

    get compareRangeLabel() {
        const compare = this.state.result?.options?.compare;
        return compare ? `${compare.from} – ${compare.to}` : "";
    }

    /** "vs. prev. period" alone does not say which dates that is -- append
     * them so the KPI tile is self-explanatory without a separate lookup. */
    get compareSubLabel() {
        const range = this.compareRangeLabel;
        return range ? `${this.compareLabel} (${range})` : this.compareLabel;
    }

    get metrics() {
        const metrics = [
            { key: "amount", label: _t("Revenue") },
            { key: "share", label: _t("Revenue share") },
            { key: "order_count", label: _t("Documents") },
            { key: "partner_count", label: _t("Customers") },
        ];
        if (this.comparing) {
            metrics.push({ key: "growth", label: _t("Change vs. comparison") });
        }
        return metrics;
    }

    get rankingTabs() {
        const rankings = this.state.result?.rankings ?? {};
        return [
            { key: "regions", label: _t("Regions") },
            { key: "countries", label: _t("Countries") },
            { key: "cities", label: _t("Cities") },
            { key: "customers", label: _t("Customers") },
        ].map((tab) => ({ ...tab, count: (rankings[tab.key] ?? []).length }));
    }

    get activeRankingRows() {
        return this.state.result?.rankings?.[this.state.activeRanking] ?? [];
    }

    get activeRankingHeader() {
        switch (this.state.activeRanking) {
            case "countries": return _t("Country");
            case "cities": return _t("City");
            case "customers": return _t("Customer");
            default: return _t("Region");
        }
    }

    get hasRevenueInPeriod() {
        return (this.state.result?.totals?.amount ?? 0) !== 0 ||
            (this.state.result?.totals?.order_count ?? 0) !== 0;
    }

    get coverageWarning() {
        const totals = this.state.result?.totals;
        if (!totals || !totals.unassigned_amount) {
            return null;
        }
        return {
            share: totals.unassigned_share,
            amount: totals.unassigned_amount,
            partners: totals.unassigned_partner_count,
            severe: totals.unassigned_share >= 10,
        };
    }

    /**
     * One coherent, translatable sentence rather than fragments of English
     * text stitched together in the template around t-esc nodes -- a
     * translator needs the whole sentence to get word order and grammar
     * right, and %(name)s placeholders let them reorder freely.
     */
    get coverageMessage() {
        const c = this.coverageWarning;
        if (!c) {
            return "";
        }
        const customers = c.partners === 1
            ? _t("%(partners)s customer", { partners: c.partners })
            : _t("%(partners)s customers", { partners: c.partners });
        return _t(
            "%(share)s% of revenue (%(amount)s, %(customers)s) could not be attributed to a region on this level. It is included in the totals above but missing from the map.",
            {
                share: c.share.toFixed(1),
                amount: this.formatCurrency(c.amount),
                customers,
            },
        );
    }

    get coverageHint() {
        if (this.state.level === "country") {
            return _t("Most common cause: contacts without a country on the address.");
        }
        return _t("NUTS levels need customer coordinates (geolocated contacts); the country level works from the address country alone.");
    }

    get basisWarning() {
        const source = this.state.source;
        if (!source) {
            return null;
        }
        const notes = [];
        if (source.fallback) {
            notes.push(_t("The selected revenue basis is not readable with your permissions; figures from the other basis are shown and labeled below."));
        }
        if (source.requestedPartnerBasis !== source.partnerBasis) {
            notes.push(_t("The delivery address is not available on this data source; the invoice address is used."));
        }
        return notes.length ? notes.join(" ") : null;
    }

    get attribution() {
        return this._features[0]?.properties?.attribution ?? "";
    }

    get hasGeometry() {
        return this._features.length > 0;
    }

    get selectedRow() {
        return this.state.selectedKey
            ? this.valuesByKey[this.state.selectedKey] ?? null : null;
    }

    get selectedFeature() {
        if (!this.state.selectedKey) {
            return null;
        }
        return this._features.find(
            (feature) => feature.properties.key === this.state.selectedKey,
        ) ?? null;
    }

    get selectedName() {
        return this.selectedRow?.name ??
            this.selectedFeature?.properties?.name ?? this.state.selectedKey;
    }

    get selectedDrillLevel() {
        return this.selectedFeature?.properties?.drill_level ?? null;
    }

    get breadcrumbs() {
        return this.state.drillStack;
    }

    // ------------------------------------------------------------------
    // Formatting
    // ------------------------------------------------------------------

    formatValue = (value) => {
        if (!Number.isFinite(value)) {
            return "–";
        }
        const metric = this.state.metric;
        if (metric === "share") {
            return `${value.toFixed(1)}%`;
        }
        if (metric === "growth") {
            return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
        }
        if (metric === "order_count" || metric === "partner_count") {
            return this._formatNumber(value, 0);
        }
        return this.formatCurrency(value);
    };

    formatCurrency = (value) => {
        if (!Number.isFinite(value)) {
            return "–";
        }
        const currency = this.state.currency;
        const compact = Math.abs(value) >= 1000;
        const text = compact
            ? this._formatCompact(value)
            : this._formatNumber(value, currency?.decimal_places ?? 2);
        if (!currency?.symbol) {
            return text;
        }
        return currency.position === "before"
            ? `${currency.symbol} ${text}` : `${text} ${currency.symbol}`;
    };

    formatNumber = (value) => this._formatNumber(value, 0);

    _formatNumber(value, digits) {
        return value.toLocaleString(undefined, {
            minimumFractionDigits: digits,
            maximumFractionDigits: digits,
        });
    }

    _formatCompact(value) {
        const absolute = Math.abs(value);
        // Short suffixes, not full words: "bn" reads as nothing in German,
        // where the convention is "Mrd." rather than the English billion.
        if (absolute >= 1e9) return `${this._formatNumber(value / 1e9, 1)}${_t("bn")}`;
        if (absolute >= 1e6) return `${this._formatNumber(value / 1e6, 1)}${_t("M")}`;
        if (absolute >= 1e3) return `${this._formatNumber(value / 1e3, 0)}${_t("k")}`;
        return this._formatNumber(value, 0);
    }

    // ------------------------------------------------------------------
    // Controls
    // ------------------------------------------------------------------

    async onLevelChange(level) {
        if (level === this.state.level) {
            return;
        }
        this.state.level = level;
        this.state.drillStack = [];
        this.state.selectedKey = null;
        await this.reload({ geometry: true });
    }

    async onBasisChange(event) {
        this.state.basis = event.target.value;
        this._storeSettings();
        this.state.selectedKey = null;
        await this.loadEverything();
    }

    async onPartnerBasisChange(event) {
        this.state.partnerBasis = event.target.value;
        this._storeSettings();
        this.state.selectedKey = null;
        await this.loadEverything();
    }

    async drillDown() {
        const feature = this.selectedFeature;
        const childLevel = this.selectedDrillLevel;
        if (!feature || !childLevel) {
            return;
        }
        this.state.drillStack = [...this.state.drillStack, {
            level: childLevel,
            parentCode: feature.properties.code,
            label: feature.properties.name,
        }];
        this.state.level = childLevel;
        this.state.selectedKey = null;
        await this.reload({ geometry: true });
    }

    async drillTo(index) {
        const stack = this.state.drillStack;
        if (index >= stack.length - 1) {
            return;
        }
        const target = index < 0 ? [] : stack.slice(0, index + 1);
        this.state.drillStack = target;
        this.state.level = target.length
            ? target[target.length - 1].level : "country";
        this.state.selectedKey = null;
        await this.reload({ geometry: true });
    }

    onMetricChange(event) {
        this.state.metric = event.target.value;
    }

    onClassificationChange(event) {
        this.state.classification = event.target.value;
    }

    async onCompareModeChange(event) {
        this.state.compareMode = event.target.value;
        if (!this.comparing && this.state.metric === "growth") {
            this.state.metric = "amount";
        }
        await this.reload();
    }

    onPointsToggle() {
        this.state.showPoints = !this.state.showPoints;
    }

    onRankingTab(key) {
        this.state.activeRanking = key;
    }

    async onRangeChange(payload) {
        this.state.fromIndex = payload.fromIndex;
        this.state.toIndex = payload.toIndex;
        await this.reload();
    }

    onRegionClick = (properties) => {
        if (this.state.selectedKey === properties.key) {
            this.state.selectedKey = null;
            return;
        }
        this.state.selectedKey = properties.key;
        // "Regions" always mirrors the map's current level (country/NUTS1/
        // NUTS2), so it is the one ranking tab guaranteed to contain a row
        // for whatever was just clicked -- switching to it is what makes
        // the click visible (highlighted, scrolled into view) in the table
        // on the right instead of only in the map popup.
        this.state.activeRanking = "regions";
    };

    onRankingRowClick = (row) => {
        if (this.state.activeRanking === "customers" && row.id) {
            this.action.doAction({
                type: "ir.actions.act_window",
                res_model: "res.partner",
                res_id: row.id,
                views: [[false, "form"]],
            });
            return;
        }
        if (row.key) {
            this.state.selectedKey =
                this.state.selectedKey === row.key ? null : row.key;
        }
    };

    closeSelection() {
        this.state.selectedKey = null;
    }

    // ------------------------------------------------------------------
    // Drill into the standard objects
    // ------------------------------------------------------------------

    /**
     * Customers of the selected region that carry revenue in the period --
     * derived from the same aggregation the map is built from, so list and
     * map always agree.
     */
    async _partnersInSelection() {
        const key = this.state.selectedKey;
        const { from, to } = this._selectedRange();
        const cached = this._currentPerPartner;
        const current = (cached && cached.from === from && cached.to === to)
            ? cached.data
            : await this.data.perPartner(this.source, from, to);
        const info = await this.data.partnerInfo([...current.keys()]);
        const indexes = await this._ensureNutsIndexes();
        const ids = [];
        for (const partnerId of current.keys()) {
            const keys = this._levelKeys(
                info.get(partnerId) || {}, this.state.level, indexes,
            );
            if (keys.includes(key)) {
                ids.push(partnerId);
            }
        }
        return ids;
    }

    async openCustomers() {
        if (!this.state.selectedKey) {
            return;
        }
        try {
            const ids = await this._partnersInSelection();
            this.action.doAction({
                type: "ir.actions.act_window",
                name: _t("Customers: %s", this.selectedName),
                res_model: "res.partner",
                view_mode: "list,form",
                views: [[false, "list"], [false, "form"]],
                domain: [["id", "in", ids]],
                context: { create: false },
            });
        } catch (error) {
            this.notification.add(this._errorMessage(error), { type: "danger" });
        }
    }

    /**
     * Whichever document actually carries the figures on screen: customer
     * invoices when the basis is invoiced revenue, sale orders for order
     * intake. Never the reporting view -- opening account.invoice.report or
     * sale.report itself would show report rows, not documents with a form
     * view to drill into.
     */
    get documentsLabel() {
        return this.source?.model === "account.invoice.report"
            ? _t("Customer Invoices")
            : _t("Sales Orders");
    }

    get documentsOpenTitle() {
        return this.source?.model === "account.invoice.report"
            ? _t("Open the underlying customer invoices")
            : _t("Open the underlying sales orders");
    }

    async _openDocuments(partnerIds, name) {
        const { from, to } = this._selectedRange();
        const { model, domain } = this.data.documentTarget(this.source, partnerIds, from, to);
        this.action.doAction({
            type: "ir.actions.act_window",
            name,
            res_model: model,
            view_mode: "list,form",
            views: [[false, "list"], [false, "form"]],
            domain,
            context: { create: false },
        });
    }

    async openOrders() {
        if (!this.state.selectedKey) {
            return;
        }
        try {
            const ids = await this._partnersInSelection();
            await this._openDocuments(
                ids, _t("%(documents)s: %(scope)s",
                    { documents: this.documentsLabel, scope: this.selectedName }),
            );
        } catch (error) {
            this.notification.add(this._errorMessage(error), { type: "danger" });
        }
    }

    /** Every document behind the "Net revenue" / "Documents" KPIs -- the
     * exact set that was summed and counted there. */
    async openPeriodDocuments() {
        try {
            await this._openDocuments(null, this.documentsLabel);
        } catch (error) {
            this.notification.add(this._errorMessage(error), { type: "danger" });
        }
    }

    /** Every customer behind the "Customers" KPI, reusing the aggregation
     * already cached for the current period -- no extra round trip. */
    async openPeriodCustomers() {
        try {
            const cached = this._currentPerPartner;
            const ids = cached ? [...cached.data.keys()] : [];
            this.action.doAction({
                type: "ir.actions.act_window",
                name: _t("Customers"),
                res_model: "res.partner",
                view_mode: "list,form",
                views: [[false, "list"], [false, "form"]],
                domain: [["id", "in", ids]],
                context: { create: false },
            });
        } catch (error) {
            this.notification.add(this._errorMessage(error), { type: "danger" });
        }
    }

    /** A customer marker on the map, clicked rather than merely hovered. */
    onPointClick = (point) => {
        this.action.doAction({
            type: "ir.actions.act_window",
            res_model: "res.partner",
            res_id: point.id,
            views: [[false, "form"]],
        });
    };
}

SalesMapLiteDashboard.template = xml`
<div class="o_geo_dashboard o_action h-100 d-flex flex-column">

    <!-- ===================== Top bar ===================== -->
    <div class="o_geo_topbar">
        <div class="o_geo_topbar_main">
            <span class="o_geo_topbar_title"><t t-esc="appTitle"/></span>

            <div class="btn-group btn-group-sm ms-3" role="group" t-att-aria-label="mapLevelGroupLabel">
                <button t-foreach="levels" t-as="entry" t-key="entry.key"
                        class="btn"
                        t-att-class="state.level === entry.key ? 'btn-primary' : 'btn-outline-secondary'"
                        t-on-click="() => this.onLevelChange(entry.key)">
                    <t t-esc="entry.label"/>
                </button>
            </div>

            <nav class="o_geo_breadcrumb ms-2" t-if="breadcrumbs.length" t-att-aria-label="drillDownPathLabel">
                <a href="#" t-on-click.prevent="() => this.drillTo(-1)"><t t-esc="worldLabel"/></a>
                <t t-foreach="breadcrumbs" t-as="crumb" t-key="crumb_index">
                    <span class="mx-1 text-muted">/</span>
                    <a href="#" t-if="crumb_index &lt; breadcrumbs.length - 1"
                       t-on-click.prevent="() => this.drillTo(crumb_index)">
                        <t t-esc="crumb.label"/>
                    </a>
                    <span t-else="" class="fw-bold"><t t-esc="crumb.label"/></span>
                </t>
            </nav>
        </div>

        <div class="o_geo_topbar_tools">
            <select class="form-select form-select-sm o_geo_select"
                    t-on-change="onBasisChange" t-att-title="basisSelectTitle">
                <option t-foreach="revenueBases" t-as="entry" t-key="entry.key"
                        t-att-value="entry.key" t-att-selected="entry.key === state.basis">
                    <t t-esc="entry.label"/>
                </option>
            </select>
            <select class="form-select form-select-sm o_geo_select"
                    t-on-change="onPartnerBasisChange"
                    t-att-title="partnerBasisSelectTitle">
                <option t-foreach="partnerBases" t-as="entry" t-key="entry.key"
                        t-att-value="entry.key" t-att-selected="entry.key === state.partnerBasis">
                    <t t-esc="entry.label"/>
                </option>
            </select>
            <select class="form-select form-select-sm o_geo_select"
                    t-on-change="onMetricChange" t-att-title="metricSelectTitle">
                <option t-foreach="metrics" t-as="metric" t-key="metric.key"
                        t-att-value="metric.key" t-att-selected="metric.key === state.metric">
                    <t t-esc="metric.label"/>
                </option>
            </select>
            <select class="form-select form-select-sm o_geo_select"
                    t-on-change="onCompareModeChange"
                    t-att-title="compareModeSelectTitle">
                <option t-foreach="compareModes" t-as="mode" t-key="mode.key"
                        t-att-value="mode.key" t-att-selected="mode.key === state.compareMode">
                    <t t-esc="mode.label"/>
                </option>
            </select>
            <select class="form-select form-select-sm o_geo_select"
                    t-on-change="onClassificationChange"
                    t-att-title="classificationSelectTitle">
                <option t-foreach="classifications" t-as="item" t-key="item.key"
                        t-att-value="item.key" t-att-selected="item.key === state.classification">
                    <t t-esc="item.label"/>
                </option>
            </select>
            <button class="btn btn-sm"
                    t-att-class="state.showPoints ? 'btn-primary' : 'btn-outline-secondary'"
                    t-on-click="onPointsToggle"
                    t-att-title="pointsToggleTitle">
                <i class="fa fa-map-marker me-1"/><t t-esc="customersLabel"/>
            </button>
        </div>
    </div>

    <!-- ===================== Loading / error ===================== -->
    <div t-if="state.loading" class="o_geo_center flex-grow-1">
        <div class="text-center text-muted">
            <i class="fa fa-circle-o-notch fa-spin fa-2x"/>
            <div class="mt-2"><t t-esc="loadingAnalysisLabel"/></div>
        </div>
    </div>

    <div t-elif="state.error" class="o_geo_center flex-grow-1">
        <div class="alert alert-danger mx-4" role="alert">
            <h5 class="alert-heading"><t t-esc="errorHeading"/></h5>
            <p class="mb-0"><t t-esc="state.error"/></p>
        </div>
    </div>

    <t t-elif="state.ready and state.result">
        <!-- ===================== Key figures ===================== -->
        <div class="o_geo_kpis">
            <div class="o_geo_kpi o_geo_kpi_clickable" role="button" tabindex="0"
                 t-on-click="openPeriodDocuments"
                 t-att-title="documentsOpenTitle">
                <div class="o_geo_kpi_label"><t t-esc="netRevenueLabel"/></div>
                <div class="o_geo_kpi_value">
                    <t t-esc="formatCurrency(state.result.totals.amount)"/>
                </div>
                <div class="o_geo_kpi_sub" t-if="comparing">
                    <span t-if="state.result.totals.growth !== null"
                          t-att-class="state.result.totals.growth >= 0 ? 'text-success' : 'text-danger'">
                        <t t-esc="state.result.totals.growth > 0 ? '+' : ''"/><t t-esc="state.result.totals.growth.toFixed(1)"/>%
                    </span>
                    <span class="text-muted">
                        <t t-esc="compareSubLabel"/>:
                        <t t-esc="formatCurrency(state.result.totals.previous_amount)"/>
                    </span>
                </div>
            </div>
            <div class="o_geo_kpi o_geo_kpi_clickable" role="button" tabindex="0"
                 t-on-click="openPeriodDocuments"
                 t-att-title="documentsOpenTitle">
                <div class="o_geo_kpi_label"><t t-esc="documentsKpiLabel"/></div>
                <div class="o_geo_kpi_value">
                    <t t-esc="formatNumber(state.result.totals.order_count)"/>
                </div>
                <div class="o_geo_kpi_sub text-muted">
                    <t t-esc="documentsLabel"/>
                </div>
            </div>
            <div class="o_geo_kpi o_geo_kpi_clickable" role="button" tabindex="0"
                 t-on-click="openPeriodCustomers"
                 t-att-title="openCustomersTitle">
                <div class="o_geo_kpi_label"><t t-esc="customersLabel"/></div>
                <div class="o_geo_kpi_value">
                    <t t-esc="formatNumber(state.result.totals.partner_count)"/>
                </div>
            </div>
        </div>

        <!-- ===================== Data quality ===================== -->
        <div class="o_geo_notices">
            <div t-if="state.empty"
                 class="alert alert-info py-1 px-2 mb-1 small" role="alert">
                <i class="fa fa-info-circle me-1"/>
                <t t-esc="emptyDatabaseMessage"/>
            </div>
            <div t-elif="!hasRevenueInPeriod"
                 class="alert alert-info py-1 px-2 mb-1 small" role="alert">
                <i class="fa fa-info-circle me-1"/>
                <t t-esc="noRevenueInPeriodMessage"/>
            </div>
            <div t-if="basisWarning"
                 class="alert alert-warning py-1 px-2 mb-1 small" role="alert">
                <i class="fa fa-exclamation-triangle me-1"/>
                <t t-esc="basisWarning"/>
            </div>
            <div t-if="coverageWarning"
                 class="alert py-1 px-2 mb-1 small"
                 t-att-class="coverageWarning.severe ? 'alert-warning' : 'alert-light'"
                 role="alert">
                <i class="fa fa-exclamation-triangle me-1"/>
                <t t-esc="coverageMessage"/>
                <t t-esc="coverageHint"/>
            </div>
        </div>

        <!-- ===================== Map and rankings ===================== -->
        <div class="o_geo_body flex-grow-1">
            <div class="o_geo_map_pane">
                <div t-if="state.geometryLoading" class="o_geo_map_overlay">
                    <i class="fa fa-circle-o-notch fa-spin"/>
                    <span class="ms-2"><t t-esc="loadingBoundariesLabel"/></span>
                </div>
                <ChoroplethMap t-if="hasGeometry"
                               features="features"
                               referenceFeatures="referenceFeatures"
                               valuesByKey="valuesByKey"
                               scale="scale"
                               level="state.level"
                               points="state.result.points"
                               showPoints="state.showPoints"
                               metric="state.metric"
                               formatValue="formatValue"
                               selectedKey="state.selectedKey"
                               onRegionClick="onRegionClick"
                               onPointClick="onPointClick"/>
                <div t-else="" class="o_geo_center h-100 text-muted">
                    <t t-esc="noMapBasisLabel"/>
                </div>

                <!-- Region popup: KPIs plus the jump into the standard
                     objects: map > region > customer list > contact >
                     sales orders. -->
                <div class="o_geo_region_popup" t-if="state.selectedKey">
                    <div class="o_geo_region_popup_header">
                        <strong><t t-esc="selectedName"/></strong>
                        <button class="btn btn-sm btn-link text-muted p-0 ms-2"
                                t-att-title="closeLabel" t-on-click="closeSelection">
                            <i class="fa fa-times"/>
                        </button>
                    </div>
                    <t t-if="selectedRow">
                        <div class="o_geo_region_popup_kpis">
                            <div>
                                <span class="text-muted"><t t-esc="revenueLabel"/></span>
                                <strong><t t-esc="formatCurrency(selectedRow.amount)"/></strong>
                            </div>
                            <div>
                                <span class="text-muted"><t t-esc="shareLabel"/></span>
                                <strong><t t-esc="selectedRow.share !== null ? selectedRow.share.toFixed(1) + '%' : '–'"/></strong>
                            </div>
                            <div>
                                <span class="text-muted"><t t-esc="customersLabel"/></span>
                                <strong><t t-esc="selectedRow.partner_count"/></strong>
                            </div>
                            <div>
                                <span class="text-muted"><t t-esc="documentsKpiLabel"/></span>
                                <strong><t t-esc="selectedRow.order_count"/></strong>
                            </div>
                            <div t-if="comparing and selectedRow.growth !== null">
                                <span class="text-muted"><t t-esc="compareLabel"/></span>
                                <strong t-att-class="selectedRow.growth >= 0 ? 'text-success' : 'text-danger'">
                                    <t t-esc="(selectedRow.growth > 0 ? '+' : '') + selectedRow.growth.toFixed(1)"/>%
                                </strong>
                            </div>
                        </div>
                    </t>
                    <div t-else="" class="text-muted small py-1">
                        <t t-esc="noRevenueInPeriodShort"/>
                    </div>
                    <div class="o_geo_region_popup_actions">
                        <button class="btn btn-sm btn-primary" t-on-click="openCustomers">
                            <i class="fa fa-users me-1"/><t t-esc="customersLabel"/>
                        </button>
                        <button class="btn btn-sm btn-outline-secondary" t-on-click="openOrders">
                            <i class="fa fa-list me-1"/><t t-esc="documentsLabel"/>
                        </button>
                        <button class="btn btn-sm btn-outline-secondary"
                                t-if="selectedDrillLevel" t-on-click="drillDown">
                            <i class="fa fa-search-plus me-1"/><t t-esc="drillDownLabel"/>
                        </button>
                    </div>
                </div>
            </div>

            <div class="o_geo_side_pane">
                <ul class="nav nav-tabs o_geo_tabs">
                    <li class="nav-item" t-foreach="rankingTabs" t-as="tab" t-key="tab.key">
                        <a href="#" class="nav-link"
                           t-att-class="{ 'active': state.activeRanking === tab.key }"
                           t-on-click.prevent="() => this.onRankingTab(tab.key)">
                            <t t-esc="tab.label"/>
                            <span class="badge text-bg-light ms-1" t-if="tab.count">
                                <t t-esc="tab.count"/>
                            </span>
                        </a>
                    </li>
                </ul>
                <div class="o_geo_side_scroll">
                    <RankingTable rows="activeRankingRows"
                                  labelHeader="activeRankingHeader"
                                  formatValue="formatValue"
                                  showGrowth="comparing"
                                  compareLabel="compareLabel"
                                  selectedKey="state.selectedKey"
                                  emptyLabel="rankingEmptyLabel"
                                  onRowClick="onRankingRowClick"/>
                </div>
            </div>
        </div>

        <!-- ===================== Period ===================== -->
        <div class="o_geo_footer">
            <TimeRangeSlider periods="state.periods"
                             fromIndex="state.fromIndex"
                             toIndex="state.toIndex"
                             formatValue="formatCurrency"
                             playing="state.playing"
                             onPlayToggle="() => this.togglePlay()"
                             onChange="(payload) => this.onRangeChange(payload)"/>
            <div class="o_geo_source text-muted small">
                <t t-esc="sourceLabelPrefix"/> <t t-esc="state.source.label"/>
                · <t t-esc="footerNote"/>
                <t t-if="comparing and compareRangeLabel">
                    · <t t-esc="comparedAgainstLabel"/> <t t-esc="compareRangeLabel"/>
                </t>
                <t t-if="attribution">· <t t-esc="attribution"/></t>
                · Sales Map Lite
            </div>
        </div>
    </t>
</div>
`;

registry.category("actions").add("sales_map_lite.dashboard", SalesMapLiteDashboard);
