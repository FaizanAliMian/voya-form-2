// Page code for the Wix "Thank You Page" (the screen after every paid order, from Pricing and from Schedule).
// It shows the <voyaform-thanks> block under the Wix confirmation, only when the order holds a pass:
// next steps, the Red Envelope contest question (promo passes only), the 12.12 party question and the VOYANEWS opt-in.
// Answers are saved to the CMS collection HomepageRequests with form = "thank-you".
// Build: 2026-11-24. Goes together with public/custom-elements/voyaform-thanks.js.
// Preview without an order: add ?vfpreview=promo or ?vfpreview=pass to the page address (nothing is saved).
import wixData from 'wix-data';
import wixLocationFrontend from 'wix-location-frontend';

const ELEMENT_ID = '#voyaThanks';          // the custom element
const SECTION_ID = '#sectionVoyaThanks';   // its section, collapsed on load
const WIDGET_ID = '#thankYouPage1';        // the Wix Thank You Page widget
const COLLECTION = 'HomepageRequests';
const PLANS_APP = '1522827f-c56c-a5c9-2ac9-00f9e6ae12d3'; // Wix Pricing Plans

// The 14 public passes. promo = takes part in the Red Envelope Contest.
const PLANS = {
  'beebefd9-25e1-413e-9fa6-b8da838778ef': { name: 'New Member Promo (2 classes)', promo: true },
  '9ea625a1-4476-41a6-a9ec-e87f4834c171': { name: 'New Member Promo with MultiSport (2 classes)', promo: true },
  '0ef8ca91-fd8c-4007-a810-016e6710b497': { name: 'VOYACOLD 2026 - 10 classes', promo: true },
  'ede649c4-4e15-44b6-95d3-f154c46e7a34': { name: 'VOYACOLD 2026 with MultiSport - 10 classes', promo: true },
  '2799e6df-c983-4aec-8a94-59b14197ab6f': { name: 'VOYACOLD MAX - 16 classes', promo: true },
  '9dff1a0c-cf3f-4a04-bb5d-63232fa9ec46': { name: 'VOYACOLD MAX with MultiSport - 16 classes', promo: true },
  'f5d4341d-4168-4fdb-8acd-a3dd10f95641': { name: 'One Class', promo: false },
  '9e7b1493-0e59-413d-ab8d-e20636ae124d': { name: 'One class with MultiSport/Medicover', promo: false },
  'de1c3e83-7825-4640-8582-63ed57077191': { name: 'VOYABASE - 4 classes', promo: false },
  '53ad4fd6-fe5a-45f5-aeae-30ab8bf09c6d': { name: '4 classes with MultiSport/Medicover', promo: false },
  'fc919563-982e-4876-bcc9-af6140351493': { name: 'VOYAGOLD - 8 classes', promo: false },
  'ba158935-cdf1-40f6-8857-dc8322d16152': { name: '8 classes with MultiSport/Medicover', promo: false },
  '1b521517-98f6-4823-86fd-cb4d7ecfa7e1': { name: 'VOYASTAR - 12 classes', promo: false },
  'f67a5ce7-5a80-406e-9026-907c3bbad1ea': { name: '12 classes with Multisport/Medicover', promo: false }
};

function itemName(li) {
  if (!li) { return ''; }
  if (typeof li.name === 'string') { return li.name; }
  const pn = li.productName || li.name || {};
  return String(pn.original || pn.translated || '');
}

function readOrder(order) {
  if (!order) { return null; }
  let raw = '';
  try { raw = JSON.stringify(order); } catch (e) { raw = ''; }
  const ids = Object.keys(PLANS).filter((id) => raw.indexOf(id) >= 0);
  const items = Array.isArray(order.lineItems) ? order.lineItems : [];
  const names = items.map(itemName).filter(Boolean);
  if (!ids.length) {
    Object.keys(PLANS).forEach((id) => { if (names.some((n) => n.trim() === PLANS[id].name)) { ids.push(id); } });
  }
  const otherPass = !ids.length && raw.indexOf(PLANS_APP) >= 0;
  const buyer = order.buyerInfo || {};
  const bill = (order.billingInfo && (order.billingInfo.contactDetails || order.billingInfo)) || {};
  return {
    hasPass: ids.length > 0 || otherPass,
    promo: ids.some((id) => PLANS[id].promo),
    planIds: ids,
    plans: ids.length ? ids.map((id) => PLANS[id].name) : names,
    orderId: String(order._id || order.id || ''),
    number: String(order.number || ''),
    name: String(buyer.firstName || bill.firstName || ''),
    lastName: String(buyer.lastName || bill.lastName || ''),
    email: String(buyer.email || bill.email || ''),
    preview: false
  };
}

$w.onReady(async function () {
  let el;
  try { el = $w(ELEMENT_ID); } catch (e) { return; }
  let info = null;
  const pv = (wixLocationFrontend.query && wixLocationFrontend.query.vfpreview) || '';
  if (pv) {
    info = { hasPass: true, promo: pv === 'promo', planIds: [], plans: ['Preview'], orderId: 'preview', number: '', name: '', lastName: '', email: '', preview: true };
    // no order in preview, so the empty Wix confirmation is folded away and the block shows at the top
    try { await $w('#section1').collapse(); } catch (e) {}
  } else {
    try { info = readOrder(await $w(WIDGET_ID).getOrder()); } catch (e) { info = null; }
  }
  if (!info || !info.hasPass) { return; }

  el.on('voya-thanks', async (event) => {
    const d = (event && event.detail) || {};
    let ok = false;
    if (info.preview) {
      ok = true;
    } else {
      try {
        const who = [info.name, info.lastName].filter(Boolean).join(' ');
        await wixData.insert(COLLECTION, {
          title: ['thank-you', info.email || who || info.orderId].filter(Boolean).join(' · '),
          form: 'thank-you',
          email: info.email,
          phone: '',
          contact: who,
          when: d.party || '',
          message: d.contest || '',
          page: info.plans.join(', '),
          sentAt: d.at || new Date().toISOString(),
          requestId: d.id || '',
          orderId: info.orderId,
          orderNumber: info.number,
          promoPass: info.promo,
          contestAnswer: d.contest || '',
          partyAnswer: d.party || '',
          voyanews: !!d.voyanews,
          voyanewsConsentText: d.voyanews ? (d.newsLabel || '') : ''
        });
        ok = true;
      } catch (err) {
        console.error('Thank-you answers were not saved', err);
      }
    }
    el.setAttribute('form-result', JSON.stringify({ id: d.id, ok: ok }));
  });

  el.setAttribute('order', JSON.stringify({ hasPass: true, promo: info.promo, plans: info.plans, orderId: info.orderId, name: info.name, preview: info.preview }));
  try { await $w(SECTION_ID).expand(); } catch (e) {}
});
