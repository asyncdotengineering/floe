# Billing & Invoices

## How billing works

Acme bills monthly on the calendar day you signed up. If your signup day doesn't exist that month (e.g., 31st in February), we bill on the last day of the month.

All invoices are emailed to your billing email — set in **Settings → Billing → Notifications**. If you're not receiving invoices, check that email or contact support.

## Failed payments

If your card is declined:
1. We retry automatically after 3 days, then again after 7 days.
2. After two failed retries, your account moves to `past_due`.
3. After 14 days in `past_due` without a successful payment, the account is suspended (read-only).
4. After 30 more days, the account is closed and data is scheduled for deletion 90 days later.

You can update your card any time at **Settings → Billing → Payment method**. Once a valid card is on file, suspension lifts within an hour.

## Refunds

See the refund-policy procedure. Short version:
- Within 30 days: full refund.
- 31-90 days: 50% refund or full store credit.
- 90+ days: not eligible by default; check exceptions.

Process via the refund flow. Always confirm the invoice id and refund amount with the customer before processing.

## Currency and tax

US customers are billed in USD. EU/UK customers are billed in EUR (VAT applied per local rules). Other regions are billed in USD; tax is the customer's responsibility.

VAT IDs can be entered at **Settings → Billing → Tax info**. We don't charge VAT for valid B2B EU IDs.

## Annual plans

Annual plans are billed once upfront. You save 15% compared to month-to-month. There are no refunds for partial periods on annual plans, but you can convert annual credit to monthly credit on request.
