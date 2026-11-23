import { describe, expect, it } from 'vitest';
import { addressIndex, advanceCheckout, continueCheckout, detectStage, methodFromReply, parseAddresses, paymentMethods } from '../src/main/agent/checkoutRunner';
import type { PendingCheckout } from '../src/main/agent/checkoutRunner';
import { pageOf } from '../src/main/agent/pageReading';
import type { ToolArgs, ToolResult } from '../src/main/tools/types';

const page = (title: string, extra: Record<string, unknown> = {}): ToolResult => ({
  ok: true,
  summary: title,
  data: { currentPage: { url: 'https://www.flipkart.com/checkout', title, headings: [], links: [], buttons: [], inputs: [], ...extra } },
});
const view = (title: string, extra: Record<string, unknown> = {}) => ({ page: pageOf(page(title, extra)) as NonNullable<ReturnType<typeof pageOf>>, text: String(extra['visibleText'] ?? '') });

// Flipkart's checkout, the way its pages list (the steps are all on one page; the open one has the button)
const ADDRESS_ONE = page('Checkout - Flipkart', {
  headings: ['Delivery Address'],
  buttons: ['Deliver Here', 'Change'],
  visibleText: 'Delivery Address\nRakesh HOME 9876543210\nH.No 1-2, Main Road, Makthal, Narayanpet - 509208\nOrder Summary\nPayment Options',
});
const ADDRESS_TWO = page('Checkout - Flipkart', {
  headings: ['Delivery Address'],
  buttons: ['Deliver Here'],
  visibleText: 'Delivery Address\nRakesh HOME 9876543210\nH.No 1-2, Main Road, Makthal, Narayanpet - 509208\nRakesh WORK 9876543210\nPlot 45, Road No 12, Banjara Hills, Hyderabad - 500034\nOrder Summary\nPayment Options',
});
const SUMMARY = page('Checkout - Flipkart', { headings: ['Order Summary'], buttons: ['Continue'], visibleText: 'Order Summary\nPOCO M7 Pro 5G x 1 ₹14,999\nTotal ₹14,249' });
const PAYMENT = page('Payment - Flipkart', {
  headings: ['Payment Options'],
  buttons: ['UPI', 'Cash on Delivery', 'Credit / Debit / ATM Card', 'Net Banking', 'Pay ₹14,249'],
  visibleText: 'Payment Options\nUPI\nCash on Delivery\nNet Banking\nTotal Payable ₹14,249\nDelivering to Rakesh, H.No 1-2 Main Road, Makthal, Narayanpet - 509208',
});
const UNAVAILABLE = page('Checkout - Flipkart', { headings: ['Delivery Address'], visibleText: 'POCO M7 Pro 5G is currently out of stock for delivery to Makthal 509208' });
const LOGIN = page('Login & Signup', { signedIn: 'no', inputs: ['Enter Email/Mobile number'], headings: ['Login'] });

/** A pretend checkout: which page comes after pressing which button; every call is recorded. */
function checkout(start: ToolResult, next: Record<string, ToolResult>) {
  const calls: Array<{ name: string; args: ToolArgs }> = [];
  let cur = start;
  return {
    calls,
    deps: {
      say: () => undefined,
      sleep: async () => undefined,
      invoke: async (name: string, args: ToolArgs): Promise<ToolResult> => {
        calls.push({ name, args });
        if (name === 'inspect_page') return cur;
        if (name === 'read_page') return { ok: true, summary: 'read', data: { text: String((cur.data?.['currentPage'] as Record<string, unknown>)['visibleText'] ?? '') } };
        if (name === 'click_on_page') {
          const to = next[String(args['text'])];
          if (to === undefined) return { ok: false, summary: 'not found', error: 'nothing like that' };
          cur = to;
          return to;
        }
        return { ok: false, summary: 'no such tool', error: name };
      },
    },
    clicks: () => calls.filter((c) => c.name === 'click_on_page').map((c) => c.args),
  };
}
const ctx = { site: 'Flipkart', product: 'POCO M7 Pro 5G 6GB 128GB' };

