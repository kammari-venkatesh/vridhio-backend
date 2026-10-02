/** Prevents browsers and proxies from caching private (authenticated) responses. */
export const noStore = (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};
