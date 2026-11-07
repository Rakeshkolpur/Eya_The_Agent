import { describe, expect, it } from 'vitest';
import { signInFields, signInState } from '../src/main/browser/signInState';
import { currentPageData } from '../src/main/tools/impl/browserTools';

/**
 * 6 Nov 2026: Flipkart and Swiggy were both signed in in the person's own Chrome, and Eya said "the page is ready for you to sign in" and "I can't access Swiggy without your login
 * credentials". The only sign-in check was a visible PASSWORD box — these sites sign in by phone number and one-time code, so Eya was told nothing either way. The shapes below are the
 * ones the real signed-out pages show (read from the public pages: a header "Login" link and a phone-number box with Continue on Flipkart; a "Sign in" link on Swiggy).
 */

const page = (url: string, more: Partial<Parameters<typeof signInState>[0]> = {}): Parameters<typeof signInState>[0] => ({ url, links: [], buttons: [], inputs: [], headings: [], dialogs: [], ...more });
const filler = ['Mobiles', 'Fashion', 'Electronics', 'Home', 'Appliances', 'Travel', 'Offers', 'Cart'];

describe('signed OUT: a way in is on the page', () => {
  it('Flipkart as it really is when nobody is signed in: a Login link in the header, and the phone-number box with Continue', () => {
    const r = signInState(page('https://www.flipkart.com/', { links: ['Login', 'Login', 'More', 'Cart', ...filler], inputs: ['Phone Number', 'Search for Products, Brands and More'], buttons: ['Continue'], dialogs: ['Login Get access to your Orders, Wishlist and Recommendations Phone Number Continue'] }));
    expect(r.answer).toBe('no');
    expect(r.evidence.join(' ')).toMatch(/Login/);
  });

  it('Swiggy as it really is: a "Sign in" link', () => {
    expect(signInState(page('https://www.swiggy.com/', { links: ['Swiggy', 'Offers', 'Swiggy Corporate', 'Partner with us', 'Get the App', 'Sign in'], inputs: ['Enter your delivery location'] })).answer).toBe('no');
  });

  it('the usual ways a site words it: Sign In, Log in / Sign up, Login or Signup, Hello, sign in (Amazon)', () => {
    for (const control of ['Sign In', 'Log in', 'Login / Sign Up', 'Login or Signup', 'Sign in or create account', 'Hello, sign in Account & Lists', 'LOGIN']) {
      expect(signInState(page('https://example.com/', { buttons: [control, 'Home', 'About'] })).answer, control).toBe('no');
    }
  });

  it('Flipkart lists "My Profile / Orders / Wishlist" under its Login button even when nobody is signed in: those prove nothing, the Login button decides', () => {
    const r = signInState(page('https://www.flipkart.com/', { links: ['Login', 'More', 'Cart', ...filler], collapsedMenus: { Login: ['My Profile', 'Flipkart Plus Zone', 'Orders', 'Wishlist', 'Coupons', 'Gift Cards'] } }));
    expect(r.answer).toBe('no');
  });

  it('a password box, or a verification-code step of the sign-in, is a sign-in in progress', () => {
    expect(signInState(page('https://example.com/account', { challenge: { kind: 'login', hint: 'x' } })).answer).toBe('no');
    expect(signInState(page('https://example.com/verify', { challenge: { kind: 'mfa', hint: 'x' } })).answer).toBe('no');
  });

  it('a sign-in form that is not in the header: a phone or email box with a Login / Request OTP button, on a page about signing in', () => {
    const r = signInState(page('https://example.com/checkout', { inputs: ['Enter Email/Mobile number'], buttons: ['Request OTP', 'Cancel'], headings: ['Login or Signup'] }));
    expect(r.answer).toBe('no');
    expect(r.evidence.join(' ')).toMatch(/sign-in form/);
  });
});

