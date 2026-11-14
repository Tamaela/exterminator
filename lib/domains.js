// Everything about hostnames and domain matching.

// The lowercase hostname of a web URL, or null for anything else.
export function hostOf(url) {
  try {
    let u = new URL(url);
    // blob:https://bank.com/… and filesystem:https://bank.com/… belong to that web origin.
    if (u.protocol === 'blob:' || u.protocol === 'filesystem:') u = new URL(u.pathname);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    // "mybank.com." is the same site as "mybank.com": strip the trailing dot,
    // otherwise it would bypass matching.
    return u.hostname.toLowerCase().replace(/\.+$/, '') || null;
  } catch {
    return null;
  }
}

// Turns input like "https://www.MyBank.com/personal" into "mybank.com".
// Internationalized domains ("bücher.de") are converted to punycode, like Chrome does.
export function normalizeDomain(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  s = s.split(/[/?#]/)[0].replace(/^\*\./, '');
  let host;
  try {
    host = new URL(`http://${s}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/\.+$/, '').replace(/^www\./, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  return host;
}

// The domain to suggest for a host: without "www.".
export function suggestDomain(host) {
  return host.replace(/^www\./, '');
}

// True when host is the domain itself or one of its subdomains.
function hostMatches(host, domain) {
  return host === domain || host.endsWith('.' + domain);
}

// The configured site that covers this host; the most specific one wins.
export function matchSite(host, sites) {
  if (!host) return null;
  let best = null;
  for (const site of sites) {
    if (hostMatches(host, site.domain) && (!best || site.domain.length > best.domain.length)) best = site;
  }
  return best;
}

// The first domain in the list that covers this host, or null.
export function findDomain(host, domains) {
  if (!host) return null;
  return (domains || []).find((domain) => hostMatches(host, domain)) || null;
}
