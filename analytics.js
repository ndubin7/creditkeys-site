/* ----------------------------------------------------------------
   CreditKeys - Traffic Attribution + A/B Capture  (added Aug 2026)

   Captures MGID ad-level attribution on the landing hit and keeps it for
   the whole session, so a conversion coming back from PerformCB can be
   traced to the exact ad, publisher placement and campaign that produced
   it. Also exposes the A/B variant so both arms are comparable in GA4.

   Params expected on the ad destination URL (MGID macros):
     ck_click  = {click_id}     MGID per-click id (also used to postback
                                the conversion BACK to MGID)
     ck_ad     = {teaser_id}    which creative
     ck_widget = {widget_id}    which publisher placement  <-- block bad ones
     ck_camp   = {campaign_id}  which campaign
   ---------------------------------------------------------------- */
(function () {
  var STORE = { click:"ck_mgid_click", ad:"ck_mgid_ad", widget:"ck_mgid_widget", camp:"ck_mgid_camp", lp:"ck_lp" };

  function params() {
    try { return new URLSearchParams(window.location.search); } catch (e) { return null; }
  }
  // Only overwrite when the URL actually carries a value, so later internal
  // navigation cannot wipe the original ad attribution.
  function stash(name, key) {
    var ps = params(); if (!ps) return;
    var v = ps.get(name);
    if (v) { try { sessionStorage.setItem(key, v); } catch (e) {} }
  }
  stash("ck_click", STORE.click);
  stash("ck_ad", STORE.ad);
  stash("ck_widget", STORE.widget);
  stash("ck_camp", STORE.camp);
  // Landing-page test arm (Aug 2026): "home" = ad pointed at the homepage,
  // "quiz" = ad pointed straight at the quiz. Absent means quiz, so the
  // ads already live and in moderation need no edit to stay comparable.
  stash("lp", STORE.lp);

  function get(k){ try { return sessionStorage.getItem(k) || ""; } catch(e){ return ""; } }

  // Our own session id. Defined here because analytics.js loads before
  // quiz.js; quiz.js reads the same key, so both agree on one id per visit.
  function ourClickId() {
    var id = null;
    try { id = sessionStorage.getItem("ck_click_id"); } catch (e) {}
    if (!id) {
      id = "ck_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10);
      try { sessionStorage.setItem("ck_click_id", id); } catch (e) {}
    }
    return id;
  }

  window.CKAttribution = {
    ourClickId: ourClickId,
    mgidClickId: function(){ return get(STORE.click); },
    all: function () {
      return {
        ck_click_id: ourClickId(),
        mgid_click_id: get(STORE.click),
        mgid_ad_id: get(STORE.ad),
        mgid_widget_id: get(STORE.widget),
        mgid_campaign_id: get(STORE.camp),
        ab_variant: get("ck_ab_intro"),
        landing_variant: get(STORE.lp) || "quiz"
      };
    }
  };
  ourClickId();
})();
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
      if (typeof gtag === "function") {
        // Merge attribution + A/B variant into every event so GA4 funnel data
        // can be joined to a PerformCB conversion and split by test arm.
        var merged = {};
        var attr = (window.CKAttribution && window.CKAttribution.all) ? window.CKAttribution.all() : {};
        for (var k in attr) { if (attr[k]) merged[k] = attr[k]; }
        if (params) { for (var p in params) { merged[p] = params[p]; } }
        gtag("event", eventName, merged);
      }
    }
  };
})();
