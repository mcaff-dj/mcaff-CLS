'use client';

import { useEffect } from 'react';

var QUESTIONS = [
  { id: 1, text: 'A customer added only one product during a "Buy 1 Get 1" offer. It is her birthday and her first order. What should be done?' },
  { id: 2, text: 'A customer claims a delivery boy abused and misbehaved with her. What should be done?' },
  { id: 3, text: 'A customer is unable to apply the coupon "B2799" on Power Peptide. What should be done?' },
  { id: 4, text: 'A customer mentioned that the Google coupon code for "Buy 2 Get 7" is not working, even though the "Buy 3 at 999" offer is already live on the site. (a) What should be done if the coupon code provided was wrong? (b) What should be done if the customer is applying it incorrectly?' },
  { id: 5, text: 'A customer mentioned the product is not effective after using it for two months and has reached out on different platforms. What should be done?' },
  { id: 6, text: 'A customer mentioned they added two products to their cart and wants to know why they didn’t receive three free products. What should be done?' },
  { id: 7, text: 'A customer ordered from Amazon and the product caused a skin reaction (acne/pimples). What should be done?' },
  { id: 8, text: 'A customer ordered from Blinkit and the products arrived totally broken. What should be done?' },
  { id: 9, text: 'A customer purchased body lotion but cannot use it because the pump is missing or not working. What should be done?' },
  { id: 10, text: 'A customer reached out regarding a refund not reflecting in their bank account. We shared screenshots from all three platforms, but the customer has now shared their UPI statement with us. What should be done?' },
  { id: 11, text: 'A customer reached out with a screenshot of a payment issue, mentioning they haven’t received an order ID or a refund yet. What should be done?' },
  { id: 12, text: 'A customer shared an unboxing video showing she received Mamaearth products in her box instead of ours. What should be done?' },
  { id: 13, text: 'A customer who has spoken to 4+ agents is now assigned to you; they are highly frustrated and asking for a freebie (Stanley). What should be done?' },
  { id: 14, text: 'An order has been delayed for over 8 days and the customer has reached out to our founder to raise a formal complaint. What should be done?' },
  { id: 15, text: 'An order was placed on 1 June and the status is still reflecting as "Pickup Generated." What should be done?' },
  { id: 16, text: 'An order was placed on 14 April (RTO) and the customer is now asking for a refund. What should be done?' },
  { id: 17, text: 'If a customer mentions they are trying to apply a Google Form coupon code but are unable to do so, what should be done?' },
  { id: 18, text: 'If an order was split (two products), one was delivered and the second was partially dispatched. The order was COD and the customer reached out after 25 days. What should be done?' },
  { id: 19, text: 'We mistakenly promised a customer they would receive a Stanley, and now they have reached out to us over Twitter. What should be done?' },
  { id: 20, text: 'What is the difference between "Buy 2 Get 3" and "Buy 2 Get 5"?' }
];

function esc(s) {
  var d = document.createElement('div');
  d.textContent = (s == null ? '' : String(s));
  return d.innerHTML;
}

// Deterministic per-user shuffle: same user always sees the same order (stable across
// reloads), but different users get a different order. Seeded from their email so no
// server round trip is needed just to pick an order.
function hashSeed(str) {
  var h = 1779033703 ^ str.length;
  for (var i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

function shuffle(arr, rand) {
  var a = arr.slice();
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(rand() * (i + 1));
    var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
  }
  return a;
}

var orderedQuestions = QUESTIONS;

function renderForm() {
  var form = document.getElementById('testForm');
  form.innerHTML = orderedQuestions.map(function (q, idx) {
    return '<div class="qa-card">' +
      '<p class="qa-q"><span class="qa-num">' + (idx + 1) + '.</span> ' + esc(q.text) + '</p>' +
      '<textarea class="qa-answer" data-id="' + q.id + '" placeholder="Type your answer..."></textarea>' +
      '</div>';
  }).join('');
}

function showError(msg) {
  var b = document.getElementById('errorBanner');
  b.textContent = msg;
  b.style.display = 'block';
}

function submitTest() {
  var textareas = Array.prototype.slice.call(document.querySelectorAll('.qa-answer'));
  var answers = textareas.map(function (t) {
    return { id: parseInt(t.dataset.id, 10), text: t.value };
  });

  var btn = document.getElementById('submitBtn');
  btn.disabled = true;
  textareas.forEach(function (t) { t.disabled = true; });
  document.getElementById('submitStatus').textContent = 'Submitting...';

  fetch('/api/onboarding/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answers: answers })
  })
    .then(function (r) {
      if (!r.ok) throw new Error('Submit failed (' + r.status + ')');
      return r.json();
    })
    .then(function (d) { showResult(d); })
    .catch(function (e) {
      document.getElementById('submitStatus').textContent = '';
      showError(e.message || 'Could not submit the test. Please try again.');
      btn.disabled = false;
      textareas.forEach(function (t) { t.disabled = false; });
    });
}

function showResult(d) {
  document.getElementById('submitStatus').textContent = '';
  document.getElementById('submitBtn').style.display = 'none';
  document.getElementById('testForm').style.display = 'none';

  var scoreById = {};
  d.results.forEach(function (r) { scoreById[r.id] = r; });

  var breakdownHtml = orderedQuestions.map(function (q, idx) {
    var r = scoreById[q.id] || { score: 0, max: 5 };
    var cls = r.score >= r.max ? 'b-full' : (r.score > 0 ? 'b-partial' : 'b-zero');
    return '<div class="b-item ' + cls + '"><div class="b-q">Q' + (idx + 1) + '</div><div class="b-s">' + r.score + '/' + r.max + '</div></div>';
  }).join('');

  var panel = document.getElementById('resultPanel');
  panel.style.display = 'block';
  panel.innerHTML =
    '<div class="score-card">' +
      '<p class="score-big">' + d.total + ' / ' + d.max + '</p>' +
      '<p class="score-label">Your score</p>' +
      '<div class="breakdown">' + breakdownHtml + '</div>' +
    '</div>';
}

export default function OnboardingClient() {
  useEffect(() => {
    fetch('/api/auth/me').then(function (r) { return r.json(); }).then(function (d) {
      var seed = (d && d.email) ? d.email : String(Math.random());
      orderedQuestions = shuffle(QUESTIONS, hashSeed(seed));
      renderForm();
    }).catch(function () {
      orderedQuestions = QUESTIONS;
      renderForm();
    });

    document.getElementById('submitBtn').addEventListener('click', submitTest);
  }, []);

  return (
    <div className="onboarding-page">
      <div className="wrap">
        <a className="home-link" href="/" target="_top">&larr; Home</a>
        <header>
          <div><span className="badge">Test</span></div>
          <h1>Onboarding Test</h1>
          <p id="introText">Write how you&apos;d handle each scenario in your own words, then submit to see your score. Questions are in a randomized order &mdash; expected answers aren&apos;t shown.</p>
        </header>

        <div id="errorBanner" className="error-banner" style={{ display: 'none' }}></div>
        <form id="testForm"></form>
        <div className="submit-bar"><button id="submitBtn" type="button">Submit Test</button></div>
        <div id="submitStatus"></div>

        <div id="resultPanel" style={{ display: 'none' }}></div>
      </div>
    </div>
  );
}
