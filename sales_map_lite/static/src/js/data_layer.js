/** @odoo-module **/

import { _t } from "@web/core/l10n/translation";

/**
 * Client-side revenue aggregation for Sales Map Lite.
 *
 * The Lite edition ships no Python, so everything the full module's
 * ``sales.map.analysis`` model does on the server happens here through the
 * standard ORM endpoints instead. That is not a security downgrade -- the
 * opposite: every read runs as the logged-in user, so access rights, record
 * rules and the multi-company filter apply with no sudo anywhere.
 *
 * The revenue semantics mirror the full module exactly:
 *
 * * Both bases report *net (untaxed)* amounts in company currency at the
 *   document date's exchange rate -- the reporting views already provide
 *   that.
 * * ``account.invoice.report`` signs credit notes negative, so returns
 *   reduce a region's figure; draft and cancelled documents are excluded.
 * * Down payments are not double counted: the final invoice deducts them.
 */

//: Data sources, keyed by the revenue basis. Ordered: within a basis the
//: first usable source wins; when the delivery address is requested, a
//: source that genuinely carries it is preferred (only sale.order does).
export const SOURCES = {
    invoices: [
        {
            model: "account.invoice.report",
            dateField: "invoice_date",
            amountField: "price_subtotal",
            partnerFields: {
                invoice: "partner_id",
                shipping: "partner_id", // not carried by the view
                commercial: "commercial_partner_id",
            },
            extraDomain: [
                ["move_type", "in", ["out_invoice", "out_refund"]],
                ["state", "=", "posted"],
            ],
            labelKey: "invoices_report",
            stateless: true,
        },
    ],
    orders: [
        {
            model: "sale.report",
            dateField: "date",
            amountField: "price_subtotal",
            partnerFields: {
                invoice: "partner_id",
                shipping: "partner_id", // not carried by the view
                commercial: "commercial_partner_id",
            },
            extraDomain: [],
            labelKey: "orders_report",
        },
        {
            model: "sale.order",
            dateField: "date_order",
            amountField: "amount_untaxed",
            partnerFields: {
                invoice: "partner_id",
                shipping: "partner_shipping_id",
                commercial: "partner_id",
            },
            extraDomain: [],
            labelKey: "orders_order",
        },
    ],
};

/**
 * Human-readable description of a source, resolved at call time (not on the
 * SOURCES constant above) so the literal _t() calls run after translations
 * are loaded rather than at module-import time.
 */
function sourceLabel(labelKey) {
    switch (labelKey) {
        case "invoices_report":
            return _t("Invoiced revenue (account.move.line via account.invoice.report)");
        case "orders_report":
            return _t("Order intake (sale.order via sale.report)");
        case "orders_order":
            return _t("Order intake (sale.order)");
        default:
            return labelKey;
    }
}

export const REVENUE_BASES = [
    { key: "invoices", label: "Invoiced (net)" },
    { key: "orders", label: "Order intake (net)" },
];

export const PARTNER_BASES = [
    { key: "invoice", label: "Invoice address" },
    { key: "shipping", label: "Delivery address" },
    { key: "commercial", label: "Commercial parent" },
];

export class SalesDataLayer {
    constructor(orm) {
        this.orm = orm;
        this._fieldsCache = new Map();
        this._partnerInfo = new Map();
        this._countryCodes = new Map();
    }

    // ------------------------------------------------------------------
    // Source resolution
    // ------------------------------------------------------------------

    async _fields(model, names) {
        const cacheKey = model + ":" + names.join(",");
        if (!this._fieldsCache.has(cacheKey)) {
            this._fieldsCache.set(
                cacheKey,
                await this.orm.call(model, "fields_get", [names], {
                    attributes: ["type", "selection"],
                }),
            );
        }
        return this._fieldsCache.get(cacheKey);
    }