describe('reading a checkout page', () => {
  it('names the step that is open: sign-in, out of stock, address, order summary, payment', () => {
    const stage = (r: ToolResult) => detectStage(pageOf(r) as NonNullable<ReturnType<typeof pageOf>>, String((r.data?.['currentPage'] as Record<string, unknown>)['visibleText'] ?? ''));
    expect(stage(LOGIN)).toBe('login');
    expect(stage(UNAVAILABLE)).toBe('unavailable');
    expect(stage(ADDRESS_ONE)).toBe('address');
    expect(stage(SUMMARY)).toBe('summary');
    expect(stage(PAYMENT)).toBe('payment');
    expect(stage(page('Something else', { buttons: ['Help'] }))).toBe('unknown');
  });

  it('"out of stock" in the many ways a page says an item cannot be delivered', () => {
    for (const text of ['Currently out of stock', 'This item is not deliverable to your pincode', 'Sorry, we cannot be delivered to this address', 'Delivery not available at this location', 'Sold out']) {
      expect(detectStage(view('Checkout').page, text), text).toBe('unavailable');
    }
  });

  it('lists the ways to pay the page offers, and only those; a long sentence about something else is not one', () => {
    const v = view('Pay', { buttons: ['UPI', 'Cash on Delivery', 'Credit / Debit / ATM Card'], visibleText: 'Pay with confidence: we accept every wallet in the world and many cards besides' });
    expect(paymentMethods(v.page, v.text)).toEqual(['UPI', 'Cash on Delivery', 'Card']);
  });

  it('the saved addresses are the lines with a pincode between "Delivery Address" and the next step; a phone number is not one', () => {
    expect(parseAddresses(String((ADDRESS_ONE.data?.['currentPage'] as Record<string, unknown>)['visibleText']))).toEqual(['H.No 1-2, Main Road, Makthal, Narayanpet - 509208']);
    expect(parseAddresses(String((ADDRESS_TWO.data?.['currentPage'] as Record<string, unknown>)['visibleText']))).toEqual(['H.No 1-2, Main Road, Makthal, Narayanpet - 509208', 'Plot 45, Road No 12, Banjara Hills, Hyderabad - 500034']);
  });

  it('a reply picks an address by number, by "second", or by a place that is in exactly one of them', () => {
    const options = ['H.No 1-2, Main Road, Makthal, Narayanpet - 509208', 'Plot 45, Road No 12, Banjara Hills, Hyderabad - 500034'];
    expect(addressIndex('2', options)).toBe(1);
    expect(addressIndex('the second one', options)).toBe(1);
    expect(addressIndex('first', options)).toBe(0);
    expect(addressIndex('hyderabad please', options)).toBe(1);
    expect(addressIndex('makthal', options)).toBe(0);
    expect(addressIndex('main road banjara', options)).toBeNull(); // (both: not a choice)
    expect(addressIndex('what', options)).toBeNull();
  });

  it('a reply names a way to pay', () => {
    expect(methodFromReply('UPI')).toBe('UPI');
    expect(methodFromReply('i will pay by gpay')).toBe('UPI');
    expect(methodFromReply('cash on delivery please')).toBe('Cash on Delivery');
    expect(methodFromReply('COD')).toBe('Cash on Delivery');
    expect(methodFromReply('debit card')).toBe('Card');
    expect(methodFromReply('net banking')).toBe('Net Banking');
    expect(methodFromReply('what is the delivery date')).toBeNull();
  });
});

