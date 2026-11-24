// Plan Customization page. Build: 2026-11-24 (v3).
// Every pass shows this screen: our own heading (#text34 = the question, #text35 = the small line
// under it) sits above the Wix start-date picker, and the buyer picks the day the pass starts.
// No pass skips this screen (Barto, 24 Nov 2026: the same rule for every pass).
// To send a pass straight to checkout again, add its plan ID to DIRECT_TO_CHECKOUT below.
// Such a pass must then have no start-date choice and no form, and it will not show the heading.
import wixLocationFrontend from 'wix-location-frontend';
import wixWindowFrontend from 'wix-window-frontend';
import { session } from 'wix-storage-frontend';
import { customPurchaseFlow } from 'wix-pricing-plans-frontend';

/** @type {string[]} */
const DIRECT_TO_CHECKOUT = [];
const GUARD_MS = 10 * 60 * 1000; // coming back with "Back" within 10 minutes shows this page normally

$w.onReady(function () {
    const planId = wixLocationFrontend.query.planId;
    const direct = Boolean(planId) && DIRECT_TO_CHECKOUT.includes(planId);

    if (direct) {
        // No start date on such a pass, so the question about the start date would make no sense.
        try {
            $w('#text34').collapse();
            $w('#text35').collapse();
        } catch (err) {
            console.error('Start-date heading not hidden', err);
        }
    }

    if (wixWindowFrontend.rendering.env !== 'browser') { return; }
    try {
        if (!direct) { return; }
        const key = 'vf-direct-' + planId;
        const last = Number(session.getItem(key) || 0);
        if (Date.now() - last < GUARD_MS) { return; }
        session.setItem(key, String(Date.now()));
        customPurchaseFlow.navigateToCheckout({ planId: planId });
    } catch (err) {
        console.error('Direct-to-checkout skipped', err);
    }
});
