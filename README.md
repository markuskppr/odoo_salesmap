# Sales Map Lite

Revenue on a map for Odoo 19, installable as a ZIP through **Apps > Import
Module** — no Python code, no new models. That is what lets it install on
locked-down hostings and without a server restart.

## Features

- Choropleth map: countries worldwide, NUTS 1/2 for Europe, with drill-down.
- Figures come live from the standard reporting models
  (`account.invoice.report` / `sale.report`) as the logged-in user, so access
  rights, record rules and multi-company isolation apply by construction.
- Revenue basis selectable and always labeled: invoiced (credit notes count
  negative) or order intake. Net amounts, company currency, document-date
  exchange rates.
- Rankings for regions, countries, cities and customers; period slider with
  playback; comparison against the previous period or last year.
- A dedicated Data Quality page listing every customer with revenue next to
  the fields the map placement actually depends on (country, coordinates).
- Revenue that cannot be placed is reported visibly, never dropped.

Boundary geometries ship as static files (Natural Earth, Public Domain;
Eurostat GISCO NUTS 2021). No PostgreSQL extensions, no external services.

## Installation

1. Download this repository as a ZIP (or clone it and zip the
   `sales_map_lite` folder).
2. In Odoo: **Apps > Import Module**, upload the ZIP.

## License

LGPL-3, see [LICENSE](LICENSE).

## Author

[Geolicious GmbH](https://geolicious.de)
