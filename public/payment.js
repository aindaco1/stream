// Billing, contact and card data stay inside Stripe's Elements.
function appearance(container) {
  const style = getComputedStyle(container);
  const color = name => style.getPropertyValue('--' + name).trim();
  const small = window.matchMedia('(max-width: 26rem)').matches;
  return {
    theme: 'stripe', labels: 'above',
    variables: {
      fontFamily: style.fontFamily, fontSizeBase: '16px', spacingUnit: '4px', borderRadius: '6px',
      gridRowSpacing: small ? '8px' : '12px', gridColumnSpacing: small ? '8px' : '12px',
      colorPrimary: color('pay-ink'), colorBackground: color('pay-surface'), colorText: color('pay-text'),
      colorTextSecondary: color('pay-muted'), colorTextPlaceholder: color('pay-muted'), colorDanger: color('pay-error')
    },
    rules: {
      '.Input': { fontSize: '16px', lineHeight: '22px', padding: small ? '10px' : '12px', border: '1px solid ' + color('pay-field'), boxShadow: 'none' },
      '.Input:focus': { borderColor: color('pay-focus'), boxShadow: '0 0 0 2px ' + color('pay-focus') },
      '.Label': { fontWeight: '600', color: color('pay-ink') },
      '.AccordionItem': { boxShadow: 'none', borderColor: color('pay-line') }
    }
  };
}

export function createCardForm(stripe, order, onSubmit, complete, viewingAddress, interrupted = complete) {
  const form = document.querySelector('#card-form');
  const button = document.querySelector('#confirm-payment');
  const errorBox = form.querySelector('#payment-error');
  const price = document.querySelector('#order-price');
  const tax = document.querySelector('#order-tax');
  const billing = document.querySelector('#billing-location');
  const marketplace = order.taxPolicy === 'marketplace-v1';
  const manual = marketplace && order.manualTax === true;
  const automatic = marketplace && !manual;
  const useViewingAddress = automatic && order.useViewingAddress === true;
  const format = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const checkout = stripe.initCheckoutElementsSdk({
    clientSecret: order.clientSecret,
    elementsOptions: { appearance: appearance(form), loader: 'auto' },
    ...(useViewingAddress && viewingAddress && { defaultValues: { shippingAddress: { address: {
      country: viewingAddress.country, state: viewingAddress.state, city: viewingAddress.city,
      line1: viewingAddress.line1, postal_code: viewingAddress.postalCode
    } } } })
  });
  let contact;
  let address;
  let payment;
  let actions;
  let destroyed = false;
  let submitting = false;
  let waiting = false;
  let matches = false;
  let displayedAmount;
  const narrow = window.matchMedia('(max-width: 26rem)');
  const resize = () => checkout.changeAppearance(appearance(form));

  function feedback(message) {
    errorBox.textContent = message;
    errorBox.hidden = !message;
  }

  function display(session) {
    if (destroyed) return;
    const { total, taxExclusive, taxInclusive } = session.total || {};
    const ready = !automatic || session.tax?.status === 'ready';
    const added = manual ? order.taxCents - order.tipTaxCents : automatic ? taxExclusive?.minorUnitsAmount : 0;
    const included = manual ? order.tipTaxCents : automatic ? taxInclusive?.minorUnitsAmount : 0;
    // The held film and tip amounts already include any tax on the tip.
    matches = ready && session.currency === order.currency && Boolean(total?.amount) &&
      Number.isSafeInteger(added) && added >= 0 && Number.isSafeInteger(included) && included >= 0 &&
      (!marketplace || included <= order.tipAmount) && total.minorUnitsAmount === order.amount + added &&
      (!manual || (order.chargedTotalCents === total.minorUnitsAmount &&
        (taxExclusive == null || added === taxExclusive.minorUnitsAmount) &&
        (taxInclusive == null || included === taxInclusive.minorUnitsAmount)));
    displayedAmount = matches ? total.minorUnitsAmount : undefined;
    if (marketplace) {
      tax.textContent = !ready ? (useViewingAddress ? 'Confirm your viewing address to calculate tax.' : 'Enter your billing address to calculate tax.') : matches
        ? 'Film tax ' + format.format(added / 100) + (included > 0 ? ' · Tax included in tip ' + format.format(included / 100) : '') : '';
    }
    const amount = matches ? total.amount : '';
    price.textContent = amount && marketplace ? 'Total ' + amount : amount;
    button.textContent = submitting ? 'Processing…' : waiting ? 'Confirming payment…' : amount ? 'Pay ' + amount + (order.demo ? ' in test mode' : '') : 'Pay';
    button.disabled = submitting || waiting || !matches || !session.canConfirm;
    const changedPrice = 'The price has changed. Go back to the film and review the offer.';
    if (ready && !matches) feedback(changedPrice);
    else if (errorBox.textContent === changedPrice) feedback('');
  }

  function loadError() {
    if (!destroyed) feedback('The payment fields could not load. Go back to the film and reopen checkout.');
  }

  async function submit(event) {
    event.preventDefault();
    if (destroyed || submitting || waiting || !actions) return;
    const session = actions.getSession();
    const previousAmount = displayedAmount;
    display(session);
    if (!matches || !session.canConfirm || displayedAmount !== previousAmount) return;
    submitting = true;
    feedback('');
    display(session);
    onSubmit();
    try {
      const result = await actions.confirm({ redirect: 'if_required' });
      if (destroyed) return;
      if (result.type === 'error') {
        feedback(result.error?.message || 'Payment did not go through. Review your details and try again.');
        errorBox.focus();
      } else if (result.type === 'success') {
        waiting = true;
        complete();
      } else throw new Error('Payment unavailable');
    } catch {
      if (!destroyed) {
        feedback('Confirmation was interrupted. Check payment before trying again.');
        errorBox.focus();
        interrupted();
      }
    } finally {
      submitting = false;
      if (!destroyed) display(actions.getSession());
    }
  }

  return {
    async mount() {
      const loaded = await checkout.loadActions();
      if (destroyed) return;
      if (loaded.type !== 'success') throw new Error('Card form unavailable');
      actions = loaded.actions;
      const session = actions.getSession();
      feedback('');
      form.hidden = false;
      if (!session.email) {
        contact = checkout.createContactDetailsElement();
        contact.on('loaderror', loadError);
        contact.mount('#contact-element');
      }
      if (automatic) {
        billing.hidden = false;
        document.querySelector('#billing-label').textContent = useViewingAddress ? 'Viewing address' : 'Billing address';
        address = useViewingAddress ? checkout.createShippingAddressElement() : checkout.createBillingAddressElement({ autocomplete: { mode: 'automatic' } });
        address.on('loaderror', loadError);
        address.mount('#billing-address-element');
      }
      payment = checkout.createPaymentElement({
        paymentMethodOrder: ['card'],
        wallets: { link: 'never', ...(order.demo && { applePay: 'never', googlePay: 'never' }) },
        layout: 'tabs',
        fields: { billingDetails: { email: 'never', address: automatic && !useViewingAddress ? 'never' : 'if_required' } }
      });
      payment.on('loaderror', loadError);
      payment.mount('#payment-element');
      checkout.on('change', display);
      display(actions.getSession());
      form.addEventListener('submit', submit);
      narrow.addEventListener('change', resize);
    },
    destroy() {
      destroyed = true;
      form.removeEventListener('submit', submit);
      narrow.removeEventListener('change', resize);
      contact?.destroy();
      address?.destroy();
      payment?.destroy();
      billing.hidden = true;
      form.hidden = true;
      button.disabled = true;
      feedback('');
    }
  };
}
