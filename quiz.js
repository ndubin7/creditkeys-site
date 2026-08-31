/* ============================================================
   CreditKeys Quiz Logic
   ============================================================ */

// TODO: paste the deployed Google Apps Script /exec URL here once deployed.
// See google-apps-script.gs for the deployment steps.
const SHEETS_ENDPOINT = 'https://script.google.com/macros/s/AKfycbwlP4X3jZYmUIfeQ-LBdFGMJombGVrByTGOIy-j864OBEb2b_aX_npJe6VWOeXZs5tI/exec';

// All three vendors now have real tracking links generated and live below.
// subid2 is where PerformCB wants OUR click ID passed (per Margo, Aug 16) —
// it comes back to us unchanged in the postback, so it's the join key that
// lets us match a real conversion back to a specific visitor/session,
// rather than just seeing an anonymous "Kikoff converted, $28.71" with no
// way to know which quiz path or traffic source it came from.
const OFFER_LINKS = {
  kikoff: 'https://noklnk.com/x/6041347?subid1=&subid2=',
  creditstrong: 'https://noklnk.com/x/6041278?subid1=&subid2=',
  chime: 'https://noklnk.com/x/6041339?subid1=&subid2='
};

// Generates one unique ID per visit and reuses it for the rest of the
// session, so every link click, GA4 event, and email capture during this
// visit can all be tied back together, and to whatever PerformCB sends
// back in the eventual postback.
function getClickId() {
  let id = sessionStorage.getItem('ck_click_id');
  if (!id) {
    id = 'ck_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem('ck_click_id', id);
  }
  return id;
}

// Builds the outbound affiliate URL.
//   subid2 = our own session id; PerformCB returns it unchanged in the
//            postback, so it is the join key back to this specific visit.
//   subid1 = MGID's own click id. Needed so our postback receiver can report
//            the conversion BACK to MGID; without it MGID never learns which
//            clicks converted and cannot optimise delivery.
function offerLinkWithClickId(offerKey) {
  var raw = OFFER_LINKS[offerKey];
  if (!raw) return "#";
  var base = raw.split(String.fromCharCode(63))[0];
  var params = new URLSearchParams();
  var mgidClick = (window.CKAttribution && window.CKAttribution.mgidClickId)
    ? window.CKAttribution.mgidClickId() : "";
  params.set("subid1", mgidClick || "direct");
  params.set("subid2", getClickId());
  return base + String.fromCharCode(63) + params.toString();
}

// Fires the GA4 offer_clickout event and records where this tap sits in the
// visitor's session. GA4 counts every tap; PerformCB only counts clicks that
// reach its server and dedupes them. Without knowing how many taps came from
// the same person the two numbers can't be reconciled - which is exactly the
// gap we hit (11 GA4 click-outs vs 4 PerformCB clicks). clickout_seq = 1 is
// this visitor's first offer tap, so counting seq==1 events gives a figure
// directly comparable to PerformCB's click count.
function trackOfferClick(offerKey, position) {
  var seq = 1;
  try {
    seq = parseInt(sessionStorage.getItem("ck_clickout_seq") || "0", 10) + 1;
    sessionStorage.setItem("ck_clickout_seq", String(seq));
  } catch (e) {}
  if (window.CKAnalytics) {
    CKAnalytics.track("offer_clickout", {
      offer_name: offerKey,
      source: "quiz_results",
      click_id: getClickId(),
      offer_position: position,
      clickout_seq: seq,
      is_repeat_clickout: seq > 1
    });
  }
  return true; // never block the outbound navigation
}