describe('signed IN: a way out is on the page, or the page says so', () => {
  it('a Logout / Sign out control — in the page, or in the account menu that is closed until hovered — is the surest sign', () => {
    expect(signInState(page('https://www.flipkart.com/', { links: ['More', 'Cart', 'Rakesh', ...filler], collapsedMenus: { Rakesh: ['My Profile', 'Orders', 'Wishlist', 'Logout'] } })).answer).toBe('yes');
    expect(signInState(page('https://www.swiggy.com/', { buttons: ['Sign Out'] })).answer).toBe('yes');
    for (const out of ['Log out', 'Logout', 'Sign out', 'log off']) expect(signInState(page('https://example.com/', { links: [out] })).answer, out).toBe('yes');
  });

  it('a greeting by name in the header is likely (Amazon: "Hello, Rakesh Account & Lists" is signed in; "Hello, sign in" is not)', () => {
    const r = signInState(page('https://www.amazon.in/', { links: ['Hello, Rakesh', 'Returns & Orders', 'Cart'] }));
    expect(r.answer).toBe('likely');
    expect(signInState(page('https://www.amazon.in/', { links: ['Hello, sign in', 'Returns & Orders', 'Cart'] })).answer).toBe('no');
    for (const notAName of ['Hello there', 'Hello, guest', 'Welcome back', 'Hi there']) expect(signInState(page('https://example.com/', { links: [notAName] })).answer, notAName).toBe('unknown');
  });

  it('a shop, food or travel site with its whole header and NO Login button (they show one when nobody is signed in) is likely signed in', () => {
    for (const url of ['https://www.flipkart.com/', 'https://www.swiggy.com/', 'https://www.zomato.com/', 'https://www.amazon.in/', 'https://in.bookmyshow.com/', 'https://www.myntra.com/']) {
      const r = signInState(page(url, { links: ['Cart', 'Rakesh', ...filler], inputs: ['Search'] }));
      expect(r.answer, url).toBe('likely');
      expect(r.evidence.join(' ')).toMatch(/no Login button/);
    }
  });

  it('but not on a page that has hardly started to show (a header with a few items), nor on a site that is not one of those', () => {
    expect(signInState(page('https://www.flipkart.com/', { links: ['Cart'] })).answer).toBe('unknown');
    expect(signInState(page('https://www.example.com/', { links: ['Cart', 'Rakesh', ...filler] })).answer).toBe('unknown');
  });
});

describe('things that look like a sign-in and are not', () => {
  it('the checkout of a signed-in person still has a "LOGIN" step (completed, with a Change button): a heading alone is not a sign-in form', () => {
    const r = signInState(page('https://www.flipkart.com/viewcart', { headings: ['LOGIN', 'DELIVERY ADDRESS', 'ORDER SUMMARY'], links: ['Cart', ...filler], buttons: ['CHANGE', 'PLACE ORDER'] }));
    expect(r.answer).toBe('likely');
  });

  it('an address form asks for a mobile number too — with a Save button it is not a sign-in', () => {
    const r = signInState(page('https://www.example.com/address', { inputs: ['10-digit mobile number', 'Pincode'], buttons: ['Save Address'], headings: ['Add a new address'] }));
    expect(r.answer).toBe('unknown');
  });

  it('a long product title that happens to start with the word is not a Login control, and a button\'s item is not part of its name', () => {
    expect(signInState(page('https://example.com/', { links: ['Login Kit for beginners: a complete guide'], buttons: ['ADD — Login Kit'] })).answer).toBe('unknown');
  });

  it('a page that has nothing to do with accounts says nothing — and nothing is added to what the model sees', () => {
    expect(signInState(page('https://www.google.com/search?q=poco', { links: ['Images', 'Maps'], buttons: ['Search'] })).answer).toBe('unknown');
    expect(signInFields(page('https://www.google.com/', { links: ['Images'] }))).toEqual({});
  });

  it('a Logout control wins over everything else on the page (a footer "login help" link does not make a signed-in page signed out)', () => {
    expect(signInState(page('https://example.com/', { links: ['Logout', 'Login help'], buttons: ['Sign in with another account'] })).answer).toBe('yes');
  });
});

describe('what the model is shown', () => {
  it('signedIn and the evidence, in words and never a name or a number', () => {
    const f = signInFields(page('https://www.swiggy.com/', { links: ['Sign in'] }));
    expect(f).toEqual({ signedIn: 'no', signInEvidence: ['a "sign in" control in the header'] });
    expect(JSON.stringify(signInFields(page('https://www.amazon.in/', { links: ['Hello, Rakesh'] })))).not.toMatch(/Rakesh/);
  });
});

describe('it reaches the model: every page result carries it', () => {
  const snapshot = (links: string[], url = 'https://www.swiggy.com/') => ({ url, title: 'Swiggy', headings: [], links, buttons: [], inputs: [], dialogs: [], truncated: false });

  it('the page data of a tool result says whether the person is signed in, from what the page showed', () => {
    const out = currentPageData('open', null, { stateChanged: true, navigated: true }, snapshot(['Sign in', 'Offers']));
    expect((out['currentPage'] as Record<string, unknown>)['signedIn']).toBe('no');
    const signedIn = currentPageData('open', null, { stateChanged: true, navigated: true }, snapshot(['Offers', 'Logout']));
    expect((signedIn['currentPage'] as Record<string, unknown>)['signedIn']).toBe('yes');
    expect((signedIn['currentPage'] as Record<string, unknown>)['signInEvidence']).toEqual(['a Logout / Sign out control is on the page (in the account menu)']);
  });

  it('and says nothing at all when the page shows nothing about accounts (no tokens spent on "unknown")', () => {
    const out = currentPageData('open', null, { stateChanged: true, navigated: true }, snapshot(['Images', 'Maps'], 'https://www.google.com/'));
    expect(Object.keys(out['currentPage'] as Record<string, unknown>)).not.toContain('signedIn');
  });
});
