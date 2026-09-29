/**
 * Android browsers where AR capture doesn't work and we should offer Chrome:
 *  - "samsung": Samsung Internet runs WebXR AR but never grants camera-access.
 *  - "naver" / "kakao": NAVER and KakaoTalk open links in an Android WebView (no WebXR).
 * Returns null elsewhere (including iOS, where Chrome can't help).
 */
export function detectNonChromeBrowser(ua = navigator.userAgent) {
  if (!/Android/i.test(ua)) return null;
  if (/NAVER\(inapp/i.test(ua)) return "naver";
  if (/KAKAOTALK/i.test(ua)) return "kakao";
  if (/SamsungBrowser\//.test(ua)) return "samsung";
  return null;
}

/** Android intent link that opens the current page in Chrome (Play Store if Chrome is missing). */
export function chromeIntentUrl(loc = location) {
  return (
    `intent://${loc.host}${loc.pathname}${loc.search}` +
    "#Intent;scheme=https;package=com.android.chrome;" +
    `S.browser_fallback_url=${encodeURIComponent("https://play.google.com/store/apps/details?id=com.android.chrome")};end`
  );
}
