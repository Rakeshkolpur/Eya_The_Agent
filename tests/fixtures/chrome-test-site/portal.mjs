// A "government portal" built the way a lot of real sites are, to reproduce what went wrong before:
//  - a long header menu repeated on every page, built from plain <div>s (no <nav>/<header>/<main> landmarks)
//  - a dropdown that only opens on mouse HOVER (pure CSS :hover — no script runs, so no event can open it)
//  - the options that matter sit well below that header in the page, several levels deep
// Pages are generated so every page carries the same big header.
const FILLER = Array.from({ length: 64 }, (_, i) => `<a href="/portal/dept.html?n=${i + 1}">Department ${i + 1}</a>`).join(' ');

const HEADER = `
<div class="site-header">
  <a href="/portal/">Home</a>
  <ul class="menu">
    <li class="has-sub"><a href="#">Services</a>
      <ul class="sub">
        <li><a href="/portal/causelist.html">Cause List</a></li>
        <li><a href="/portal/orders.html">Orders</a></li>
        <li><a href="/portal/status.html">Case Status</a></li>
      </ul></li>
    <li class="has-sub"><a href="#">About</a>
      <ul class="sub"><li><a href="/portal/history.html">History of the court</a></li><li><a href="/portal/judges.html">Our judges</a></li></ul></li>
  </ul>
  <div class="depts">${FILLER}</div>
</div>`;

const STYLE = `<style>
 .menu{list-style:none;display:flex;gap:16px;padding:0;margin:4px 0}
 .has-sub{position:relative}
 .sub{display:none;position:absolute;top:100%;left:0;background:#eee;padding:6px;list-style:none;margin:0;white-space:nowrap}
 .has-sub:hover .sub{display:block}
 .depts a{font-size:10px;margin-right:6px}
</style>`;

const OPTIONS = [
  ['Apply for certificate', '/portal/apply.html'],
  ['Track application', '/portal/track.html'],
  ['Download forms', '/portal/forms.html'],
  ['Pay property tax', '/portal/tax.html'],
  ['Book an appointment', '/portal/appointment.html'],
  ['Register a complaint', '/portal/complaint.html'],
  ['Find a service centre', '/portal/centres.html'],
  ['Citizen helpline', '/portal/helpline.html'],
];

function page(title, body) {
  return `<!doctype html><html><head><title>${title}</title>${STYLE}</head><body>${HEADER}
<div id="content"><h1>${title}</h1>${body}</div>
<div class="site-footer"><a href="/portal/privacy.html">Privacy policy</a> <a href="/portal/contact.html">Contact us</a></div>
</body></html>`;
}

const PAGES = {
  '/portal/': () =>
    page(
      'Welcome to the State Portal',
      `<p>Latest notices appear below.</p>
       <p><a href="/portal/citizen.html">Citizen Services</a> <a href="/portal/business.html">Business Services</a> <a href="/portal/notices.html">Latest notices</a></p>`,
    ),
  '/portal/citizen.html': () =>
    page('Citizen Services', `<p>Choose what you need:</p><ul>${OPTIONS.map(([n, h]) => `<li><a href="${h}">${n}</a></li>`).join('')}</ul>`),
  '/portal/forms.html': () =>
    page(
      'Download forms',
      `<p>Forms are available between 9:00 and 17:00 on working days.</p>
       <ul><li><a href="/portal/birth.html">Birth certificate form</a></li><li><a href="/portal/income.html">Income certificate form</a></li><li><a href="/report.txt">Download the combined guide</a></li></ul>`,
  ),
  '/portal/birth.html': () => page('Birth certificate form', '<p>Fill the form and submit it at your nearest centre. The fee is 50 rupees.</p>'),
  '/portal/causelist.html': () => page('Cause List', '<p>Select a date to view the list for that day.</p><label>Date <input name="d" placeholder="DD-MM-YYYY"></label>'),
};

/** Returns the generated HTML for a /portal/ path, or null if it is not one. */
export function renderPortal(pathname) {
  if (!pathname.startsWith('/portal')) return null;
  const known = PAGES[pathname === '/portal' ? '/portal/' : pathname];
  if (known) return known();
  const name = pathname.split('/').pop()?.replace('.html', '') ?? 'page';
  return page(name.charAt(0).toUpperCase() + name.slice(1), `<p>This is the ${name} page.</p>`);
}
