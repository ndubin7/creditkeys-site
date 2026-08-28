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
  function getVariant() {
    var v = null;
    try { v = sessionStorage.getItem("ck_ab_intro"); } catch (e) {}
    if (!v) {
      v = Math.random() < 0.5 ? "intro" : "direct";
      try { sessionStorage.setItem("ck_ab_intro", v); } catch (e) {}
    }
    return v;
  }

  function detectEntryStep() {
    const params = new URLSearchParams(window.location.search);
    if (params.get("entry") === "ad") {
      return getVariant() === "direct" ? 1 : 0;
    }
    const ref = document.referrer;
    const cameFromThisSite = ref && ref.includes(window.location.hostname);
    if (ref && !cameFromThisSite) return 0; // arrived from an external link/ad
    return 1; // no referrer, or came from our own homepage — go straight in
  }

  function init() {
    const entryStep = detectEntryStep();
    state.step = entryStep;
    goTo(entryStep);
    if (window.CKAnalytics) {
      CKAnalytics.track('quiz_start', { entry_step: entryStep === 0 ? 'ad_trust_intro' : 'direct', ab_variant: getVariant() });
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
    const eligible = shuffle(getEligibleOffers());
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
          <a href="${offerLinkWithClickId(key)}" class="btn btn-primary" style="width:100%;" onclick="CKAnalytics.track('offer_clickout', {offer_name: '${key}', source: 'quiz_results', click_id: getClickId()})">See If You Qualify</a>
          <p class="disclaimer" style="margin-top:14px;">${o.disclaimer}</p>
        </div>
      `;
    }).join('');
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
