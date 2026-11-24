/*!
 * VOYAFORM thank-you block as a Wix custom element. Same setup as voyaform-pages.js (shadow DOM, "VF" Google Fonts faces, self-sizing).
 * File: voyaform-thanks.js   Build: 2026-11-24
 * Tag: <voyaform-thanks>   sits under the Wix Thank You Page widget, in its own section.
 * The page code gives it the order through the "order" attribute:
 *   {"hasPass":true,"promo":true,"plans":["VOYACOLD 2026 - 10 classes"],"orderId":"…","name":"…","preview":false}
 * It shows nothing until it gets an order with a pass.
 * Events: "voya-thanks" {id, orderId, contest, party, voyanews, at}   "voya-height" {height}
 * The page code answers with the "form-result" attribute: {"id":"…","ok":true}
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.customElements) { return; }
  var TAG = 'voyaform-thanks';
  if (window.customElements.get(TAG)) { return; }

  var FONT_CSS = "@font-face{font-family:'VF Anton';font-style:normal;font-weight:400;font-display:swap;src:url(https://fonts.gstatic.com/s/anton/v27/1Ptgg87LROyAm3K9-C8CSKlvPfE.woff2) format('woff2');unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C4,U+2113,U+2C60-2C7F,U+A720-A7FF}@font-face{font-family:'VF Anton';font-style:normal;font-weight:400;font-display:swap;src:url(https://fonts.gstatic.com/s/anton/v27/1Ptgg87LROyAm3Kz-C8CSKlv.woff2) format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}@font-face{font-family:'VF Caveat';font-style:normal;font-weight:700;font-display:swap;src:url(https://fonts.gstatic.com/s/caveat/v23/WnznHAc5bAfYB2QRah7pcpNvOx-pjRV6eIupYT5Kmgq3s84t.woff2) format('woff2');unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C4,U+2113,U+2C60-2C7F,U+A720-A7FF}@font-face{font-family:'VF Caveat';font-style:normal;font-weight:700;font-display:swap;src:url(https://fonts.gstatic.com/s/caveat/v23/WnznHAc5bAfYB2QRah7pcpNvOx-pjRV6eIWpYT5Kmgq3sw.woff2) format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}@font-face{font-family:'VF Poppins';font-style:normal;font-weight:400;font-display:swap;src:url(https://fonts.gstatic.com/s/poppins/v24/pxiEyp8kv8JHgFVrJJnecnFHGPezSQ.woff2) format('woff2');unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C4,U+2113,U+2C60-2C7F,U+A720-A7FF}@font-face{font-family:'VF Poppins';font-style:normal;font-weight:400;font-display:swap;src:url(https://fonts.gstatic.com/s/poppins/v24/pxiEyp8kv8JHgFVrJJfecnFHGPc.woff2) format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}@font-face{font-family:'VF Poppins';font-style:normal;font-weight:500;font-display:swap;src:url(https://fonts.gstatic.com/s/poppins/v24/pxiByp8kv8JHgFVrLGT9Z1JlFd2JQEl8qw.woff2) format('woff2');unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C4,U+2113,U+2C60-2C7F,U+A720-A7FF}@font-face{font-family:'VF Poppins';font-style:normal;font-weight:500;font-display:swap;src:url(https://fonts.gstatic.com/s/poppins/v24/pxiByp8kv8JHgFVrLGT9Z1xlFd2JQEk.woff2) format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}@font-face{font-family:'VF Poppins';font-style:normal;font-weight:600;font-display:swap;src:url(https://fonts.gstatic.com/s/poppins/v24/pxiByp8kv8JHgFVrLEj6Z1JlFd2JQEl8qw.woff2) format('woff2');unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C4,U+2113,U+2C60-2C7F,U+A720-A7FF}@font-face{font-family:'VF Poppins';font-style:normal;font-weight:600;font-display:swap;src:url(https://fonts.gstatic.com/s/poppins/v24/pxiByp8kv8JHgFVrLEj6Z1xlFd2JQEk.woff2) format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}@font-face{font-family:'VF Poppins';font-style:normal;font-weight:700;font-display:swap;src:url(https://fonts.gstatic.com/s/poppins/v24/pxiByp8kv8JHgFVrLCz7Z1JlFd2JQEl8qw.woff2) format('woff2');unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C4,U+2113,U+2C60-2C7F,U+A720-A7FF}@font-face{font-family:'VF Poppins';font-style:normal;font-weight:700;font-display:swap;src:url(https://fonts.gstatic.com/s/poppins/v24/pxiByp8kv8JHgFVrLCz7Z1xlFd2JQEk.woff2) format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}@font-face{font-family:'VF Silkscreen';font-style:normal;font-weight:400;font-display:swap;src:url(https://fonts.gstatic.com/s/silkscreen/v6/m8JXjfVPf62XiF7kO-i9YL1la0GA1dOkDw.woff2) format('woff2');unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C4,U+2113,U+2C60-2C7F,U+A720-A7FF}@font-face{font-family:'VF Silkscreen';font-style:normal;font-weight:400;font-display:swap;src:url(https://fonts.gstatic.com/s/silkscreen/v6/m8JXjfVPf62XiF7kO-i9YLNla0GA1dM.woff2) format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}";

  /* Promo end: Saturday 12 December 2026, 20:00 in Warsaw. The party question stays until 23:00 that evening. */
  var PROMO_END = Date.UTC(2026, 11, 12, 19, 0, 0);
  var PARTY_END = Date.UTC(2026, 11, 12, 22, 0, 0);

  var CONTEST_Q = "What's your dream activity with the VOYAFORM community?";
  var CONTEST_HELP = "Tell us what you'd love to do together with us and the people you meet at the studio. Answer it to enter our Red Envelope Contest: our jury picks the 10 answers they love most, and the winners are revealed at our birthday party on 12 Dec.";
  var CONTEST_PH = "Ex: a Pilates retreat by the sea, a matcha workshop, a picnic...";
  var PARTY_Q = "We're hosting a big 3rd birthday party on the evening of 12.12. Do you think you'll join us? 🤭";
  var PARTY_OPTS = ["YESSS!! Putting it in my calendar now!", "Omg I'll try my best!", "Omg I wish, but I can't make that date :("];
  var NEWS_LABEL = "Send me VOYANEWS 💌 (max 2 emails a month with current promos and news from our studio!)";

  var CSS = [
    ":host{display:block;width:100%}",
    ":host([hidden]){display:none}",
    ".voya-mount{all:initial;direction:ltr;unicode-bidi:isolate;display:block;-webkit-text-size-adjust:100%;text-size-adjust:100%;--bg:#050507;--bg2:#0E0E12;--card:#17161D;--line:#2A2933;--line2:#45444F;--tx:#FFFFFF;--tx2:#D6D3DE;--tx4:#A9A6B4;--p:#DB4D8F;--g:#03FF7E;--gd:#03150B;--bl:#ADDDF6;--red:#D7263D}",
    "*{box-sizing:border-box}",
    ".vf{position:relative;background:var(--bg);color:var(--tx);font-family:'VF Poppins',system-ui,-apple-system,sans-serif;font-size:16px;line-height:1.5;overflow:hidden;padding:clamp(28px,5vw,64px) clamp(16px,4vw,64px) clamp(36px,5vw,72px)}",
    ".vf:before{content:'';position:absolute;left:50%;top:-180px;width:min(900px,120%);height:360px;transform:translateX(-50%);background:radial-gradient(closest-side,rgba(219,77,143,.22),rgba(219,77,143,0));pointer-events:none}",
    ".vf:after{content:'';position:absolute;right:-140px;bottom:-160px;width:420px;height:420px;background:radial-gradient(closest-side,rgba(3,255,126,.10),rgba(3,255,126,0));pointer-events:none}",
    ".wrap{position:relative;z-index:1;max-width:880px;margin:0 auto}",
    ".vf a{color:var(--tx)}",
    ".vf a:hover{color:var(--g)}",
    ".vf a:focus-visible,.vf button:focus-visible,.vf input:focus-visible,.vf textarea:focus-visible{outline:3px solid var(--g);outline-offset:3px;border-radius:8px}",
    ".eye{font-family:'VF Silkscreen',monospace;font-size:13px;letter-spacing:.5px;color:var(--g);text-transform:uppercase;text-align:center}",
    ".h2{margin:8px 0 0;font-family:'VF Anton',sans-serif;font-weight:400;font-size:clamp(30px,5vw,52px);line-height:1;text-transform:uppercase;text-align:center;text-wrap:balance}",
    ".prev{display:inline-block;margin:0 auto 14px;padding:3px 10px;border:1px dashed var(--bl);border-radius:999px;font-family:'VF Silkscreen',monospace;font-size:11px;color:var(--bl)}",
    ".center{text-align:center}",
    ".steps{list-style:none;margin:26px 0 0;padding:0;display:grid;grid-template-columns:repeat(3,1fr);gap:14px}",
    ".step{position:relative;background:var(--card);border:1px solid var(--line);border-radius:18px;padding:18px 18px 20px}",
    ".step .n{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:999px;background:var(--g);color:var(--gd);font-family:'VF Anton',sans-serif;font-size:17px}",
    ".step h3{margin:12px 0 4px;font-size:17px;line-height:1.3;font-weight:700}",
    ".step p{margin:0;font-size:14.5px;color:var(--tx2)}",
    ".step a{display:inline-block;margin-top:8px;font-size:14px;font-weight:600;color:var(--bl);text-decoration:underline;text-underline-offset:3px}",
    ".cta{margin:26px 0 0;text-align:center}",
    ".pill{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:60px;padding:8px 34px;border-radius:999px;font-weight:700;font-size:18px;line-height:1.2;text-decoration:none;text-align:center;border:0;cursor:pointer;transition:transform .15s ease;font-family:inherit}",
    ".pill:hover{transform:translate(-1px,-1px)}",
    ".pill.pk{background:var(--p);color:#FFFFFF!important;box-shadow:4px 4px 0 var(--g)}",
    ".pill.ghost{min-height:48px;padding:6px 24px;font-size:15px;background:transparent;color:#FFFFFF!important;border:1px solid var(--line2)}",
    ".pill.ghost:hover{border-color:var(--g)}",
    ".pill[disabled]{opacity:.6;cursor:default;transform:none}",
    ".card{margin:34px 0 0;background:var(--bg2);border:1px solid var(--line);border-radius:22px;padding:clamp(18px,3vw,30px)}",
    ".card .eye{text-align:left}",
    ".card h3{margin:6px 0 0;font-family:'VF Anton',sans-serif;font-weight:400;font-size:clamp(24px,3.4vw,34px);line-height:1.05;text-transform:uppercase}",
    ".card .sub{margin:6px 0 0;font-size:14.5px;color:var(--tx4)}",
    ".q{margin:22px 0 0;padding:0;min-width:0}",
    ".q+.q{padding-top:22px;border-top:1px solid var(--line)}",
    ".q .lab{display:block;padding:0;margin:0;font-weight:700;font-size:16px;line-height:1.35}",
    ".tag{display:inline-block;margin:0 0 8px;padding:3px 10px;border-radius:999px;background:var(--red);color:#fff;font-family:'VF Silkscreen',monospace;font-size:11px;letter-spacing:.4px;text-transform:uppercase}",
    ".help{margin:6px 0 0;font-size:14px;color:var(--tx4)}",
    "textarea{display:block;width:100%;margin:12px 0 0;min-height:104px;padding:12px 14px;border-radius:14px;border:1px solid var(--line2);background:#0A0A0E;color:#fff;font-family:inherit;font-size:16px;line-height:1.45;resize:vertical}",
    "textarea::placeholder{color:#8E8B99}",
    ".opts{margin:12px 0 0;display:grid;gap:8px}",
    ".opt{display:flex;align-items:flex-start;gap:10px;padding:11px 14px;border:1px solid var(--line2);border-radius:14px;cursor:pointer;font-size:15px;line-height:1.35;background:#0A0A0E}",
    ".opt:hover{border-color:var(--g)}",
    ".opt input{flex:0 0 auto;width:20px;height:20px;margin:1px 0 0;accent-color:#DB4D8F}",
    ".news{border-style:dashed}",
    ".send{margin:22px 0 0;display:flex;flex-wrap:wrap;align-items:center;gap:12px}",
    ".msg{font-size:14px;color:var(--tx4)}",
    ".msg.bad{color:#FF8FA3}",
    ".done{margin:0;text-align:center;padding:10px 0}",
    ".done .big{font-family:'VF Anton',sans-serif;font-size:clamp(24px,3.4vw,34px);line-height:1.1;text-transform:uppercase}",
    ".done p{margin:8px 0 0;color:var(--tx2);font-size:15px}",
    ".friend{margin:28px 0 0;text-align:center;font-size:15px;color:var(--tx4)}",
    ".friend a{color:var(--tx2);font-weight:600;text-decoration:underline;text-underline-offset:3px}",
    ".sign{margin:26px 0 0;text-align:center}",
    ".sign .hand{font-family:'VF Caveat',cursive;font-weight:700;font-size:clamp(30px,4.4vw,40px);line-height:1;color:#fff}",
    ".sign .who{margin-top:4px;font-size:14px;color:var(--tx4)}",
    "@media (max-width:640px){.steps{grid-template-columns:1fr;gap:10px}.step{display:grid;grid-template-columns:30px 1fr;column-gap:12px;padding:14px 14px 16px}.step h3{margin:3px 0 4px}.step .body{min-width:0}.pill.pk{width:100%;padding:8px 18px}.send .pill{width:100%}}",
    "@media (max-width:350px){.vf{padding-left:12px;padding-right:12px}.pill{font-size:16px}.opt{font-size:14px;padding:10px 12px}.q .lab{font-size:15px}}"
  ].join("\n");

  function ensureFonts() {
    try {
      if (document.getElementById('voyaform-home-fonts')) { return; }
      var st = document.createElement('style');
      st.id = 'voyaform-home-fonts';
      st.textContent = FONT_CSS;
      (document.head || document.documentElement).appendChild(st);
      var hd = document.head || document.documentElement;
      var pc = document.createElement('link'); pc.rel = 'preconnect'; pc.href = 'https://fonts.gstatic.com'; pc.crossOrigin = 'anonymous'; hd.appendChild(pc);
    } catch (e) {}
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function parse(s) { try { var o = JSON.parse(s || ''); return (o && typeof o === 'object') ? o : null; } catch (e) { return null; } }
  function sentKey(id) { return 'vfThanksSent:' + id; }

  class VoyaformThanks extends HTMLElement {
    static get observedAttributes() { return ['order', 'form-result']; }
    constructor() {
      super();
      this._root = this.attachShadow({ mode: 'open' });
      this._built = false;
      this._order = null;
      this._pending = '';
    }
    connectedCallback() {
      var me = this;
      ensureFonts();
      try { this.setAttribute('lang', 'en'); this.setAttribute('translate', 'no'); this.classList.add('notranslate'); } catch (e) {}
      if (!this._built) {
        this._built = true;
        var st = document.createElement('style'); st.textContent = CSS; this._root.appendChild(st);
        this._mount = document.createElement('div'); this._mount.className = 'voya-mount'; this._root.appendChild(this._mount);
        this._root.addEventListener('click', function (e) { me._onClick(e); });
        this._root.addEventListener('submit', function (e) { e.preventDefault(); me._send(); });
      }
      if (window.ResizeObserver && !this._ro) { this._ro = new ResizeObserver(function () { me._syncHeight(); }); this._ro.observe(this._mount); }
      this._order = parse(this.getAttribute('order'));
      this._render();
    }
    disconnectedCallback() {
      if (this._ro) { try { this._ro.disconnect(); } catch (e) {} this._ro = null; }
      if (this._timer) { window.clearTimeout(this._timer); this._timer = null; }
    }
    attributeChangedCallback(name, oldV, newV) {
      if (!this._built) { return; }
      if (name === 'order') { this._order = parse(newV); this._render(); }
      if (name === 'form-result') { this._result(parse(newV)); }
    }
    _render() {
      var o = this._order;
      if (!this._mount) { return; }
      if (!o || !o.hasPass) { this._mount.innerHTML = ''; this._syncHeight(); return; }
      var now = Date.now();
      var showContest = !!o.promo && now < PROMO_END;
      var showParty = now < PARTY_END;
      var id = String(o.orderId || '');
      var already = false;
      try { already = !!(id && !o.preview && window.localStorage.getItem(sentKey(id))); } catch (e) {}
      var h = '';
      h += '<div class="vf"><div class="wrap">';
      if (o.preview) { h += '<div class="center"><span class="prev">Preview · nothing is saved</span></div>'; }
      h += '<div class="eye">What’s next</div>';
      h += '<h2 class="h2">Three steps to the reformer</h2>';
      h += '<ol class="steps">';
      h += '<li class="step"><span class="n">1</span><div class="body"><h3>Book your class</h3><p>Every class uses one credit from your pass. Pick your times in the Schedule.</p></div></li>';
      h += '<li class="step"><span class="n">2</span><div class="body"><h3>Find us</h3><p>Noakowskiego 12/56, central Warsaw, by Metro Politechnika.</p><a target="_top" href="/contact">See our location</a></div></li>';
      h += '<li class="step"><span class="n">3</span><div class="body"><h3>What to bring</h3><p>Comfy workout clothes and socks, we train without shoes. Come about 5 minutes before class.</p></div></li>';
      h += '</ol>';
      h += '<div class="cta"><a class="pill pk" target="_top" href="/schedule">Book my first class</a></div>';

      h += '<div class="card" id="card">';
      if (already) {
        h += this._doneHtml(false);
      } else {
        h += '<form id="f" novalidate>';
        h += '<div class="eye">Before you go</div>';
        h += '<h3>' + (showContest || showParty ? 'A few quick things' : 'One quick thing') + '</h3>';
        h += '<p class="sub">All optional. It takes a minute.</p>';
        if (showContest) {
          h += '<div class="q"><span class="tag">🧧 Red Envelope Contest</span>';
          h += '<label class="lab" for="contest">' + esc(CONTEST_Q) + ' ✨</label>';
          h += '<p class="help">' + esc(CONTEST_HELP) + ' <a target="_top" href="/promos#contest">Read more</a></p>';
          h += '<textarea id="contest" name="contest" maxlength="1500" placeholder="' + esc(CONTEST_PH) + '"></textarea></div>';
        }
        if (showParty) {
          h += '<div class="q" role="radiogroup" aria-labelledby="partyq"><span class="lab" id="partyq">' + esc(PARTY_Q) + '</span><div class="opts">';
          for (var i = 0; i < PARTY_OPTS.length; i++) {
            h += '<label class="opt"><input type="radio" name="party" value="' + esc(PARTY_OPTS[i]) + '"><span>' + esc(PARTY_OPTS[i]) + '</span></label>';
          }
          h += '</div></div>';
        }
        h += '<div class="q"><label class="opt news"><input type="checkbox" id="news" name="news"><span>' + esc(NEWS_LABEL) + '</span></label></div>';
        h += '<div class="send"><button type="submit" class="pill ghost" id="send">Send my answers</button><span class="msg" id="msg" role="status" aria-live="polite"></span></div>';
        h += '</form>';
      }
      h += '</div>';

      h += '<p class="friend">Bring a friend, you both get 10% off. <a target="_top" href="/refer-friends">Get your link</a></p>';
      h += '<div class="sign"><div class="hand">See you on the reformer ✦</div><div class="who">Maria &amp; Barto</div></div>';
      h += '</div></div>';
      this._mount.innerHTML = h;
      this._syncHeight();
    }
    _doneHtml(contest) {
      var h = '<div class="done"><div class="big">Got it, thank you 💖</div>';
      if (contest) { h += '<p>You’re in the Red Envelope Contest 🧧 Winners are revealed at our birthday party on 12 Dec.</p>'; }
      else { h += '<p>Your answers are with us.</p>'; }
      return h + '</div>';
    }
    _onClick(e) {
      var msg = this._root.getElementById('msg');
      if (msg && e.target && e.target.closest && e.target.closest('input,textarea')) { msg.textContent = ''; msg.className = 'msg'; }
    }
    _send() {
      var o = this._order || {};
      var f = this._root.getElementById('f'); if (!f || this._pending) { return; }
      var ta = this._root.getElementById('contest');
      var contest = ta ? String(ta.value || '').trim() : '';
      var pr = f.querySelector('input[name="party"]:checked');
      var party = pr ? pr.value : '';
      var nb = this._root.getElementById('news');
      var news = !!(nb && nb.checked);
      var msg = this._root.getElementById('msg');
      if (!contest && !party && !news) { if (msg) { msg.textContent = 'Nothing to send yet. Pick or write something first.'; msg.className = 'msg bad'; } return; }
      var id = 'ty-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      this._pending = id; this._hadContest = !!contest;
      var btn = this._root.getElementById('send'); if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
      if (msg) { msg.textContent = ''; msg.className = 'msg'; }
      var me = this;
      /* if the page never answers, let the person try again */
      this._timer = window.setTimeout(function () { if (me._pending === id) { me._result({ id: id, ok: false }); } }, 15000);
      try {
        this.dispatchEvent(new CustomEvent('voya-thanks', { detail: { id: id, orderId: String(o.orderId || ''), contest: contest, party: party, voyanews: news, newsLabel: news ? NEWS_LABEL : '', at: new Date().toISOString() } }));
      } catch (err) { this._result({ id: id, ok: false }); }
    }
    _result(r) {
      if (!r || !this._pending || r.id !== this._pending) { return; }
      this._pending = '';
      if (this._timer) { window.clearTimeout(this._timer); this._timer = null; }
      var o = this._order || {};
      if (r.ok) {
        try { if (o.orderId && !o.preview) { window.localStorage.setItem(sentKey(String(o.orderId)), '1'); } } catch (e) {}
        var card = this._root.getElementById('card');
        if (card) { card.innerHTML = this._doneHtml(this._hadContest); }
      } else {
        var btn = this._root.getElementById('send'); if (btn) { btn.disabled = false; btn.textContent = 'Send my answers'; }
        var msg = this._root.getElementById('msg');
        if (msg) { msg.textContent = 'That didn’t go through. Try again, or write to hello@voyaform.com.'; msg.className = 'msg bad'; }
      }
      this._syncHeight();
    }
    /* The block grows and shrinks with its content. If the host page gave the element, or a wrapper that holds nothing else, a fixed height, keep that height equal to the content. */
    _syncHeight() {
      if (!this._mount) { return; }
      var h = Math.ceil(this._mount.getBoundingClientRect().height);
      if (!h && this._order && this._order.hasPass) { return; }
      try {
        if (this._ownH || Math.abs(this.getBoundingClientRect().height - h) > 1) { this._ownH = true; this.style.height = h + 'px'; this.style.minHeight = h + 'px'; }
        var p = this.parentElement, n = 0;
        while (p && n < 3 && p !== document.body && p !== document.documentElement && p.children.length === 1) {
          if (p.__voyaH || Math.abs(p.getBoundingClientRect().height - h) > 1) { p.__voyaH = true; p.style.height = h + 'px'; p.style.minHeight = h + 'px'; }
          p = p.parentElement; n++;
        }
      } catch (e) {}
      if (h === this._h) { return; }
      this._h = h;
      try { this.dispatchEvent(new CustomEvent('voya-height', { detail: { height: h } })); } catch (e) {}
    }
  }
  window.customElements.define(TAG, VoyaformThanks);
})();
