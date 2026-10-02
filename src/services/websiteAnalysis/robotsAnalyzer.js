/**
 * Minimal robots.txt support (RFC 9309): user-agent groups, Allow/Disallow with `*` and
 * `$` wildcards (longest match wins, Allow wins ties) and Sitemap lines. Used to record
 * what robots.txt declares and to decide whether a sitemap URL may be requested.
 */

const MAX_LINES = 5000;
const MAX_SITEMAPS = 10;

/** robots.txt served as an HTML page (a "soft 404") is not a robots file. */
export const looksLikeHtml = (text) => /^\s*(<!doctype html|<html|<head|<body)/i.test(String(text ?? '').slice(0, 512));

export const parseRobotsTxt = (text) => {
  const groups = [];
  const sitemaps = [];
  let current = null;
  let lastWasAgent = false;

  for (const rawLine of String(text ?? '').split(/\r\n|\r|\n/).slice(0, MAX_LINES)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const match = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!match) continue;
    const field = match[1].toLowerCase();
    const value = match[2].trim();

    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (field === 'sitemap') {
      if (value && sitemaps.length < MAX_SITEMAPS) sitemaps.push(value);
    } else if ((field === 'allow' || field === 'disallow') && current) {
      current.rules.push({ allow: field === 'allow', path: value });
    }
  }
  return { groups, sitemaps };
};

const ruleToRegex = (path) => {
  const anchored = path.endsWith('$');
  const body = (anchored ? path.slice(0, -1) : path)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
};

/** Group for `agent` (a product token such as "vridhiositecheck"), falling back to "*". */
const groupsFor = (parsed, agent) => {
  const token = agent.toLowerCase();
  const specific = parsed.groups.filter((g) => g.agents.some((a) => a !== '*' && token.includes(a)));
  return specific.length > 0 ? specific : parsed.groups.filter((g) => g.agents.includes('*'));
};

/** True when robots.txt allows `agent` to request `path` (path + query). */
export const isPathAllowed = (parsed, agent, path) => {
  const rules = groupsFor(parsed, agent).flatMap((g) => g.rules).filter((r) => r.path !== '');
  let best = null;
  for (const rule of rules) {
    if (!ruleToRegex(rule.path).test(path)) continue;
    const length = rule.path.length;
    if (!best || length > best.length || (length === best.length && rule.allow)) best = { allow: rule.allow, length };
  }
  return best ? best.allow : true;
};
