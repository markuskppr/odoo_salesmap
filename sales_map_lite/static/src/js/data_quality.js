/** @odoo-module **/

import { Component, onWillStart, useState, xml } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { _t } from "@web/core/l10n/translation";
import { SalesDataLayer, REVENUE_BASES, PARTNER_BASES } from "./data_layer";

/**
 * Data quality audit -- own page, own menu entry.
 *
 * Not a tab squeezed into the map dashboard's side panel: the whole point is
 * to see every customer with revenue at once, so the table gets the full
 * page. All-time by design too -- a period filter would hide exactly the
 * older, half-forgotten contacts most likely to be missing a country or
 * coordinates, which are precisely what this view exists to surface.
 */
export class SalesMapLiteDataQuality extends Component {
    static props = ["*"];

    setup() {
        this.orm = useService("orm");
        this.action = useService("action");
        this.notification = useService("notification");
        this.data = new SalesDataLayer(this.orm);

        this.state = useState({
            loading: true,
            error: null,
            rows: [],
            sourceLabel: "",
            basis: "invoices",
            partnerBasis: "invoice",
            sortBy: "missing",
            desc: true,
        });

        onWillStart(async () => {
            await this.load();
        });
    }

    async load() {
        this.state.loading = true;
        this.state.error = null;
        try {
            const source = await this.data.resolveSource(this.state.basis, this.state.partnerBasis);
            this.state.sourceLabel = source.label;
            const current = await this.data.perPartner(source, null, null);
            const info = await this.data.partnerInfo([...current.keys()]);
            this.state.rows = [...current.entries()].map(([partnerId, values]) => {
                const partner = info.get(partnerId) || {};
                const hasCoords = Boolean(partner.lon || partner.lat);
                return {
                    id: partnerId,
                    name: partner.name || _t("Unknown customer"),
                    country_name: partner.countryName || null,
                    has_country: Boolean(partner.countryCode),
                    lat: hasCoords ? partner.lat : null,
                    lon: hasCoords ? partner.lon : null,
                    has_coords: hasCoords,
                    amount: Math.round(values.amount * 100) / 100,
                };
            });
        } catch (error) {
            this.state.error = this._errorMessage(error);
        } finally {
            this.state.loading = false;
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

    async onBasisChange(event) {
        this.state.basis = event.target.value;
        await this.load();
    }

    async onPartnerBasisChange(event) {
        this.state.partnerBasis = event.target.value;
        await this.load();
    }

    // ------------------------------------------------------------------
    // Translated static labels -- literal _t() calls in getters so they
    // re-resolve on every render, after translations are loaded. Same
    // pattern as dashboard.js.
    // ------------------------------------------------------------------

    get pageTitle() {
        return _t("Data Quality");
    }

    get basisSelectTitle() {
        return _t("Which documents count as revenue");
    }

    get partnerBasisSelectTitle() {
        return _t("Which address decides where revenue is counted");
    }

    get sourceLabelPrefix() {
        return _t("Source:");
    }

    get customerHeader() {
        return _t("Customer");
    }

    get countryHeader() {
        return _t("Country");
    }

    get coordinatesHeader() {
        return _t("Coordinates");
    }

    get totalRevenueHeader() {
        return _t("Total revenue");
    }

    get missingLabel() {
        return _t("missing");
    }

    get noCustomersLabel() {
        return _t("No customers found.");
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

    get missingCount() {
        return this.state.rows.filter((r) => !r.has_country || !r.has_coords).length;
    }

    get summaryText() {
        return _t(
            "%(missing)s of %(total)s customers are missing a country and/or coordinates.",
            { missing: this.missingCount, total: this.state.rows.length },
        );
    }

    // ------------------------------------------------------------------
    // Table
    // ------------------------------------------------------------------

    get sortedRows() {
        const { sortBy, desc } = this.state;
        const rows = [...this.state.rows];
        rows.sort((a, b) => {
            if (sortBy === "missing") {
                const missA = (a.has_country ? 0 : 1) + (a.has_coords ? 0 : 1);
                const missB = (b.has_country ? 0 : 1) + (b.has_coords ? 0 : 1);
                return (desc ? missB - missA : missA - missB) || b.amount - a.amount;
            }
            const left = a[sortBy];
            const right = b[sortBy];
            const leftMissing = left === null || left === undefined;
            const rightMissing = right === null || right === undefined;
            if (leftMissing && rightMissing) return 0;
            if (leftMissing) return 1;
            if (rightMissing) return -1;
            if (typeof left === "string") {
                return desc ? right.localeCompare(left) : left.localeCompare(right);
            }
            return desc ? right - left : left - right;
        });
        return rows;
    }

    sortOn(field) {
        if (this.state.sortBy === field) {
            this.state.desc = !this.state.desc;
        } else {
            this.state.sortBy = field;
            this.state.desc = true;
        }
    }

    sortIndicator(field) {
        if (this.state.sortBy !== field) {
            return "";
        }
        return this.state.desc ? "fa-caret-down" : "fa-caret-up";
    }

    countryLabel(row) {
        return row.country_name || this.missingLabel;
    }

    coordsLabel(row) {
        if (!row.has_coords) {
            return this.missingLabel;
        }
        return `${row.lat.toFixed(4)}, ${row.lon.toFixed(4)}`;
    }

    formatCurrency(value) {
        return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
    }

    openPartner(row) {
        this.action.doAction({
            type: "ir.actions.act_window",
            res_model: "res.partner",
            res_id: row.id,
            views: [[false, "form"]],
        });
    }
}

SalesMapLiteDataQuality.template = xml`
<div class="o_geo_dashboard o_action h-100 d-flex flex-column">
    <div class="o_geo_topbar">
        <div class="o_geo_topbar_main">
            <span class="o_geo_topbar_title"><t t-esc="pageTitle"/></span>
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
                    t-on-change="onPartnerBasisChange" t-att-title="partnerBasisSelectTitle">
                <option t-foreach="partnerBases" t-as="entry" t-key="entry.key"
                        t-att-value="entry.key" t-att-selected="entry.key === state.partnerBasis">
                    <t t-esc="entry.label"/>
                </option>
            </select>
        </div>
    </div>

    <div t-if="state.loading" class="o_geo_center flex-grow-1">
        <div class="text-center text-muted">
            <i class="fa fa-circle-o-notch fa-spin fa-2x"/>
        </div>
    </div>

    <div t-elif="state.error" class="o_geo_center flex-grow-1">
        <div class="alert alert-danger mx-4" role="alert">
            <t t-esc="state.error"/>
        </div>
    </div>

    <t t-else="">
        <div class="o_geo_quality_summary text-muted small px-3 py-2">
            <t t-esc="summaryText"/>
            · <t t-esc="sourceLabelPrefix"/> <t t-esc="state.sourceLabel"/>
        </div>

        <div class="o_geo_quality_scroll flex-grow-1">
            <table class="table table-sm table-hover o_geo_rank_table mb-0">
                <thead>
                    <tr>
                        <th class="o_geo_clickable" t-on-click="() => this.sortOn('name')">
                            <t t-esc="customerHeader"/>
                            <i t-att-class="'fa ms-1 ' + sortIndicator('name')"/>
                        </th>
                        <th class="o_geo_clickable" t-on-click="() => this.sortOn('country_name')">
                            <t t-esc="countryHeader"/>
                            <i t-att-class="'fa ms-1 ' + sortIndicator('country_name')"/>
                        </th>
                        <th class="o_geo_clickable" t-on-click="() => this.sortOn('has_coords')">
                            <t t-esc="coordinatesHeader"/>
                            <i t-att-class="'fa ms-1 ' + sortIndicator('has_coords')"/>
                        </th>
                        <th class="text-end o_geo_clickable" t-on-click="() => this.sortOn('amount')">
                            <t t-esc="totalRevenueHeader"/>
                            <i t-att-class="'fa ms-1 ' + sortIndicator('amount')"/>
                        </th>
                    </tr>
                </thead>
                <tbody>
                    <tr t-foreach="sortedRows" t-as="row" t-key="row.id"
                        class="o_geo_clickable" t-on-click="() => this.openPartner(row)">
                        <td><t t-esc="row.name"/></td>
                        <td t-att-class="row.has_country ? '' : 'text-danger'">
                            <t t-esc="countryLabel(row)"/>
                        </td>
                        <td t-att-class="row.has_coords ? '' : 'text-danger'">
                            <t t-esc="coordsLabel(row)"/>
                        </td>
                        <td class="text-end"><t t-esc="formatCurrency(row.amount)"/></td>
                    </tr>
                    <tr t-if="!sortedRows.length">
                        <td colspan="4" class="text-center text-muted py-4">
                            <t t-esc="noCustomersLabel"/>
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>
    </t>
</div>
`;

registry.category("actions").add("sales_map_lite.data_quality", SalesMapLiteDataQuality);
