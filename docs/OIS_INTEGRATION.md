# POS and OIS: the incumbent system, and how sales reach OIS

**Status:** PLANNING (integration) · **Risk:** MEDIUM RISK · **Checked:** 2026-11-13

Two questions are answered here: what the till on the counter today actually
is, and how sales data gets from a till into the ODS Operational Intelligence
System, both from the incumbent and from this POS.

Statuses use the ODS labels. Anything marked *not verified* has not been checked
against a running system or the physical terminal.

---

## 1. What "POSWell" on the monitor means

**POSWELL is the hardware brand, not the software.** It is the badge on an
all-in-one Windows touch terminal sold by Phnom Penh POS resellers.

| Finding | Source | Confidence |
|---|---|---|
| "Poswell" models 607S, 607D, PL 623S, PL 623D are listed as all-in-one PCs: 15.6" touch, Core i5 (4th gen), 8 GB RAM, 256 GB SSD, Windows 10, Wi-Fi. The D models add a customer-facing second screen. | BPOS Cambodia hardware page (search snippet; the page itself was not opened) | Medium |
| "POSWELL 607S single screen" and "607D dual screen" are sold by POS Cambodia; classified listings in Phnom Penh ask about $360 to $400 new. | POS Cambodia site and Khmer24 listings (search snippets) | Medium |
| No manufacturer site, and no POS *software* called POSWell, was found. | Web search, 2026-11-13 | Medium |
| `poswell.shop` ("POSWELL Cambodia") sells hotel door locks. Unrelated. | Search snippet | Medium |

So the badge identifies the box, and the box is a generic Windows 10 PC. That
matters for two reasons: it tells us almost nothing about the software, and it
means **this POS runs on the existing terminal with no new hardware**.

### Which software is on it

**Owner's report, 2026-11-13: the till runs "OnecamboPOS" in a web-based
interface.** So the incumbent is a browser POS hosted by a vendor, not a
Windows program with a local database. The reseller guesses made before this
was known (POS Cambodia, BPOS) are dropped.

No product is published under exactly that name. Two real Cambodian products
are close, and the address bar on the till tells them apart:

| Candidate | Evidence | Fit |
|---|---|---|
| **eOcambo POS Online** (`pos.eocambo.com`) | A live web login page titled "eOcambo POS Online" with username, password, "Remember Me", "Forgot Your Password" and staff clock-in / clock-out. "eOcambo" reads as "Onecambo" at a glance. eOcambo sells packaged business systems in Cambodia. | Strongest: it is web-based and the name is one letter-swap away. |
| **CamboPOS** (`cambopos.com`) | Sells a POS for "restaurant, cafe, bar, club and KTV" with a Khmer interface, a "Web Report" module for sales and stock reports from any device, and "various data export". | Possible, but its till is described as an installed program with web reporting on top, which fits "web-based interface" less well. |

*Not verified.* Both are from search snippets; neither site could be opened from
the build environment, and no login was attempted. The exact product name on the
screen and the URL have not been seen.

*Inference, to check:* the eOcambo login page (clock-in on the login screen, the
exact wording of its links) matches the layout of Ultimate POS, a widely resold
web POS. If that is what it is, every report screen has Excel / CSV / PDF export
buttons and the vendor can switch on a REST API module. Confirm with the vendor
before relying on it.

### How to settle it in two minutes at the bar

1. Read the web address in the browser's address bar and the exact name on the
   login screen. That alone decides between the candidates above.
2. Look for a reseller sticker on the back or base of the terminal (name and
   phone number). That is the vendor to ask for an export.
3. Check whether the till still takes orders with the Wi-Fi off. A hosted web
   POS usually does not, which matters in a bar when the internet drops.
4. In the POS, find the reports menu and note which exports exist (Excel, CSV,
   PDF) and for which reports (sales by item, daily summary).

Record the answers in the venue's OIS workspace: they are ground truth about a
local vendor that the next bar onboarding will reuse.

---

## 2. Where OIS stands on POS data today

From the OIS capability map (`ODS-OiS`, dataset of 4 Sep 2026 and knowledge base
of 23 to 24 Sep 2026). Not re-checked against the running platform for this document.

| Piece | Status |
|---|---|
| File upload into the Client Workroom, hashed at receipt, POS category treated as tier 1 | Deployed, unverified (no real file run through it on any tenant) |
| Square POS CSV parser in Recon (`pos_square.ts`) | Built |
| Parsers for Loyverse or local Cambodian POS vendors | Planned ("build per client" as CSV adapters) |
| Canonical store `recon.records/sales_daily` | Defined; nothing writes daily figures into it |
| Aether source `ods_recon_pos` (`pos_gross_sales`, `orders_walkin`, …, period = day, aggregates only, no PII) | Registered; no producer |
| Client-sales forecasting | Planned. Needs a POS connector and about four weeks of daily sales |

The OIS map calls this "the highest-value missing link": it is what separates a
forecast about Cambodia from a forecast about this bar. A bar that produces a
clean daily file is the shortest route to closing it.