describe('walking the checkout', () => {
  it('one saved address, then the order summary: both are passed (they cost nothing), and the ONE question is how to pay', async () => {
    const c = checkout(ADDRESS_ONE, { 'Deliver Here': SUMMARY, Continue: PAYMENT });
    const r = await advanceCheckout(c.deps, ctx);
    expect(c.clicks()).toEqual([{ text: 'Deliver Here' }, { text: 'Continue' }]);
    expect(r.answer).toMatch(/How do you want to pay — UPI, Cash on Delivery, Card, Net Banking\?/);
    expect(r.answer).toMatch(/Total Payable ₹14,249/);
    expect(r.answer).toMatch(/Makthal/);
    expect(r.answer).not.toMatch(/proceed/i);
    expect(r.pending).toMatchObject({ stage: 'payment', options: ['UPI', 'Cash on Delivery', 'Card', 'Net Banking'] });
    expect(r.steps).toEqual(['Used the delivery address (H.No 1-2, Main Road, Makthal, Narayanpet - 509208)', 'Went on from the order summary']);
  });

  it('several saved addresses: they are listed and the person chooses; nothing is pressed yet', async () => {
    const c = checkout(ADDRESS_TWO, { 'Deliver Here': SUMMARY });
    const r = await advanceCheckout(c.deps, ctx);
    expect(c.clicks()).toEqual([]);
    expect(r.answer).toMatch(/You have 2 delivery addresses on Flipkart: 1\) H\.No 1-2, Main Road, Makthal, Narayanpet - 509208 2\) Plot 45, Road No 12, Banjara Hills, Hyderabad - 500034 Which one/);
    expect(r.pending).toMatchObject({ stage: 'address' });
    expect(r.pending?.options).toHaveLength(2);
  });

  it('an item that cannot be delivered to the address is said at once, before anything is bought', async () => {
    const c = checkout(UNAVAILABLE, {});
    const r = await advanceCheckout(c.deps, ctx);
    expect(r.answer).toMatch(/not available for delivery to/);
    expect(r.answer).toMatch(/another saved address, another variant or another phone/);
    expect(c.clicks()).toEqual([]);
    expect(r.pending).toBeNull();
  });

  it('a sign-in is the person\'s', async () => {
    const r = await advanceCheckout(checkout(LOGIN, {}).deps, ctx);
    expect(r.needsUser).toBe(true);
    expect(r.answer).toMatch(/never type a password/);
  });

  it('a page it does not know is waited on a little, then handed to the model with the steps done', async () => {
    const r = await advanceCheckout(checkout(page('Mystery', { buttons: ['Help'] }), {}).deps, ctx);
    expect(r.answer).toBeNull();
    expect(r.note).toMatch(/not one of the checkout steps she knows/);
    expect(r.note).toMatch(/ONE question at the payment step/);
  });

  it('the same step coming up again and again (a button that does nothing) ends in a hand-over, not a loop', async () => {
    const c = checkout(ADDRESS_ONE, { 'Deliver Here': ADDRESS_ONE });
    const r = await advanceCheckout(c.deps, ctx);
    expect(r.answer).toBeNull();
    expect(r.note).toMatch(/came up three times/);
    expect(c.clicks().length).toBeLessThanOrEqual(3);
  });

  it('never presses anything that pays: not "Pay", not "Place order"', async () => {
    const c = checkout(ADDRESS_ONE, { 'Deliver Here': SUMMARY, Continue: PAYMENT });
    await advanceCheckout(c.deps, ctx);
    expect(c.clicks().some((a) => /pay|place order/i.test(String(a['text'])))).toBe(false);
  });
});

