# New Mexico gross receipts tax for Stream

Reviewed November 20, 2026 for ordinary personal-viewing orders. Stream displays a filmmaker’s offer, charges the viewer once, grants access and pays the filmmaker. The filmmaker sets the price. Stream’s operator is based in Albuquerque. The viewer can choose a zero tip and receives the same film either way.

## Who reports the film sale

The published rules support treating Stream’s operator as the marketplace provider for these orders. Stream lists the offer and handles payment and payout, including when a filmmaker puts the player on their own site. The rules include the gross film price in the platform’s receipts even when the proceeds go to the filmmaker. New Mexico treats electronically delivered video for personal use in the state as a taxable digital license. That supports the same treatment for a limited rental and for a purchase with a download. The remote-seller threshold applies to businesses without physical presence in the state. A filmmaker claiming the marketplace deduction needs documentation that the operator is registered and has remitted or will remit the tax. The operator’s actual registration and filing are separate from its Stripe sandbox registration. [3.2.1.7(H) and 3.2.1.20 NMAC](https://www.srca.nm.gov/parts/title03/03.002.0001.html) · [FYI-200, digital goods](https://www.tax.newmexico.gov/wp-content/uploads/2022/11/FYI-200.pdf) · [FYI-206, marketplace seller deduction and physical presence](https://realfile.tax.newmexico.gov/FYI-206.pdf)

## Which location to use

For a digital license delivered online, use the known delivery location. If unavailable, use a purchaser address in ordinary business records in good faith. If neither is available, an address obtained at checkout, including the billing address, can qualify. The regulation provides an origin fallback when those tests fail. Headquarters ZIP 87120 supplies neither a viewer address nor an exact tax district. For manual checkout, resolve the full applicable address and verify its location code and rate against the official schedule for the transaction date. Keep that code, rate, effective period and the basis for using the address with the order. When the state lookup is unavailable, a match is ambiguous or the published district has special conditions, Stream uses Stripe Tax with the viewing address collected by Stripe. A card billing address can differ from where the film is delivered. [3.1.4.13(C)(5)–(6) NMAC](https://www.srca.nm.gov/parts/title03/03.001.0004.html) · [State location and rate resources](https://www.tax.newmexico.gov/businesses/geographic-information-system-gis/data-download/)

## How the optional tip changes the answer

Taxable business receipts are the stronger reading for a tip the operator retains to run Stream. The state distinguishes gratuities passed to personnel from tips an establishment retains. Its examples concern hospitality. Stream’s viewer can choose zero and gets no additional access for tipping. I found no published state decision applying the rule to these facts. If the tip is taxable, the choice of reporting location also matters. New Mexico provides rules for incidental charges and separately stated items in a mixed transaction, including circumstances in which a single reporting location can apply. Stream’s operator elected to treat the retained tip as taxable at the same reporting location as the film. This is the operating assumption for the sandbox. The department has not issued a ruling to the operator on this treatment. New Mexico permits tax-inclusive billing with disclosure. [3.2.1.18(I) NMAC](https://www.srca.nm.gov/parts/title03/03.002.0001.html) · [3.1.4.13(D) NMAC](https://www.srca.nm.gov/parts/title03/03.001.0004.html) · [3.2.6.8 NMAC](https://www.srca.nm.gov/parts/title03/03.002.0006.html)

## What the rehearsal verified

Stream’s pinned `@dustwave/tax-core` 0.4.1 resolved these public test addresses. Their location codes and rates agreed with the state’s July 1, 2026 through June 30, 2027 rate layer. The lookup returned an error for an invented Albuquerque street. The shared address helper checks only the first provider result. It does not check for competing matches or an effective date. [State rate layer for this period](https://www.arcgis.com/home/item.html?id=44857f906e7649d29071966f8b00fda7)

| Public test address | Reporting location | GRT rate |
| --- | --- | ---: |
| 1 Civic Plaza NW, Albuquerque, 87102 | 02-701, Albuquerque Downtown TIF (MRA) | 7.6250% |
| 5700 Bogart St NW, Albuquerque, 87120 | 02-100, Albuquerque | 7.6250% |
| 200 Lincoln Ave, Santa Fe, 87501 | 01-123, Santa Fe (city) | 8.1875% |

Using the Civic Plaza rate, the shared calculator reproduced both earlier Stripe Tax receipts. Two new Store sandbox card payments then produced the same totals with automatic tax disabled and the manual rates attached to the film and tip. The rental transferred $0.66 to the first filmmaker after a $0.33 processing fee. The purchase transferred $2.60 to the second filmmaker after a $0.39 fee. Each order unlocked its own film. An unpaid checkout for a $0.01 tip kept the inclusive rate and rounded its tax to zero.

| Order | Film | Selected tip | Tax added to film | Tax included in tip | Viewer paid |
| --- | ---: | ---: | ---: | ---: | ---: |
| Rental | $0.99 | $0.10 | $0.08 | $0.01 | $1.17 |
| Purchase with download | $2.99 | $0.00 | $0.23 | $0.00 | $3.22 |

If the state treats the optional payment as a gift, the rental viewer still pays $1.17. The operator would record $0.08 of GRT and $0.10 of support. Under the taxable-tip assumption it records $0.09 of GRT and $0.09 of support.

## How checkout selects a tax calculation

The marketplace sandbox uses the shared calculator when the viewer selects New Mexico, the state address finder returns one matching street address, and the district and rate agree with the reviewed state schedule. Preserve enough time for Stripe Checkout to complete within the schedule’s effective period. Stream creates an exclusive Stripe manual rate for the film and an inclusive rate when the viewer tips. It records the code, rate, period and lookup source on the order, then checks each paid Stripe line against those rates and the saved quote before granting access. The full address goes to the address finder. Stream keeps a keyed fingerprint to detect changes on retry.

An unresolved New Mexico viewing location goes through automatic Stripe Tax with a viewing-address field. Other viewers continue through the existing automatic checkout. In all three paths the viewer makes one payment. The manual route uses Stripe’s ordinary card processing and manual tax rates, avoiding an automatic Stripe Tax calculation on that order. Stream’s operator handles reporting and remittance. [Stripe manual tax rates](https://docs.stripe.com/payments/checkout/use-manual-tax-rates) · [Stripe Checkout tax addresses](https://docs.stripe.com/tax/checkout/elements) · [Stripe Tax pricing](https://stripe.com/tax/pricing)

For rollback, set `STREAM_NM_MANUAL_TAX=0` and restart the viewer server. This returns new marketplace orders to automatic Stripe Tax. Existing orders finish with the tax policy and quote they originally received. Before the next effective period, review the new state rate layer and its district qualifications. The current manual schedule covers July 1, 2026 through June 30, 2027.