---

## 3. Integration paths

### Path A: this POS → OIS (recommended)

`Reports → Export for OIS` writes two files per closed trading day into
`data/ois-exports/`, each with a `.sha256` sidecar:

| File | Content |
|---|---|
| `<source>_sales_lines_<date>.csv` | One row per item sold: order number, UTC paid time, staff id, product, category, quantity, list price, price charged, happy-hour flag, unit cost, order discount, order total, payment methods, riel rate |
| `<source>_sales_daily_<date>.json` | `ods.pos.sales_daily/v1`: `pos_gross_sales`, `pos_net_sales`, `pos_discounts`, `pos_cogs`, `orders_walkin`, `items_sold`, payment mix, category mix, sales by hour, void counts |

Properties chosen to match the OIS ingestion contract:

- **Deterministic.** No export timestamp inside the file. The same day always
  produces the same bytes, so the hash is stable and a re-export is provably
  identical. Tested.
- **Closed days only.** An open shift cannot be exported, so a file is never a
  partial day.
- **No personal data.** Tab names (customer names) and staff names are left
  out; staff appear as numeric ids. This satisfies the `ods_recon_pos` rule of
  "client-owned aggregates only".
- **Stable ids.** `order_no` and `line_id` are the till's own keys, as the
  adapter framework requires for record ids.
- **Metric names match** the registered Aether source, so the daily JSON maps
  onto `ods_recon_pos` without a translation table. `orders_grab` and
  `orders_telegram` are not emitted: a bar till only sees walk-in orders.

**Today (works now):** a manager uploads the day's pair to the venue's Workroom
under the POS category. That lands the raw bytes, hashed, as a tier-1 source.

**To finish the link (not built, belongs in ODS-Recon and Aether):**

1. A Recon adapter for `ods.pos.sales_daily/v1` and the lines CSV, modelled on
   `pos_square.ts`: a plain parser, no model, conformance-tested against a
   fixture exported from this POS.
2. The producer that turns those records into `ods_recon_pos` daily signals.
3. Optional: a scheduled push from the till instead of a manual upload. This
   needs a receiving endpoint that validates a signature before bytes land,
   which the contract assigns to the Relay (Planned). Not worth building on the
   till until the receiver exists.

### Path B: the incumbent POS → OIS (keep the old till)

Usable if the bar stays on its current software. Order of preference:

| Option | How | Trade-off |
|---|---|---|
| B1. Report export | Daily "sales by item" export to Excel or CSV from the POS reports screen, uploaded to the Workroom. One CSV adapter per vendor. | Cheapest and inside every vendor's terms, and it works from any browser, including the owner's phone. Depends on a person doing it and on what the export contains. This is the route the OIS contract already names for local vendors. |
| B2. Vendor API | Ask the vendor whether an API or a scheduled emailed report exists, and for a read-only key in the owner's name. | Best when it exists: no manual step. Credentials go in the OIS secret store, never in a file. |
| B3. Database read | Not available: a hosted web POS keeps its database on the vendor's server. | Ruled out by the owner's report that the system is web-based. |
| B4. End-of-day report photo | Staff photograph the Z report into the venue's Telegram bot. | Totals only, no item detail. A fallback when nothing else is possible. |

Do not script a login to the vendor's site to pull reports automatically. OIS
does not collect from behind someone else's login; the owner exports, or the
vendor provides an API.

Because the sales history sits on the vendor's server, **export the full history
before any changeover** and keep the files: access may end with the subscription.

Whichever option is used, the target is the same two-file shape as Path A, so
OIS needs one adapter contract and Aether one producer.

### Path C: run both for a changeover period

Keep the incumbent for a fortnight while this POS runs beside it, compare the
two Z reports each night, then switch. The same terminal can host both.

### Payments reconciliation (either path)

OIS already has an opt-in route where staff photograph ABA, ACLEDA, Wing or
Bakong transfer confirmations into Telegram and the amounts are parsed into
`payment_confirmations`. This POS records a reference on every KHQR payment and
a KHQR total per day, so the two can be matched by amount and time: a
deterministic join, no model needed.

---

## 4. AI use

None is introduced. The export is SQL and string formatting; the proposed
adapters are parsers. The first prototype of this POS made three language-model
calls (price suggestions, a weekly report, invoice reading); all three were
removed in favour of a formula, SQL aggregates and typed entry. If OIS later
adds a model step on top of this data (for example a written weekly summary),
it should read the daily JSON as its structured input and be justified under
the five-point rule at that time.

---

## 5. Open questions

- The exact product name and web address of the incumbent POS (section 1), and
  which report exports it offers.
- The receipt printer's connection (USB with a Windows driver, or LAN) and
  whether the cash drawer hangs off it.
- Whether the bar charges VAT inside its prices, and the riel rate it uses.
- Whether the bar's KHQR is a personal or merchant account. A merchant account
  is the precondition for dynamic QR and automatic confirmation later.
- The real drinks list, recipes and supplier costs to replace the sample data.
