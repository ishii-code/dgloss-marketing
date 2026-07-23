/*!
 * dg-work-monitor 問い合わせ流入トラッカー
 * 自社サイトの問い合わせフォームのページに貼るだけで、流入元(UTM/リファラ/
 * ランディングページ)を計測し、フォーム送信時に集計サーバへ送信する。
 *
 * 使い方（<head> か </body> 直前に設置）:
 *   <script
 *     src="https://<あなたのVercelドメイン>/inquiry-tracker.js"
 *     data-endpoint="https://<あなたのVercelドメイン>/api/inquiries/ingest"
 *     data-token="＜INQUIRY_INGEST_TOKEN と同じ値＞"
 *     data-form="form"            <!-- 問い合わせフォームの CSS セレクタ(省略時は最初の form) -->
 *     data-own-domain="dgloss.co.jp"
 *     defer></script>
 *
 * 個人情報の送信を避けたい場合は data-collect-fields="false" を付けると、
 * 氏名・メール等のフォーム内容は送らず、流入元情報のみを送信する。
 */
(function () {
  'use strict';
  var script = document.currentScript;
  if (!script) return;
  var cfg = {
    endpoint: script.getAttribute('data-endpoint') || '',
    token: script.getAttribute('data-token') || '',
    formSelector: script.getAttribute('data-form') || 'form',
    ownDomain: script.getAttribute('data-own-domain') || location.hostname,
    collectFields: script.getAttribute('data-collect-fields') !== 'false',
  };
  if (!cfg.endpoint) { return; }

  var STORAGE_KEY = 'dgwm_attribution';
  var UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];

  function readStore() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (e) { return null; }
  }
  function writeStore(v) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(v)); } catch (e) { /* private mode etc. */ }
  }

  // 初回訪問時の流入元を保存（以後のページ遷移では上書きしない = ファーストタッチ）。
  function captureAttribution() {
    var existing = readStore();
    var params = new URLSearchParams(location.search);
    var hasUtm = UTM_KEYS.some(function (k) { return params.get(k); });

    // すでに保存済みで、今回UTMが無ければそのまま使う。
    if (existing && !hasUtm) return existing;

    var attribution = existing || {};
    if (!existing) {
      attribution.referrer = document.referrer || '';
      attribution.landing_page = location.href;
      attribution.first_seen = new Date().toISOString();
    }
    UTM_KEYS.forEach(function (k) {
      var v = params.get(k);
      if (v) attribution[k] = v;
    });
    writeStore(attribution);
    return attribution;
  }

  var attribution = captureAttribution();

  // よくあるフィールド名から値を拾う（name 属性 / autocomplete で推測）。
  var FIELD_HINTS = {
    company: ['company', 'organization', 'org', '会社', '企業', '会社名', '企業名'],
    contact_name: ['name', 'fullname', 'your-name', 'お名前', '氏名', '担当'],
    email: ['email', 'mail', 'e-mail', 'メール'],
    phone: ['phone', 'tel', 'telephone', '電話'],
    inquiry_type: ['type', 'subject', 'category', '種別', '件名', '題名'],
    industry: ['industry', '業種'],
    region: ['region', 'prefecture', 'pref', '都道府県', '地域'],
    message: ['message', 'body', 'content', 'inquiry', 'comment', '内容', '本文', 'お問い合わせ'],
  };

  function guessField(form, keys) {
    var els = form.querySelectorAll('input[name], textarea[name], select[name]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var name = (el.getAttribute('name') || '').toLowerCase();
      var ph = (el.getAttribute('placeholder') || '').toLowerCase();
      var id = (el.getAttribute('id') || '').toLowerCase();
      for (var j = 0; j < keys.length; j++) {
        var key = keys[j].toLowerCase();
        if (name.indexOf(key) !== -1 || ph.indexOf(key) !== -1 || id.indexOf(key) !== -1) {
          if (el.type === 'checkbox' || el.type === 'radio') {
            if (el.checked) return el.value;
            continue;
          }
          if (el.value) return el.value;
        }
      }
    }
    return null;
  }

  function buildPayload(form) {
    var payload = {
      token: cfg.token,
      received_at: new Date().toISOString(),
      referrer: attribution.referrer || document.referrer || '',
      landing_page: attribution.landing_page || '',
      source_page: location.href,
    };
    UTM_KEYS.forEach(function (k) { if (attribution[k]) payload[k] = attribution[k]; });

    if (cfg.collectFields && form) {
      Object.keys(FIELD_HINTS).forEach(function (field) {
        var v = guessField(form, FIELD_HINTS[field]);
        if (v) payload[field] = v;
      });
    }
    return payload;
  }

  function send(payload) {
    try {
      var body = JSON.stringify(payload);
      if (navigator.sendBeacon) {
        var blob = new Blob([body], { type: 'application/json' });
        if (navigator.sendBeacon(cfg.endpoint, blob)) return;
      }
      fetch(cfg.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        keepalive: true,
        mode: 'cors',
      }).catch(function () { /* 送信失敗はフォーム送信を妨げない */ });
    } catch (e) { /* noop */ }
  }

  function attach() {
    var forms = document.querySelectorAll(cfg.formSelector);
    if (!forms.length) return;
    forms.forEach(function (form) {
      if (form.__dgwmAttached) return;
      form.__dgwmAttached = true;
      // submit をブロックせず、送信直前に計測ビーコンだけ飛ばす。
      form.addEventListener('submit', function () { send(buildPayload(form)); }, true);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attach);
  } else {
    attach();
  }
  // Contact Form 7 等 Ajax 送信のフォームにも対応（描画後に再アタッチ）。
  document.addEventListener('wpcf7submit', function (e) {
    var form = e && e.target ? e.target : document.querySelector(cfg.formSelector);
    if (form) send(buildPayload(form));
  }, false);

  // 手動送信用に公開（テスト・カスタム連携向け）。
  window.dgwmTrackInquiry = function (extra) {
    var form = document.querySelector(cfg.formSelector);
    var payload = buildPayload(form);
    if (extra && typeof extra === 'object') {
      Object.keys(extra).forEach(function (k) { payload[k] = extra[k]; });
    }
    send(payload);
  };
})();
