# -*- coding: utf-8 -*-
{
    "name": "Sales Map Lite",
    "summary": "Revenue on a map, installable as a ZIP through Apps > Import "
               "Module: countries worldwide and NUTS 1/2 for Europe, "
               "rankings, period slider and comparison.",
    "description": """
Sales Map Lite
==============

The ZIP-installable edition of Sales Map: no Python code, no new models --
which is exactly what allows Apps > Import Module (and locked-down hostings)
to install it.

- Choropleth map: countries worldwide, NUTS 1/2 for Europe, with drill-down.
- Figures come live from the standard reporting models
  (account.invoice.report / sale.report) as the logged-in user, so access
  rights, record rules and multi-company isolation apply by construction.
- Revenue basis selectable and always labeled: invoiced (credit notes count
  negative) or order intake. Net amounts, company currency, document-date
  exchange rates.
- Rankings for regions, countries, cities and customers; period slider with
  playback; comparison against the previous period or last year.
- Revenue that cannot be placed is reported visibly, never dropped.

Boundary geometries ship as static files (Natural Earth, Public Domain;
Eurostat GISCO NUTS 2021). No PostgreSQL extensions, no external services.

The full "Sales Map" module (deployed via the addons path) additionally
offers custom GeoJSON sales regions, stored assignments with proximity
matching, configuration in Settings and a server-side test suite.
""",
    "author": "Geolicious GmbH",
    "website": "https://geolicious.de",
    "category": "Sales/Sales",
    "version": "19.0.1.0.0",
    "license": "LGPL-3",
    "depends": [
        "web",
        "sale",
        "account",
    ],
    "data": [
        "data/sales_map_lite.xml",
    ],
    "demo": [
        "demo/res_partner_demo.csv",
        "demo/product_demo.xml",
        "demo/sale_order_demo.xml",
    ],
    "assets": {
        "web.assets_backend": [
            "sales_map_lite/static/src/css/dashboard.css",
            "sales_map_lite/static/src/js/geometry.js",
            "sales_map_lite/static/src/js/projection.js",
            "sales_map_lite/static/src/js/color_scale.js",
            "sales_map_lite/static/src/js/data_layer.js",
            "sales_map_lite/static/src/js/choropleth_map.js",
            "sales_map_lite/static/src/js/ranking_table.js",
            "sales_map_lite/static/src/js/time_range_slider.js",
            "sales_map_lite/static/src/js/dashboard.js",
            "sales_map_lite/static/src/js/data_quality.js",
        ],
    },
    "application": True,
    "installable": True,
}
