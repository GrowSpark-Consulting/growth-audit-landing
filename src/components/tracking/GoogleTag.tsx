import { CONSENT_CHANGE_EVENT, CONSENT_COOKIE } from "@/lib/consent";

const GOOGLE_TAG_ID = "G-QJH61735YG";

/**
 * Google tag (gtag.js), server-rendered into <head> so Search Console can verify it in the raw HTML.
 * Consent Mode v2 defaults to denied and follows the existing gs_consent cookie and banner choice.
 * page_location omits the query string, so /thank-you's txnid and token never reach Google.
 */
const INIT_SCRIPT = `window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('consent', 'default', { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', analytics_storage: 'denied' });
(function () {
  function consent(state) {
    return { ad_storage: state, ad_user_data: state, ad_personalization: state, analytics_storage: state };
  }
  var cookies = document.cookie.split(';');
  for (var i = 0; i < cookies.length; i++) {
    if (cookies[i].trim() === ${JSON.stringify(`${CONSENT_COOKIE}=granted`)}) gtag('consent', 'update', consent('granted'));
  }
  window.addEventListener(${JSON.stringify(CONSENT_CHANGE_EVENT)}, function (event) {
    if (event.detail === 'granted' || event.detail === 'denied') gtag('consent', 'update', consent(event.detail));
  });
})();
gtag('config', ${JSON.stringify(GOOGLE_TAG_ID)}, { page_location: window.location.origin + window.location.pathname, page_referrer: document.referrer.split('?')[0] });`;

export function GoogleTag() {
  return (
    <>
      <script async src={`https://www.googletagmanager.com/gtag/js?id=${GOOGLE_TAG_ID}`} />
      <script dangerouslySetInnerHTML={{ __html: INIT_SCRIPT }} />
    </>
  );
}
