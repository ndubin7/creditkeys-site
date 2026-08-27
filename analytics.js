/* ============================================================
   CreditKeys — GA4 Analytics
   ============================================================
   SETUP REQUIRED (do this yourself in your own Google account, not
   something to automate):
   1. Go to analytics.google.com, sign in with the account you want
      this tied to
   2. Admin (gear icon, bottom left) → Create Property → name it
      "CreditKeys" → fill in basic details → Create
   3. Under "Data Streams" → Add stream → Web → enter
      https://creditkeys.online → give it a stream name
   4. Copy the Measurement ID it gives you (looks like G-XXXXXXXXXX)
   5. Paste it into the GA_MEASUREMENT_ID constant below, replacing
      the placeholder
   6. Redeploy the site

   Until you do that, this file loads harmlessly and does nothing,
   no errors, just no data collection yet.
   ============================================================ */

const GA_MEASUREMENT_ID = 'G-7QN1L27R85';

(function () {
  if (!GA_MEASUREMENT_ID || GA_MEASUREMENT_ID === 'G-XXXXXXXXXX') {
    console.warn('CreditKeys analytics: GA4 not configured yet (see analytics.js header for setup steps)');
    window.CKAnalytics = { track: function () {} }; // no-op so calls elsewhere never break
    return;
  }

  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;
  document.head.appendChild(script);

  window.dataLayer = window.dataLayer || [];
  function gtag() { dataLayer.push(arguments); }
  window.gtag = gtag;
  gtag('js', new Date());
  gtag('config', GA_MEASUREMENT_ID);

  // Single entry point every page/script uses, so event naming stays
  // consistent instead of scattered gtag() calls with typo-able names.
  window.CKAnalytics = {
    track: function (eventName, params) {
      if (typeof gtag === 'function') {
        gtag('event', eventName, params || {});
      }
    }
  };
})();
