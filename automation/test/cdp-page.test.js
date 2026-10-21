const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { CdpPage } = require('../src/cdp-page');

class FakeSession extends EventEmitter {
  constructor() { super(); this.calls = []; this.readyStates = ['loading', 'interactive']; this.url = 'https://example.test/jobs'; }
  async send(method, params = {}) {
    this.calls.push({ method, params });
    if (method === 'Runtime.evaluate') {
      if (params.expression === 'location.href') return { result: { value: this.url } };
      if (params.expression.includes('document.readyState')) {
        const readyState = this.readyStates.shift() || 'interactive';
        return { result: { value: [readyState, this.url] } };
      }
      return { result: { value: 'serialized-ok' } };
    }
    return {};
  }
}

test('goto polls readiness, evaluate serializes args, and mouse click tracks pressed buttons', async () => {
  const session = new FakeSession();
  const page = new CdpPage(null, session, 'target-1');
  await page.goto('https://example.test/jobs', { timeout: 5000 });
  const readiness = session.calls.filter(call => call.method === 'Runtime.evaluate' && call.params.expression.includes('document.readyState'));
  assert.equal(readiness.length, 2);
  assert.ok(session.calls.some(call => call.method === 'Page.navigate' && call.params.url === 'https://example.test/jobs'));

  const payload = { text: 'quote " and slash \\', values: [1, 2] };
  assert.equal(await page.evaluate((value) => value, payload), 'serialized-ok');
  const evaluation = session.calls.findLast(call => call.method === 'Runtime.evaluate' && call.params.expression.includes('quote'));
  assert.ok(evaluation.params.expression.includes(JSON.stringify([payload])));

  await page.mouse.click(12, 34);
  const mouseEvents = session.calls.filter(call => call.method === 'Input.dispatchMouseEvent');
  assert.deepEqual(mouseEvents.map(call => [call.params.type, call.params.buttons, call.params.pointerType]), [
    ['mouseMoved', 0, 'mouse'], ['mousePressed', 1, 'mouse'], ['mouseReleased', 0, 'mouse'],
  ]);
});
