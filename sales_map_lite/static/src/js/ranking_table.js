/** @odoo-module **/

import { Component, useState, useRef, useEffect, xml } from "@odoo/owl";
import { _t } from "@web/core/l10n/translation";

/**
 * Ranking with sortable columns and inline bars.
 *
 * The bar sits behind the label rather than in a column of its own: that keeps
 * the table readable at fifteen rows and lets the size comparison work without
 * reading the numbers.
 */
export class RankingTable extends Component {
    static template = xml`
<div class="o_geo_ranking" t-ref="scroller">
        <table class="table table-sm table-hover o_geo_rank_table mb-0">
            <thead>
                <tr>
                    <th class="o_geo_rank_pos">#</th>
                    <th class="o_geo_clickable" t-on-click="() => this.sortOn('name')">
                        <t t-esc="props.labelHeader"/>
                        <i t-att-class="'fa ms-1 ' + sortIndicator('name')"/>
                    </th>
                    <th class="text-end o_geo_clickable" t-on-click="() => this.sortOn('amount')">
                        <t t-esc="revenueHeader"/>
                        <i t-att-class="'fa ms-1 ' + sortIndicator('amount')"/>
                    </th>
                    <th class="text-end o_geo_clickable d-none d-xl-table-cell"
                        t-on-click="() => this.sortOn('share')">
                        <t t-esc="shareHeader"/>
                        <i t-att-class="'fa ms-1 ' + sortIndicator('share')"/>
                    </th>
                    <th t-if="props.showGrowth" class="text-end o_geo_clickable"
                        t-on-click="() => this.sortOn('growth')">
                        <t t-esc="props.compareLabel"/>
                        <i t-att-class="'fa ms-1 ' + sortIndicator('growth')"/>
                    </th>
                    <th t-if="props.showTarget" class="text-end o_geo_clickable"
                        t-on-click="() => this.sortOn('target_achievement')">
                        <t t-esc="targetHeader"/>
                        <i t-att-class="'fa ms-1 ' + sortIndicator('target_achievement')"/>
                    </th>
                </tr>
            </thead>
            <tbody>
                <tr t-foreach="sortedRows" t-as="row" t-key="row.key || row.id || row_index"
                    t-att-class="rowClass(row)"
                    t-att-data-key="row.key"
                    t-on-click="() => this.onRowClick(row)">
                    <td class="o_geo_rank_pos text-muted">
                        <t t-if="row.rank"><t t-esc="row.rank"/></t>
                        <t t-else="">–</t>
                    </td>
                    <td class="o_geo_rank_name">
                        <!-- Bar behind the label: size comparison without an
                             extra column. -->
                        <span class="o_geo_rank_bar"
                              t-attf-style="width: {{barWidth(row)}}%"
                              t-if="!row.is_unassigned"/>
                        <span class="o_geo_rank_text">
                            <t t-esc="row.name"/>
                            <span class="text-muted small ms-1"
                                  t-if="row.city"><t t-esc="row.city"/></span>
                            <span class="text-muted small ms-1"
                                  t-elif="row.code and row.code != row.name">
                                <t t-esc="row.code"/>
                            </span>
                        </span>
                    </td>
                    <td class="text-end o_geo_rank_value">
                        <t t-esc="props.formatValue(row.amount)"/>
                    </td>
                    <td class="text-end text-muted d-none d-xl-table-cell">
                        <t t-if="row.share !== null and row.share !== undefined">
                            <t t-esc="row.share.toFixed(1)"/>%
                        </t>
                        <t t-else="">–</t>
                    </td>
                    <td t-if="props.showGrowth" class="text-end"
                        t-att-class="growthClass(row)">
                        <t t-esc="growthLabel(row)"/>
                    </td>
                    <td t-if="props.showTarget" class="text-end"
                        t-att-class="targetClass(row)">
                        <t t-esc="targetLabel(row)"/>
                    </td>
                </tr>
                <tr t-if="!sortedRows.length">
                    <td colspan="6" class="text-center text-muted py-4">
                        <t t-esc="props.emptyLabel"/>
                    </td>
                </tr>
            </tbody>
        </table>
    </div>
    `;
    static props = {
        rows: { type: Array },
        labelHeader: { type: String, optional: true },
        formatValue: { type: Function },
        showGrowth: { type: Boolean, optional: true },
        showTarget: { type: Boolean, optional: true },
        compareLabel: { type: String, optional: true },
        onRowClick: { type: Function, optional: true },
        selectedKey: { type: [String, { value: null }], optional: true },
        emptyLabel: { type: String, optional: true },
    };
    static defaultProps = {
        labelHeader: "Region",
        showGrowth: false,
        showTarget: false,
        compareLabel: "vs. prev.",
        selectedKey: null,
        emptyLabel: "No revenue in the selected period.",
    };

