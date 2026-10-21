import { describe, it, expect } from 'vitest';
import { sensitiveActionReason } from '../src/main/browser/sensitiveActions';
import { checkoutFacts } from '../src/main/browser/checkoutFacts';
import { challengeMessage, isBlockingChallenge } from '../src/main/browser/challenges';
import { createBrowserTools } from '../src/main/tools/impl/browserTools';
import { LoopGuard } from '../src/main/browser/loopGuard';
import type { ActOnPageResult, BrowserAutomationService, ClickGate } from '../src/main/browser/BrowserAutomationService';
import type { PageSnapshot } from '../src/main/browser/pageSnapshot';
import type { Tool } from '../src/main/tools/types';

const page = (over: Partial<PageSnapshot> = {}): PageSnapshot => ({ url: 'https://shop.example/checkout', title: 'Checkout', headings: ['Order summary'], links: [], buttons: [], inputs: [], dialogs: [], truncated: false, ...over });

describe('the clicks that spend money or book something need the user\'s yes', () => {
  it('the final steps of an order and of a booking', () => {
    for (const name of ['Place order', 'Pay now', 'Pay ₹1,299', 'Proceed to payment', 'Make payment', 'Confirm booking', 'Confirm and book', 'Complete booking', 'Pay and book', 'Confirm tickets', 'Confirm seats', 'Confirm reservation']) {
      expect(sensitiveActionReason(name, 'button'), name).not.toBeNull();
    }
  });

  it('but not the steps on the way: finding, choosing, adding to a cart, opening seat selection', () => {
    for (const name of ['Add to cart', 'Search', 'Select seats', 'Book tickets', 'Show timings', 'View details', 'Next', 'Select date']) {
      expect(sensitiveActionReason(name, 'button', { url: 'https://shop.example/item', title: 'Red shirt', headings: ['Red shirt'] }), name).toBeNull();
    }
  });
});

describe('what the page says about the money and the booking', () => {
  it('finds the total first, then the other amounts, the address and the way of paying', () => {
    const facts = checkoutFacts(
      page({
        visibleText: [
          'Order summary',
          'Red cotton shirt (M) x 1   ₹1,099',
          'Delivery charges ₹49',
          'Discount -₹100',
          'Total payable ₹1,048',
          'Deliver to: Rakesh, 12-3 Road No 4, Hyderabad 500034',
          'Payment method: Cash on delivery',
        ].join('\n'),
      }),
    );
    expect(facts?.amounts[0]).toBe('Total payable ₹1,048');
    expect(facts?.amounts).toEqual(expect.arrayContaining(['Delivery charges ₹49', 'Discount -₹100']));
    expect(facts?.deliverTo).toBe('Rakesh, 12-3 Road No 4, Hyderabad 500034');
    expect(facts?.payWith).toBe('Cash on delivery');
    expect(facts?.items).toEqual(['Red cotton shirt (M) x 1 ₹1,099']);
  });

  it('reads a summary whose whole text is one long line, as a real page gives it', () => {
    const facts = checkoutFacts(
      page({
        headings: ['Test Shop', 'Order summary'],
        visibleText:
          'Test Shop Order summary Red cotton shirt (M) x 1   ₹1,099 Delivery charges ₹49 Total payable ₹1,148 Deliver to: 12-3 Road No 4, Hyderabad 500034 Payment method: Cash on delivery Pay by card instead Use cash on delivery Place order',
      }),
    );
    expect(facts?.amounts[0]).toBe('Total payable ₹1,148');
    expect(facts?.amounts).toContain('Delivery charges ₹49');
    expect(facts?.items).toEqual(['Red cotton shirt (M) x 1 ₹1,099']);
    expect(facts?.deliverTo).toBe('12-3 Road No 4, Hyderabad 500034');
    expect(facts?.payWith).toBe('Cash on delivery');
  });

  it('finds the details of a booking', () => {
    const facts = checkoutFacts(page({ headings: ['Test Cinema', 'Dune Part Three'], visibleText: 'Test Cinema Dune Part Three Screen 3 · Sat 25 Oct, 7:30 PM F6 F7 F8 F9 Seats selected: F7, F8 2 Tickets Convenience fee ₹60 Total ₹560 Confirm booking' }));
    expect(facts?.details).toEqual(expect.arrayContaining(['Dune Part Three', 'Screen 3', 'Sat 25 Oct, 7:30 PM', 'Seats: F7, F8', '2 Tickets']));
    expect(facts?.amounts[0]).toBe('Total ₹560');
    expect(facts?.amounts).toContain('Convenience fee ₹60');
  });

  it('says nothing for a page that has none of it', () => {
    expect(checkoutFacts(page({ visibleText: 'Welcome to our blog about shirts.', headings: ['Welcome'] }))).toBeNull();
  });
});

describe('the payment step', () => {
  it('is reported with instructions to hand it to the user, and is not a wall for the page\'s own buttons', () => {
    expect(isBlockingChallenge('payment')).toBe(false);
    const text = challengeMessage('payment');
    expect(text).toMatch(/payment is theirs|are the user's/);
    expect(text).toMatch(/wait_for_user_in_browser/);
    expect(text).toMatch(/never type or read them/);
  });
});

describe('the question before the click that spends money carries what the page shows', () => {
  function make(snapshot: PageSnapshot) {
    const service = {
      inspectPage: async () => snapshot,
      clickOnPage: async (_text: string, gate?: ClickGate): Promise<ActOnPageResult> => {
        const why = gate?.({ name: 'Place order', role: 'button' }) ?? null;
        return why !== null ? { ok: false, reason: 'needs_confirmation', why, target: 'Place order', snapshot } : { ok: true, snapshot };
      },
    } as unknown as BrowserAutomationService;
    return createBrowserTools(service, new LoopGuard()).find((t) => t.schema.name === 'click_on_page') as Tool;
  }

  it('Place order: nothing is clicked, and the amounts and address go back with the question', async () => {
    const tool = make(page({ visibleText: 'Total payable ₹1,048\nDeliver to: 12-3 Road No 4, Hyderabad 500034\nPayment method: Cash on delivery' }));
    const r = await tool.execute({ text: 'Place order' });
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('needs confirmation');
    expect(r.data?.['checkout']).toMatchObject({ amounts: ['Total payable ₹1,048'], deliverTo: '12-3 Road No 4, Hyderabad 500034', payWith: 'Cash on delivery' });
  });

  it('a page with no amounts still asks, without inventing any', async () => {
    const r = await make(page({ visibleText: 'Thank you for shopping' })).execute({ text: 'Place order' });
    expect(r.summary).toBe('needs confirmation');
    expect(r.data).not.toHaveProperty('checkout');
  });
});