    /**
     * Pick the first source of the configured basis the current user can
     * actually read. A salesperson typically has no access to the
     * accounting views; the dashboard must fall back visibly rather than
     * error out. Mirrors the full module's ``_sales_source``.
     */
    async resolveSource(revenueBasis, partnerBasis) {
        const candidates = [];
        for (const source of SOURCES[revenueBasis] || SOURCES.invoices) {
            candidates.push({ source, fallback: false });
        }
        for (const basis of Object.keys(SOURCES)) {
            if (basis !== revenueBasis) {
                for (const source of SOURCES[basis]) {
                    candidates.push({ source, fallback: true });
                }
            }
        }
        if (partnerBasis !== "invoice") {
            // Prefer a source that genuinely carries the requested address.
            candidates.sort((a, b) => {
                const genuine = (c) =>
                    c.source.partnerFields[partnerBasis] !==
                    c.source.partnerFields.invoice;
                return (
                    Number(a.fallback) - Number(b.fallback) ||
                    Number(genuine(b)) - Number(genuine(a))
                );
            });
        }

        for (const { source, fallback } of candidates) {
            let fields;
            try {
                fields = await this._fields(source.model, [
                    source.dateField,
                    source.amountField,
                    "state",
                ]);
                // Access probe: cheapest possible search. fields_get alone
                // does not check model access rights.
                await this.orm.searchRead(source.model, [], ["id"], { limit: 1 });
            } catch {
                continue;
            }
            if (!fields[source.dateField] || !fields[source.amountField]) {
                continue;
            }
            // Revenue-carrying states, read from the live selection: Odoo
            // replaced the "done" order state with a flag in some versions.
            let states = null;
            if (!source.stateless && fields.state?.selection) {
                const available = fields.state.selection.map(([v]) => v);
                states = ["sale", "done"].filter((s) => available.includes(s));
                if (!states.length) {
                    states = null;
                }
            }
            const partnerField =
                source.partnerFields[partnerBasis] || source.partnerFields.invoice;
            const effectiveBasis =
                partnerBasis !== "invoice" &&
                partnerField === source.partnerFields.invoice
                    ? "invoice"
                    : partnerBasis;
            return {
                ...source,
                label: sourceLabel(source.labelKey),
                partnerField,
                states,
                dateType: fields[source.dateField].type,
                revenueBasis,
                partnerBasis: effectiveBasis,
                requestedPartnerBasis: partnerBasis,
                fallback,
            };
        }
        throw new Error(
            _t("No readable revenue source found (account.invoice.report, sale.report, sale.order)."),
        );
    }

    // ------------------------------------------------------------------
    // Domains
    // ------------------------------------------------------------------

    _dateBound(source, isoDate, endOfDay) {
        if (source.dateType === "datetime") {
            return isoDate + (endOfDay ? " 23:59:59" : " 00:00:00");
        }
        return isoDate;
    }

    baseDomain(source, dateFrom = null, dateTo = null) {
        const domain = [...source.extraDomain];
        if (source.states) {
            domain.push(["state", "in", source.states]);
        }
        if (dateFrom) {
            domain.push([source.dateField, ">=", this._dateBound(source, dateFrom, false)]);
        }
        if (dateTo) {
            domain.push([source.dateField, "<=", this._dateBound(source, dateTo, true)]);
        }
        return domain;
    }

    /**
     * The real, openable document behind a resolved source: sale orders for
     * an order-intake basis, customer invoices for an invoiced basis --
     * never the reporting view itself (account.invoice.report / sale.report
     * are read-only SQL views with no useful form view to drill into).
     *
     * ``partnerIds``, when given, is filtered through the same partner field
     * the figures were aggregated on (source.partnerBasis), traversing the
     * relation to the commercial partner when that basis is active rather
     * than assuming the document carries its own commercial_partner_id.
     */
    documentTarget(source, partnerIds, dateFrom, dateTo) {
        const isInvoice = source.model === "account.invoice.report";
        const model = isInvoice ? "account.move" : "sale.order";
        const dateField = isInvoice ? "invoice_date" : "date_order";
        // account.move.invoice_date is a Date field; sale.order.date_order is
        // a Datetime -- reuse the same day-boundary convention as baseDomain.
        const bound = (iso, endOfDay) =>
            isInvoice ? iso : `${iso} ${endOfDay ? "23:59:59" : "00:00:00"}`;

        const domain = [];
        if (dateFrom) {
            domain.push([dateField, ">=", bound(dateFrom, false)]);
        }
        if (dateTo) {
            domain.push([dateField, "<=", bound(dateTo, true)]);
        }
        if (isInvoice) {
            domain.push(
                ["move_type", "in", ["out_invoice", "out_refund"]],
                ["state", "=", "posted"],
            );
        } else if (source.states) {
            domain.push(["state", "in", source.states]);
        }
        if (partnerIds) {
            const partnerField = {
                invoice: "partner_id",
                shipping: "partner_shipping_id",
                commercial: "partner_id.commercial_partner_id",
            }[source.partnerBasis] || "partner_id";
            domain.push([partnerField, "in", partnerIds]);
        }
        return { model, domain, isInvoice };
    }

    // ------------------------------------------------------------------
    // Bootstrap data
    // ------------------------------------------------------------------

    /** Earliest and latest document date, or nulls on an empty database. */
    async dateBounds(source) {
        // One aggregate query beats two ordered searches: read_group with an
        // empty groupby reduces the whole domain to a single row, and Odoo's
        // aggregate spec covers min/max the same way it covers sum elsewhere
        // in this file.
        const minSpec = `${source.dateField}:min`;
        const maxSpec = `${source.dateField}:max`;
        const [group] = await this.orm.formattedReadGroup(
            source.model, this.baseDomain(source), [], [minSpec, maxSpec],
        );
        const iso = (value) => (value ? String(value).slice(0, 10) : null);
        return { min: iso(group?.[minSpec]), max: iso(group?.[maxSpec]) };
    }