    setup() {
        this.state = useState({ sortBy: "amount", desc: true });
        this.scrollerRef = useRef("scroller");
        // A click on the map sets selectedKey; bring the matching row into
        // view here too, so the selection is not just a highlight the user
        // has to go hunting for by scrolling.
        useEffect(
            (selectedKey) => {
                if (!selectedKey || !this.scrollerRef.el) {
                    return;
                }
                const row = this.scrollerRef.el.querySelector(
                    `[data-key="${CSS.escape(selectedKey)}"]`,
                );
                row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
            },
            () => [this.props.selectedKey],
        );
    }

    get revenueHeader() {
        return _t("Revenue");
    }

    get shareHeader() {
        return _t("Share");
    }

    get targetHeader() {
        return _t("Target");
    }

    get sortedRows() {
        const { sortBy, desc } = this.state;
        const rows = [...this.props.rows];
        rows.sort((a, b) => {
            // The catch-all row for unassigned revenue stays at the bottom: it
            // is not a region and must not head the ranking.
            if (a.is_unassigned) return 1;
            if (b.is_unassigned) return -1;
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

    get maxAmount() {
        let max = 0;
        for (const row of this.props.rows) {
            if (row.amount > max) {
                max = row.amount;
            }
        }
        return max || 1;
    }

    barWidth(row) {
        return Math.max(0, Math.min(100, (row.amount / this.maxAmount) * 100));
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

    growthClass(row) {
        if (!Number.isFinite(row.growth)) {
            return "text-muted";
        }
        if (row.growth > 0) {
            return "text-success";
        }
        if (row.growth < 0) {
            return "text-danger";
        }
        return "text-muted";
    }

    growthLabel(row) {
        if (row.previous_amount === 0 && row.amount > 0) {
            // With no revenue in the comparison period there is no rate. "new"
            // is the honest answer, not "+100%".
            return _t("new");
        }
        if (!Number.isFinite(row.growth)) {
            return "–";
        }
        const sign = row.growth > 0 ? "+" : "";
        return `${sign}${row.growth.toFixed(1)}%`;
    }

    targetLabel(row) {
        if (!row.target_amount) {
            return "–";
        }
        return `${row.target_achievement?.toFixed(0) ?? 0}%`;
    }

    targetClass(row) {
        if (!row.target_amount) {
            return "text-muted";
        }
        const achievement = row.target_achievement ?? 0;
        if (achievement >= 100) {
            return "text-success fw-bold";
        }
        if (achievement >= 80) {
            return "text-warning";
        }
        return "text-danger";
    }

    rowClass(row) {
        const classes = ["o_geo_rank_row"];
        if (row.is_unassigned) {
            classes.push("o_geo_rank_unassigned");
        }
        if (this.props.selectedKey && row.key === this.props.selectedKey) {
            classes.push("table-active");
        }
        if (this.props.onRowClick && !row.is_unassigned) {
            classes.push("o_geo_clickable");
        }
        return classes.join(" ");
    }

    onRowClick(row) {
        if (row.is_unassigned) {
            return;
        }
        this.props.onRowClick?.(row);
    }
}
