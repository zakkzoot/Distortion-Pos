# Bar POS

A drinks-only point of sale for a bar in Phnom Penh. One till, runs on the
Windows touch terminal already on the counter, keeps selling when the internet
is down, and hands a clean daily sales file to ODS OIS.

No food, no kitchen tickets, no table plan. What a bar needs instead: fast
ring-up, named tabs, dollars and riel in the same drawer, KHQR, happy hour,
pour-cost stock control, a blind cash-up and a Z report.

## What it does

| Area | Behaviour |
|---|---|
| Sell | Category tabs, one tap per drink, cart, pay. English / Khmer toggle. |
| Tabs | Park an order under a name or table, add rounds, print a bill, settle later. |
| Payments | Cash USD, cash KHR, KHQR, card, or a mix. Riel due is rounded up to 100 ៛; change is given as whole dollars plus riel, the way tills here do it. |
| Happy hour | Time window and days set in Admin. Applied by the server when the drink is rung up; the price is locked on the tab. |
| Controls | PIN per person. Voids, discounts and line removals need a manager PIN and a reason, and land in the audit log. Five wrong PINs lock the keypad for 30 seconds. |
| Shifts | Open with a float in both currencies, record pay-outs and safe drops, close with a count. Bartenders count blind; only managers see what the drawer should hold. |
| Stock | Each drink has a recipe. Ringing it up takes the ingredients off the shelf; a void puts them back unless the drink was poured. Stock-in (weighted average cost), waste, stocktake with variance. |
| Menu | Price, cost, pour cost % and a cost-plus suggested price per drink. |
| Reports | Sales by drink, category, hour, staff and payment method; cost and margin; CSV export. |
| Receipts | Any printer Windows knows about (browser print), or a network ESC/POS printer on port 9100 with a cash-drawer kick. |
| OIS | One closed trading day exports as an item-level CSV and a daily JSON, each with a SHA-256. See `docs/OIS_INTEGRATION.md`. |

## Run it

Needs Node.js 22.13 or newer. Nothing else: the database is a single SQLite file.

```bash
npm install
```

```bash
npm run build
```

```bash
npm start
```

Open `http://127.0.0.1:3000`. On the first run the console prints a one-time
manager PIN (or set `POS_INITIAL_MANAGER_PIN` in `.env.local` first). Log in,
change the PIN under Admin, add your staff.

The till starts with a short sample drinks list so it is usable straight away.
**The sample prices and costs are placeholders**: replace them under Menu and
Stock with the bar's real list before trading, or start empty with `POS_NO_SEED=1`.

`npm run dev` runs the same server with live reload. `npm test` runs the tests.

### On the terminal

- Start Chrome in kiosk mode pointing at the till. Adding `--kiosk-printing`
  sends receipts to the default Windows printer without a dialog.
- If the receipt printer is on USB with a Windows driver, leave Receipts on
  "Windows printer" and set the driver to open the cash drawer before printing.
  If the printer has a LAN port, choose "Network ESC/POS" and enter its IP.
- Back up the `data/` folder. It holds every sale.
- The server listens on this machine only. Set `HOST=0.0.0.0` only if handhelds
  on the bar's own Wi-Fi need to reach it.

## Design rules

**Deterministic first.** There is no AI call anywhere in this system. The first
prototype asked a language model to suggest prices, write the weekly report and
read supplier invoices. Prices are now a formula (ingredient cost ÷ target pour
cost), reports are SQL, and stock-in is typed. Every figure on a receipt, a Z
report or an export can be recomputed from the database and will come out the same.

**Money is integers.** USD in cents, KHR in riel. All rounding rules live in
`server/money.ts` and are unit-tested.

**The server decides.** The browser sends product ids and quantities. Prices,
happy hour, discounts, change and stock are all worked out server-side.

**Local reality is in the rules, not in a prompt.** Two currencies in one
drawer, no US coins, riel rounded to 100, KHQR confirmed by eye on the
merchant app, a trading day that ends at 06:00, power and internet that drop.

## Layout

```
server/money.ts     rounding, currency, happy hour, trading day, price suggestion
server/db.ts        schema, PIN hashing, first-run seed
server/app.ts       the API: login, orders, tabs, payments, shifts, stock, menu, admin
server/receipt.ts   receipt text, ESC/POS job, network printer
server/reports.ts   sales summary, CSV, OIS export
src/                the touch screens (React)
tests/              money rules and a full night on the till, end to end
```

## Not built yet

- Dynamic KHQR (a QR carrying the bill amount) and automatic payment
  confirmation. Today staff show the bar's own KHQR stand and confirm the
  transfer on the merchant app before tapping Confirm.
- Khmer on thermal receipts sent as raw ESC/POS (needs image printing). Browser
  printing handles Khmer.
- A second till sharing one database, customer loyalty, automatic backups.
- The Khmer interface strings are partial and need a native speaker's review.
