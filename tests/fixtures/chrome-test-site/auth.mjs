// A tiny site with a real cookie session, to test "use the browser the user is already signed in to":
//   /auth/account, /auth/statement, /auth/dashboard  — only for a browser that holds the session cookie
//                                                      (anyone else is sent to the sign-in page)
//   /auth/login    — GET: the sign-in form (username, password); POST: starts the session, goes to the account
//   /auth/quick-login — starts the session straight away (stands in for "the user signed in earlier")
//   /auth/logout   — ends it
// The cookie value is deliberately distinctive, so a test can prove it never reaches anything Eya reports.
export const SESSION_COOKIE_VALUE = 'SESSION-SECRET-9f3a71c2';

const hasSession = (req) => (req.headers.cookie ?? '').includes(`sid=${SESSION_COOKIE_VALUE}`);

function html(title, body) {
  return `<!doctype html><html><head><title>${title}</title></head><body><nav><a href="/auth/account">Account</a> <a href="/auth/dashboard">Dashboard</a> <a href="/auth/logout">Sign out</a></nav><main><h1>${title}</h1>${body}</main></body></html>`;
}

/** Returns true if it answered the request. */
export function handleAuth(req, res, url) {
  if (!url.pathname.startsWith('/auth/')) return false;
  const send = (status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
    res.end(body);
    return true;
  };
  const start = () => ({ 'set-cookie': `sid=${SESSION_COOKIE_VALUE}; Path=/; HttpOnly`, location: '/auth/account' });

  switch (url.pathname) {
    case '/auth/quick-login':
      return send(302, '', start());
    case '/auth/login':
      if (req.method === 'POST') {
        req.resume();
        return send(302, '', start());
      }
      return send(
        200,
        html(
          'Sign in',
          `<p>Please sign in to continue.</p>
           <form method="post" action="/auth/login">
             <label>Username <input name="u" type="text"></label>
             <label>Password <input name="p" type="password"></label>
             <button type="submit">Sign in</button>
           </form>`,
        ),
      );
    case '/auth/logout':
      return send(302, '', { 'set-cookie': 'sid=; Path=/; Max-Age=0', location: '/auth/login' });
    case '/auth/account':
      if (!hasSession(req)) return send(302, '', { location: '/auth/login' });
      return send(200, html('My account', '<p>Welcome back, Asha.</p><p><a href="/auth/statement">View statement</a> <a href="/auth/dashboard">Open dashboard</a></p>'));
    case '/auth/statement':
      if (!hasSession(req)) return send(302, '', { location: '/auth/login' });
      return send(200, html('Statement', '<p>Balance: 1,234 rupees.</p>'));
    case '/auth/dashboard':
      if (!hasSession(req)) return send(302, '', { location: '/auth/login' });
      return send(200, html('Dashboard', '<p>Dashboard for Asha.</p>'));
    default:
      return send(404, html('Not found', '<p>No such page.</p>'));
  }
}