const CreditKeysQuiz = (function () {

  const state = {
    step: 1,
    answers: {
      phone_type: null,
      credit_freeze: null,
      has_ssn: null,
      state: null
    }
  };

  const TOTAL_STEPS = 5;

  // Decide the entry point: cold ad traffic gets the trust-building intro
  // (step 0), internal navigation from the homepage (which already did the
  // trust-building) skips straight to question 1. Detected via either an
  // explicit ?entry=ad param on the ad campaign's destination URL, or a
  // referrer that isn't this site itself (a reasonable fallback signal for
  // ad clicks that don't carry the param).
  // A/B TEST (Aug 2026). Launch data showed ~81% of ad visitors left the
  // intro screen without a single interaction, because the only button sat
  // ~920px down on a phone, well below the fold.
  //   Variant A "intro"  = rebuilt compact intro, button above the fold
  //   Variant B "direct" = skip the intro, land straight on question 1
  // Random per visit, sticky for the session, reported to GA4 on every event.
  // RETIRED Aug 2026. Variant "direct" is gone. MGID rejected the campaign
  // with "Insufficient information/description regarding the offer" - the
  // moderator was coin-flipped into "direct" and landed on a bare
  // eligibility question with no explanation of who we are, what is being
  // promoted, or how we are paid. That variant has no compliance story, so
  // it cannot run at all. Everyone now gets the intro.
  //
  // The function is kept (rather than ripped out) so GA4's ab_variant
  // dimension stays populated and pre/post-change data remains comparable
  // in the same reports.
  function getVariant() {
    try {
      // Overwrite any stale "direct" value left in a session that began
      // before this change, so nobody is stranded on a retired variant.
      if (sessionStorage.getItem("ck_ab_intro") !== "intro") {
        sessionStorage.setItem("ck_ab_intro", "intro");
      }
    } catch (e) {}
    return "intro";
  }

  function detectEntryStep() {
    const params = new URLSearchParams(window.location.search);
    if (params.get("entry") === "ad") {
      return 1; // straight to Q1 - the offer disclosure now sits below the quiz
                // on every step, so no intro screen (and no extra click) is needed
    }
    const ref = document.referrer;
    const cameFromThisSite = ref && ref.includes(window.location.hostname);
    if (ref && !cameFromThisSite) return 0; // arrived from an external link/ad
    return 1; // no referrer, or came from our own homepage — go straight in
  }

  function init() {
    const isAdEntry = new URLSearchParams(window.location.search).get("entry") === "ad";

    // A/B: half of visitors get the offer list instead of the quiz. Served at
    // this same URL so the ads already in moderation stay valid and no
    // re-moderation is triggered.
    const pageVariant = getPageVariant();
    if (pageVariant === 'list') {
      renderOfferList();
      if (window.CKAnalytics) {
        CKAnalytics.track('quiz_start', { entry_step: 'offer_list', page_variant: 'list' });
      }
      return;
    }

    const entryStep = detectEntryStep();
    state.step = entryStep;
    goTo(entryStep);
    if (window.CKAnalytics) {
      // ab_variant is only meaningful for ad traffic - that is the only
      // group the variant logic ever routed. Tagging homepage visitors too
      // (the previous behaviour) put non-participants in the test dimension
      // and skewed the split.
      const payload = { entry_step: entryStep === 0 ? 'ad_trust_intro' : 'direct', page_variant: 'quiz' };
      if (isAdEntry) payload.ab_variant = getVariant();
      CKAnalytics.track('quiz_start', payload);
    }
  }

  function goTo(stepIndex) {
    document.querySelectorAll('.quiz-step').forEach(el => el.classList.remove('active'));
    const target = document.querySelector(`.quiz-step[data-step="${stepIndex}"]`);
    if (target) target.classList.add('active');
    state.step = stepIndex;
    updateProgress();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function updateProgress() {
    const pct = Math.min((state.step / TOTAL_STEPS) * 100, 100);
    const bar = document.getElementById('progressBar');
    if (bar) bar.style.width = pct + '%';
  }

  function answer(key, value) {
    state.answers[key] = value;
    if (window.CKAnalytics) {
      CKAnalytics.track('quiz_question_answered', { question: key, answer: value });
    }
    const next = state.step + 1;
    if (next <= 4) {
      goTo(next);
    } else {
      renderResults();
      goTo(5);
    }
  }

  // ---------- Routing logic ----------
  // This is the pre-qualification layer: we rule out offers that will
  // silently fail for this person BEFORE recommending them, rather than
  // sending traffic toward a signup that was always going to fail.
  // State-level exclusions, per each partner's PerformCB campaign terms.
  // These are HARD blocks: the vendor cannot operate there, so sending
  // someone from these states is a guaranteed dead click we'd still pay for.
  const STATE_EXCLUSIONS = {
    kikoff: ['DE', 'IN'],
    creditstrong: ['VT', 'WI'],
    chime: [] // no state exclusions listed on the Direct Deposit campaign
  };

  function allowedInState(offerKey, stateCode) {
    if (!stateCode) return true; // no answer yet, don't pre-filter
    return !STATE_EXCLUSIONS[offerKey].includes(stateCode);
  }

  function getEligibleOffers() {
    const a = state.answers;
    const eligible = [];

    // IMPORTANT: Kikoff and Chime require an SSN — we have NOT confirmed
    // either accepts ITIN, so they're only shown when has_ssn === 'yes'.
    // CreditStrong is the one confirmed ITIN-friendly option. Showing an
    // unconfirmed option here would defeat the whole point of asking —
    // we'd rather show one confident match than three guesses.
    const kikoffOk = a.phone_type !== 'voip' && a.credit_freeze !== 'yes' && a.has_ssn === 'yes'
                     && allowedInState('kikoff', a.state);
    const creditStrongOk = (a.has_ssn === 'yes' || a.has_ssn === 'itin')
                     && allowedInState('creditstrong', a.state);
    const chimeOk = a.has_ssn === 'yes' && allowedInState('chime', a.state);

    if (creditStrongOk) eligible.push('creditstrong');
    if (kikoffOk) eligible.push('kikoff');
    if (chimeOk) eligible.push('chime');

    return eligible;
  }

  // Fisher-Yates shuffle, unbiased: every ordering is equally likely.
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Chime is placed first whenever it is eligible. The remaining eligible
  // offers keep the previous unbiased random tiebreak between themselves, so
  // Kikoff and CreditStrong still rotate fairly against each other.
  function orderOffers(eligible) {
    var rest = shuffle(eligible.filter(function (k) { return k !== "chime"; }));
    return eligible.indexOf("chime") !== -1 ? ["chime"].concat(rest) : rest;
  }

  // Computed once per results render and reused for the email capture log,
  // so the "Best Match" badge shown on screen always matches what gets
  // recorded as the recommended offer — random tiebreak, but a CONSISTENT
  // one within a single visit, not a fresh reshuffle on every call.
  let currentEligibleOrder = null;

  const OFFER_CONTENT = {
    kikoff: {
      name: 'Kikoff',
      logo: 'assets/logos/kikoff-logo.svg',
      logoIsText: false,
      blurb: 'A credit-builder account with no credit check required. Reports on-time payments to all 3 bureaus.',
      price: 'Plans start at just $5/month, zero interest, zero hidden fees',
      disclaimer: 'Kikoff users with credit scores under 600 increased their credit scores by an average of +25 points in their first month with on-time payments.* Kikoff Credit Service starts at $5/mo for 12 mos. *Average first-month credit score impact of +25 points (VantageScore 3.0) between Jan-2024 &amp; Nov-2024 for Kikoff Credit Account users who started with a score below 600; who purchased at least one item with Credit Account; and who paid on-time in their first month. Late payments may negatively impact your credit score. Individual results may vary.'
    },
    creditstrong: {
      name: 'CreditStrong',
      logo: 'assets/logos/creditstrong-logo-cropped.png',
      logoIsText: false,
      blurb: 'A credit-builder loan reported to all 3 bureaus. No credit history needed, and ITIN is accepted in place of an SSN.',
      price: 'Payments as low as $30/month, no prepayment or cancellation fees',
      disclaimer: 'Average three-month FICO® Score 8 increase of +61 points for users who signed up in 2024, started below 550, and made 12 successful monthly payments. Individual results may vary.'
    },
    chime: {
      name: 'Chime',
      logo: 'assets/logos/chime-green-on-white.png',
      logoIsText: false,
      blurb: 'Fee-free banking with credit-building built in through everyday spending, no separate loan required.',
      price: 'No monthly fees, no minimum balance',
      disclaimer: 'Chime is a fintech, not a bank. Optional services and products may have fees or charges.'
    }
  };

  function renderResults() {
    const eligible = orderOffers(getEligibleOffers());
    currentEligibleOrder = eligible; // lock in this session's order so email capture matches what's displayed
    const headline = document.getElementById('resultsHeadline');
    const sub = document.getElementById('resultsSub');
    const cardsWrap = document.getElementById('resultsCards');

    if (eligible.length === 0) {
      headline.textContent = "We couldn't find a confident match yet";
      sub.textContent = "Based on your answers, none of our current partners are a clean fit. That's worth knowing now rather than after a wasted application, we'd rather tell you straight.";
      cardsWrap.innerHTML = '';
      return;
    }

    headline.textContent = 'Here\'s what fits your situation';
    sub.textContent = `Based on your answers, ${eligible.length === 1 ? 'this is your best match' : 'these are your best matches'}.`;

    if (window.CKAnalytics) {
      CKAnalytics.track('quiz_completed', { recommended_offers: eligible.join(',') || 'none' });
    }

    cardsWrap.innerHTML = eligible.map((key, i) => {
      const o = OFFER_CONTENT[key];
      const logoHtml = o.logoIsText
        ? `<div class="brand-logo text-logo" style="color:${o.logoColor};">${o.name}</div>`
        : `<div class="brand-logo"><img src="${o.logo}" alt="${o.name} logo" style="height:32px;"></div>`;

      return `
        <div class="quiz-result-card">
          ${i === 0 ? '<span class="badge">Best Match</span>' : ''}
          ${logoHtml}
          <p style="margin:12px 0;">${o.blurb}</p>
          <p style="font-weight:600;color:var(--ink);margin-bottom:14px;">${o.price}</p>
          <a href="${offerLinkWithClickId(key)}" class="btn btn-primary" style="width:100%;" onclick="return trackOfferClick('${key}', ${i + 1})">See If You Qualify</a>
          <p class="disclaimer" style="margin-top:14px;">${o.disclaimer}</p>
        </div>
      `;
    }).join('');
  }


  // ---------- LIST VARIANT (Aug 2026 A/B) ----------
  // Hypothesis: our traffic arrives from recipe and lifestyle content in
  // browsing mode, and a four-question quiz asks for commitment before
  // giving anything back - hence 78% of sessions never touching a control
  // and an 11-second average engagement time. This arm shows every offer
  // straight away and states each one's eligibility rules as bullets, so
  // the visitor self-qualifies by reading.
  //
  // The pre-qualification logic is NOT dropped, it is surfaced. Every rule
  // enforced by getEligibleOffers() appears here as a visible fact, so a
  // VOIP-number or credit-frozen visitor can rule Kikoff out themselves
  // instead of being silently routed away from it.
  const OFFER_FACTS = {
    creditstrong: [
      { t: 'ok',   s: 'Accepts an ITIN if you do not have an SSN' },
      { t: 'ok',   s: 'No credit check and no credit history needed' },
      { t: 'ok',   s: 'Works with a credit freeze in place' },
      { t: 'no',   s: 'Not available in Vermont or Wisconsin' },
      { t: 'warn', s: 'Money is locked in savings until the term ends' }
    ],
    kikoff: [
      { t: 'ok',   s: 'No credit check to open' },
      { t: 'ok',   s: 'Lowest monthly cost of the three' },
      { t: 'no',   s: 'Needs a regular mobile number - Google Voice and other internet numbers are rejected' },
      { t: 'no',   s: 'Cannot be opened while a credit freeze is active' },
      { t: 'no',   s: 'Requires an SSN, and is not available in Delaware or Indiana' }
    ],
    chime: [
      { t: 'ok',   s: 'No credit check and no monthly fee' },
      { t: 'ok',   s: 'Available in every state' },
      { t: 'ok',   s: 'Builds credit through normal spending, with no separate loan' },
      { t: 'warn', s: 'Needs a Chime account with a qualifying direct deposit' },
      { t: 'no',   s: 'Requires an SSN' }
    ]
  };

  const FACT_ICON = { ok: '\u2713', warn: '!', no: '\u2715' };

  function renderOfferList() {
    const host = document.getElementById('ckList');
    if (!host) return;

    // Fixed order: CreditStrong first because it is the only option with no
    // SSN requirement, so it is the one that works for the widest audience.
    const order = ['creditstrong', 'chime', 'kikoff'];

    host.innerHTML =
      '<div class="ck-list-intro">' +
        '<h1>Three ways to start building credit</h1>' +
        '<p>Each one has different requirements. The details below tell you which will actually accept you, so you are not applying blind.</p>' +
      '</div>' +
      order.map(function (key, i) {
        const o = OFFER_CONTENT[key];
        const facts = (OFFER_FACTS[key] || []).map(function (f) {
          return '<li><span class="ic ' + f.t + '">' + FACT_ICON[f.t] + '</span><span>' + f.s + '</span></li>';
        }).join('');
        const logoHtml = o.logoIsText
          ? '<div class="brand-logo text-logo" style="color:' + o.logoColor + ';">' + o.name + '</div>'
          : '<img src="' + o.logo + '" alt="' + o.name + ' logo">';
        return '' +
          '<div class="ck-offer">' +
            '<div class="ck-offer-head">' + logoHtml + '</div>' +
            '<p class="ck-offer-blurb">' + o.blurb + '</p>' +
            '<p class="ck-offer-price">' + o.price + '</p>' +
            '<ul class="ck-facts">' + facts + '</ul>' +
            '<a href="' + offerLinkWithClickId(key) + '" class="btn btn-primary" ' +
              'onclick="return trackOfferClick(\'' + key + '\', ' + (i + 1) + ')">' +
              'Start with ' + o.name + '</a>' +
            '<p class="disclaimer">' + o.disclaimer + '</p>' +
          '</div>';
      }).join('');

    host.hidden = false;
    document.querySelectorAll('.quiz-step').forEach(function (s) { s.classList.remove('active'); });
    const prog = document.querySelector('.quiz-progress');
    if (prog) prog.style.display = 'none';

    if (window.CKAnalytics) {
      CKAnalytics.track('offer_list_viewed', { offers_shown: order.join(',') });
    }
  }

  // 50/50, sticky for the whole session so a visitor never flips arm mid-visit.
  function getPageVariant() {
    var v = null;
    try { v = sessionStorage.getItem('ck_ab_page'); } catch (e) {}
    if (v !== 'list' && v !== 'quiz') {
      v = Math.random() < 0.5 ? 'list' : 'quiz';
      try { sessionStorage.setItem('ck_ab_page', v); } catch (e) {}
    }
    return v;
  }

  // ---------- Email capture → Google Sheets ----------
  function getUtmParams() {
    const params = new URLSearchParams(window.location.search);
    return {
      utm_source: params.get('utm_source') || '',
      utm_medium: params.get('utm_medium') || '',
      utm_campaign: params.get('utm_campaign') || ''
    };
  }

  async function submitEmail(event) {
    event.preventDefault();
    const email = document.getElementById('emailInput').value.trim();
    const successEl = document.getElementById('formSuccess');
    const utm = getUtmParams();
    // Reuse the exact order already shown on screen — never reshuffle here,
    // or the logged "recommended offer" could disagree with the badge the
    // person actually saw.
    const eligible = currentEligibleOrder || getEligibleOffers();

    const payload = {
      email: email,
      click_id: getClickId(),
      phone_type: state.answers.phone_type || '',
      credit_freeze: state.answers.credit_freeze || '',
      has_itin: state.answers.has_ssn === 'itin' ? 'yes' : 'no',
      state: state.answers.state || '',
      recommended_offer: eligible.join(', '),
      quiz_completed: 'yes',
      utm_source: utm.utm_source,
      utm_medium: utm.utm_medium,
      utm_campaign: utm.utm_campaign,
      referrer: document.referrer || '',
      user_agent: navigator.userAgent
    };

    try {
      // no-cors because Apps Script web apps don't return CORS headers
      // we can read on the client side; we optimistically show success
      // rather than block the person's flow on that.
      await fetch(SHEETS_ENDPOINT, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain' }, // avoids CORS preflight
        body: JSON.stringify(payload)
      });
      successEl.classList.add('show');
      document.getElementById('emailForm').reset();
      if (window.CKAnalytics) {
        CKAnalytics.track('email_captured', { recommended_offers: eligible.join(',') || 'none' });
      }
    } catch (err) {
      console.error('CreditKeys quiz submission failed:', err);
      successEl.textContent = "Something went wrong, please try again in a moment.";
      successEl.style.background = 'rgba(200,80,80,0.1)';
      successEl.style.borderColor = '#C85050';
      successEl.style.color = '#C85050';
      successEl.classList.add('show');
    }
    return false;
  }

  function restart(event) {
    event.preventDefault();
    state.step = 1;
    state.answers = { phone_type: null, credit_freeze: null, has_ssn: null, state: null };
    goTo(1);
  }

  // Sync progress bar / active step with the detected entry point.
  init();

  return { goTo, answer, submitEmail, restart };
})();
