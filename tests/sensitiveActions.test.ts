import { describe, it, expect } from 'vitest';
import { sensitiveActionReason, sensitiveSubmitReason } from '../src/main/browser/sensitiveActions';
import type { PageContext } from '../src/main/browser/sensitiveActions';

const checkout: PageContext = { url: 'https://shop.example/checkout', title: 'Checkout', headings: ['Order summary'] };
const news: PageContext = { url: 'https://news.example/story', title: 'City council votes', headings: ['City council votes'] };
const search: PageContext = { url: 'https://example.com/search?q=x', title: 'Search results', headings: ['Results'] };
const application: PageContext = { url: 'https://gov.example/apply', title: 'Passport application form', headings: ['Application'] };

describe('sensitiveActionReason: clicks that need the user\'s yes first', () => {
  it.each([
    ['Buy now', 'purchase'],
    ['Place your order', 'purchase'],
    ['Place order', 'purchase'],
    ['Pay now', 'purchase'],
    ['Pay ₹499', 'purchase'],
    ['Confirm payment', 'purchase'],
    ['Complete purchase', 'purchase'],
    ['Proceed to payment', 'purchase'],
    ['Delete', 'deleting'],
    ['Delete forever', 'deleting'],
    ['Delete my account', 'deleting'],
    ['Empty trash', 'deleting'],
    ['Permanently delete selected', 'deleting'],
    ['Change password', 'account settings'],
    ['Update email address', 'account settings'],
    ['Turn off two-factor authentication', 'account settings'],
    ['Send', 'sending'],
    ['Send message', 'sending'],
    ['Post now', 'sending'],
    ['Publish', 'sending'],
  ])('%s needs confirmation', (name, kind) => {
    expect(sensitiveActionReason(name, 'button')).toContain(
      kind === 'purchase' ? 'purchase' : kind === 'deleting' ? 'deleting' : kind === 'account settings' ? 'account settings' : 'sending',
    );
  });

  it.each(['Search', 'Next', 'Cause List', 'Sign in', 'Add to cart', 'Proceed to checkout', 'Remove', 'Send feedback', 'Continue', 'Home', 'Download report', 'Accept cookies', 'Subscribe to newsletter'])(
    '%s goes straight ahead',
    (name) => {
      expect(sensitiveActionReason(name, 'button', news)).toBeNull();
    },
  );

  it('does not trip over ordinary words inside a long link or headline', () => {
    expect(sensitiveActionReason('Man jailed for sending threats to the judge after a delete order', 'link')).toBeNull();
    expect(sensitiveActionReason('Post office locations and opening hours near you today', 'link')).toBeNull();
    expect(sensitiveActionReason('x'.repeat(200), 'button')).toBeNull();
  });

  it('a link that says Send is navigation, not the send button', () => {
    expect(sensitiveActionReason('Send', 'link')).toBeNull();
    expect(sensitiveActionReason('Send', 'button')).not.toBeNull();
  });

  it('vague finishing words only count on pages that are plainly about money, bookings or applications', () => {
    expect(sensitiveActionReason('Confirm', 'button', checkout)).toMatch(/submitting/);
    expect(sensitiveActionReason('Submit', 'button', application)).toMatch(/submitting/);
    expect(sensitiveActionReason('Book now', 'button', checkout)).toMatch(/submitting/);
    expect(sensitiveActionReason('Confirm', 'button', news)).toBeNull();
    expect(sensitiveActionReason('Submit', 'button', search)).toBeNull();
    expect(sensitiveActionReason('Submit', 'button')).toBeNull(); // no page context at all: do not guess
  });

  it('is case- and whitespace-insensitive', () => {
    expect(sensitiveActionReason('  BUY   NOW ', 'button')).not.toBeNull();
    expect(sensitiveActionReason('', 'button')).toBeNull();
  });
});

describe('sensitiveSubmitReason: pressing Enter after typing', () => {
  it('is fine in a search or case-number box, but not in a message or comment box', () => {
    expect(sensitiveSubmitReason('Search')).toBeNull();
    expect(sensitiveSubmitReason('Case number')).toBeNull();
    expect(sensitiveSubmitReason('Message')).toMatch(/sending/);
    expect(sensitiveSubmitReason('Add a comment')).toMatch(/sending/);
    expect(sensitiveSubmitReason('Reply')).toMatch(/sending/);
    expect(sensitiveSubmitReason('Write a post')).toMatch(/sending/);
  });
});