    /** Month grid for the period slider, gaps filled with zero months. */
    async monthSeries(source, minIso, maxIso) {
        const spec = `${source.dateField}:month`;
        const groups = await this.orm.formattedReadGroup(
            source.model,
            this.baseDomain(source, minIso, maxIso),
            [spec],
            [`${source.amountField}:sum`, "__count"],
        );
        const amounts = {};
        const counts = {};
        for (const group of groups) {
            const raw = group[spec];
            // Datetime months come back as the UTC instant of the *local*
            // month start ("2026-08-31 22:00:00" for September in Berlin).
            // Jumping to the middle of the month before reading year/month
            // is immune to any timezone offset.
            const value = String(Array.isArray(raw) ? raw[0] : raw);
            const iso = value.length > 10
                ? value.replace(" ", "T") + "Z"
                : value + "T00:00:00Z";
            const mid = new Date(Date.parse(iso) + 15 * 86400000);
            const key = `${mid.getUTCFullYear()}-${String(mid.getUTCMonth() + 1).padStart(2, "0")}`;
            amounts[key] = (amounts[key] || 0) + (group[`${source.amountField}:sum`] || 0);
            counts[key] = (counts[key] || 0) + (group.__count || 0);
        }
        const periods = [];
        let [year, month] = minIso.split("-").map(Number);
        const [lastYear, lastMonth] = maxIso.split("-").map(Number);
        while (year < lastYear || (year === lastYear && month <= lastMonth)) {
            const key = `${year}-${String(month).padStart(2, "0")}`;
            const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
            periods.push({
                key,
                year,
                month,
                date_from: `${key}-01`,
                date_to: `${key}-${String(lastDay).padStart(2, "0")}`,
                amount: Math.round((amounts[key] || 0) * 100) / 100,
                order_count: counts[key] || 0,
            });
            month += 1;
            if (month > 12) {
                month = 1;
                year += 1;
            }
        }
        return periods;
    }

    // ------------------------------------------------------------------
    // Aggregation
    // ------------------------------------------------------------------

    /** Revenue and document count per customer within the period. */
    async perPartner(source, dateFrom, dateTo) {
        const groups = await this.orm.formattedReadGroup(
            source.model,
            this.baseDomain(source, dateFrom, dateTo),
            [source.partnerField],
            [`${source.amountField}:sum`, "__count"],
        );
        const result = new Map();
        for (const group of groups) {
            const raw = group[source.partnerField];
            const partnerId = Array.isArray(raw) ? raw[0] : raw;
            if (!partnerId) {
                continue;
            }
            result.set(partnerId, {
                amount: group[`${source.amountField}:sum`] || 0,
                order_count: group.__count || 0,
            });
        }
        return result;
    }

    /**
     * Address and coordinate data of the customers involved. Read through
     * the ORM as the current user -- customers the user may not see never
     * appear here, because they cannot appear in the aggregation either.
     */
    async partnerInfo(partnerIds) {
        const missing = partnerIds.filter((id) => !this._partnerInfo.has(id));
        if (missing.length) {
            const rows = await this.orm.read("res.partner", missing, [
                "display_name",
                "city",
                "country_id",
                "partner_latitude",
                "partner_longitude",
            ]);
            const countryIds = new Set();
            for (const row of rows) {
                if (row.country_id) {
                    countryIds.add(row.country_id[0]);
                }
            }
            const unknownCountries = [...countryIds].filter(
                (id) => !this._countryCodes.has(id),
            );
            if (unknownCountries.length) {
                for (const country of await this.orm.read(
                    "res.country",
                    unknownCountries,
                    ["code"],
                )) {
                    this._countryCodes.set(country.id, country.code);
                }
            }
            for (const row of rows) {
                this._partnerInfo.set(row.id, {
                    id: row.id,
                    name: row.display_name,
                    city: row.city || "",
                    countryId: row.country_id ? row.country_id[0] : null,
                    countryCode: row.country_id
                        ? this._countryCodes.get(row.country_id[0]) || null
                        : null,
                    countryName: row.country_id ? row.country_id[1] : null,
                    lon: row.partner_longitude || 0,
                    lat: row.partner_latitude || 0,
                });
            }
            for (const id of missing) {
                if (!this._partnerInfo.has(id)) {
                    // Deleted or inaccessible partner: keep a stub so the
                    // revenue still lands in the unassigned bucket.
                    this._partnerInfo.set(id, {
                        id,
                        name: "Unknown",
                        city: "",
                        countryId: null,
                        countryCode: null,
                        countryName: null,
                        lon: 0,
                        lat: 0,
                    });
                }
            }
        }
        const info = new Map();
        for (const id of partnerIds) {
            info.set(id, this._partnerInfo.get(id));
        }
        return info;
    }

    invalidatePartnerCache() {
        this._partnerInfo.clear();
    }
}
