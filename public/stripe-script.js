let scriptPromise;

export function stripeScript() {
  scriptPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://js.stripe.com/endive/stripe.js';
    script.referrerPolicy = 'origin';
    script.onload = resolve;
    script.onerror = () => {
      script.remove();
      scriptPromise = undefined;
      reject(new Error('Stripe unavailable'));
    };
    document.head.append(script);
  });
  return scriptPromise;
}