describe('the person\'s answers', () => {
  const pending = (stage: PendingCheckout['stage'], extra: Partial<PendingCheckout> = {}): PendingCheckout => ({ site: 'Flipkart', product: 'POCO M7 Pro 5G 6GB 128GB', stage, options: [], summary: 'POCO M7 Pro 5G, Total Payable ₹14,249, delivering to Makthal.', at: Date.now(), ...extra });

  it('"the second one" chooses that address and the walk goes on to the question about paying', async () => {
    const afterPick = page('Checkout', { headings: ['Delivery Address'], buttons: ['Deliver Here'], visibleText: 'Delivery Address\nPlot 45, Road No 12, Banjara Hills, Hyderabad - 500034\nOrder Summary' });
    const c = checkout(ADDRESS_TWO, { 'Plot 45, Road No 12, Banjara Hills, Hyderabad - 500034': afterPick, 'Deliver Here': SUMMARY, Continue: PAYMENT });
    const r = await continueCheckout(c.deps, pending('address', { options: ['H.No 1-2, Main Road, Makthal, Narayanpet - 509208', 'Plot 45, Road No 12, Banjara Hills, Hyderabad - 500034'] }), 'the second one');
    expect(c.clicks()[0]).toEqual({ text: 'Plot 45, Road No 12, Banjara Hills, Hyderabad - 500034' });
    expect(r?.answer).toMatch(/How do you want to pay/);
  });

  it('an address reply that picks none is not an answer (the model is asked)', async () => {
    expect(await continueCheckout(checkout(ADDRESS_TWO, {}).deps, pending('address', { options: ['A - 111111', 'B - 222222'] }), 'hmm what about the colour')).toBeNull();
  });

  it('"UPI": it is chosen, and ONE confirmation is asked with the item, the total, the address and the method — nothing is pressed that pays', async () => {
    const afterUpi = page('Payment', { buttons: ['Pay ₹14,249'], visibleText: 'UPI selected\nTotal Payable ₹14,249\nDelivering to Rakesh, H.No 1-2 Main Road, Makthal - 509208' });
    const c = checkout(PAYMENT, { UPI: afterUpi });
    const r = await continueCheckout(c.deps, pending('payment', { options: ['UPI', 'Cash on Delivery'] }), 'UPI');
    expect(c.clicks()).toEqual([{ text: 'UPI' }]);
    expect(r?.answer).toMatch(/I chose UPI\. POCO M7 Pro 5G 6GB 128GB, Total Payable ₹14,249, delivering to Rakesh, H\.No 1-2 Main Road, Makthal - 509208\. Shall I place the order now\?/);
    expect(r?.pending).toMatchObject({ stage: 'confirm', method: 'UPI' });
  });

  it('a card is the person\'s: Eya opens the card option and says she never types card details', async () => {
    const c = checkout(PAYMENT, { 'Credit / Debit / ATM Card': page('Card', { inputs: ['Card Number', 'Expiry', 'CVV'] }) });
    const r = await continueCheckout(c.deps, pending('payment'), 'debit card');
    expect(r?.answer).toMatch(/never type card numbers, expiry or CVV/);
    expect(r?.needsUser).toBe(true);
    expect(r?.pending).toBeNull();
    expect(c.calls.some((x) => x.name === 'fill_on_page')).toBe(false);
  });

  it('a payment reply that names no method is not an answer', async () => {
    expect(await continueCheckout(checkout(PAYMENT, {}).deps, pending('payment'), 'what is the delivery date')).toBeNull();
  });

  it('"yes" at the confirmation presses the button that places the order — with confirm — and reports what the page shows', async () => {
    const confirmPage = page('Payment', { buttons: ['Pay ₹14,249'], visibleText: 'Total Payable ₹14,249' });
    const placed = page('Order Placed', { headings: ['Order placed successfully'], visibleText: 'Order placed successfully\nOrder ID OD123456789012' });
    const c = checkout(confirmPage, { 'Pay ₹14,249': placed });
    const r = await continueCheckout(c.deps, pending('confirm', { method: 'Cash on Delivery' }), 'yes');
    expect(c.clicks()).toEqual([{ text: 'Pay ₹14,249', confirm: true }]);
    expect(r?.answer).toMatch(/Done: the order for POCO M7 Pro 5G 6GB 128GB is placed on Flipkart \(order OD123456789012\)/);
  });

  it('a button that leads to a UPI approval is not reported as an order: the person is told what to do', async () => {
    const confirmPage = page('Payment', { buttons: ['Pay ₹14,249'], visibleText: 'Total Payable ₹14,249' });
    const waiting = page('Complete payment', { visibleText: 'Waiting for UPI approval' });
    const c = checkout(confirmPage, { 'Pay ₹14,249': waiting });
    const r = await continueCheckout(c.deps, pending('confirm', { method: 'UPI' }), 'yes');
    expect(r?.answer).toMatch(/can't see an order confirmation yet/);
    expect(r?.answer).toMatch(/UPI approval on your phone/);
    expect(r?.needsUser).toBe(true);
  });

  it('"no" at any stage stops: nothing is pressed', async () => {
    for (const stage of ['address', 'payment', 'confirm'] as const) {
      const c = checkout(PAYMENT, {});
      const r = await continueCheckout(c.deps, pending(stage), 'no, cancel it');
      expect(r?.answer).toMatch(/Nothing was paid or placed/);
      expect(r?.pending).toBeNull();
      expect(c.calls).toEqual([]);
    }
  });

  it('only a clear yes places it: anything else at the confirmation is not an answer', async () => {
    for (const text of ['hmm', 'what is the total', 'maybe later', 'change the address']) {
      const c = checkout(PAYMENT, {});
      expect(await continueCheckout(c.deps, pending('confirm'), text), text).toBeNull();
      expect(c.calls).toEqual([]);
    }
  });

  it('with no button to place the order on the page it is handed over, never "done"', async () => {
    const c = checkout(page('Payment', { buttons: ['Help'], visibleText: 'Total ₹14,249' }), {});
    const r = await continueCheckout(c.deps, pending('confirm'), 'yes');
    expect(r?.answer).toBeNull();
    expect(r?.note).toMatch(/button that places the order could not be seen/);
  });
});
