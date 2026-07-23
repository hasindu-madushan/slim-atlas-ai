import { describe, it, expect, vi } from 'vitest';
import { SessionHistory } from '../src/history.js';

function mockManager(calls: Record<string, any[]>) {
  return {
    navigate: vi.fn(async (opts: any) => { calls.navigate.push(opts); }),
    click: vi.fn(async (sel: string) => { calls.click.push(sel); }),
    type: vi.fn(async (sel: string, text: string, opts?: any) => { calls.type.push({ sel, text, opts }); }),
    fill: vi.fn(async (sel: string, val: string) => { calls.fill.push({ sel, val }); }),
    goBack: vi.fn(async () => { calls.goBack.push(true); }),
    goForward: vi.fn(async () => { calls.goForward.push(true); }),
    reload: vi.fn(async () => { calls.reload.push(true); }),
  };
}

function resetCalls(): Record<string, any[]> {
  return { navigate: [], click: [], type: [], fill: [], goBack: [], goForward: [], reload: [] };
}

describe('SessionHistory', () => {
  it('getReplayableActions returns empty when nothing is recorded', () => {
    const h = new SessionHistory();
    expect(h.getReplayableActions()).toEqual([]);
  });

  it('getReplayableActions returns empty when only clicks are recorded (no navigate)', () => {
    const h = new SessionHistory();
    h.record({ type: 'click', selector: '#btn' });
    h.record({ type: 'type', selector: '#inp', text: 'hi' });
    expect(h.getReplayableActions()).toEqual([]);
  });

  it('getReplayableActions returns from the last navigate onward', () => {
    const h = new SessionHistory();
    h.record({ type: 'navigate', url: 'https://a.com' });
    h.record({ type: 'click', selector: '#btn' });
    h.record({ type: 'navigate', url: 'https://b.com' });
    h.record({ type: 'type', selector: '#inp', text: 'hi' });

    const actions = h.getReplayableActions();
    expect(actions.length).toBe(2);
    expect(actions[0]).toEqual({ type: 'navigate', url: 'https://b.com' });
    expect(actions[1]).toEqual({ type: 'type', selector: '#inp', text: 'hi' });
  });

  it('clear empties everything', () => {
    const h = new SessionHistory();
    h.record({ type: 'navigate', url: 'https://a.com' });
    h.record({ type: 'click', selector: '#btn' });
    h.clear();
    expect(h.getReplayableActions()).toEqual([]);
  });

  it('clear resets the last navigate index so a new click alone is empty', () => {
    const h = new SessionHistory();
    h.record({ type: 'navigate', url: 'https://a.com' });
    h.clear();
    h.record({ type: 'click', selector: '#btn' });
    expect(h.getReplayableActions()).toEqual([]);
  });

  describe('replay', () => {
    it('does nothing when there is no recorded navigate', async () => {
      const h = new SessionHistory();
      const calls = resetCalls();
      await h.replay(mockManager(calls) as any, 's1');
      expect(calls.navigate.length).toBe(0);
      expect(calls.click.length).toBe(0);
    });

    it('replays a single navigate', async () => {
      const h = new SessionHistory();
      h.record({ type: 'navigate', url: 'https://x.com', waitUntil: 'load' });
      const calls = resetCalls();
      await h.replay(mockManager(calls) as any, 's1');
      expect(calls.navigate.length).toBe(1);
      expect(calls.navigate[0]).toEqual({ url: 'https://x.com', waitUntil: 'load' });
    });

    it('replays navigate + click sequence', async () => {
      const h = new SessionHistory();
      h.record({ type: 'navigate', url: 'https://x.com' });
      h.record({ type: 'click', selector: '#btn' });
      const calls = resetCalls();
      await h.replay(mockManager(calls) as any, 's1');
      expect(calls.navigate.length).toBe(1);
      expect(calls.click).toEqual(['#btn']);
    });

    it('replays multiple navigations — only from last navigate', async () => {
      const h = new SessionHistory();
      h.record({ type: 'navigate', url: 'https://first.com' }); // skipped
      h.record({ type: 'navigate', url: 'https://second.com' });
      h.record({ type: 'click', selector: '#btn' });
      const calls = resetCalls();
      await h.replay(mockManager(calls) as any, 's1');
      expect(calls.navigate.length).toBe(1);
      expect(calls.navigate[0].url).toBe('https://second.com');
      expect(calls.click).toEqual(['#btn']);
    });

    it('replays all action types in order', async () => {
      const h = new SessionHistory();
      h.record({ type: 'navigate', url: 'https://x.com' });
      h.record({ type: 'click', selector: '.a' });
      h.record({ type: 'type', selector: '.b', text: 'hello', delay: 50 });
      h.record({ type: 'fill', selector: '.c', value: 'world' });
      h.record({ type: 'goBack' });
      h.record({ type: 'goForward' });
      h.record({ type: 'reload' });
      const calls = resetCalls();
      await h.replay(mockManager(calls) as any, 's1');
      expect(calls.navigate.length).toBe(1);
      expect(calls.click).toEqual(['.a']);
      expect(calls.type).toEqual([{ sel: '.b', text: 'hello', opts: { delay: 50 } }]);
      expect(calls.fill).toEqual([{ sel: '.c', val: 'world' }]);
      expect(calls.goBack).toEqual([true]);
      expect(calls.goForward).toEqual([true]);
      expect(calls.reload).toEqual([true]);
    });

    it('continues replay when one action fails', async () => {
      const h = new SessionHistory();
      h.record({ type: 'navigate', url: 'https://x.com' });
      h.record({ type: 'click', selector: '#bad' });
      h.record({ type: 'click', selector: '#good' });
      const calls = resetCalls();
      let firstClick = true;
      function clickImpl(sel: string) {
        calls.click.push(sel);
        if (firstClick) { firstClick = false; return Promise.reject(new Error('not found')); }
        return Promise.resolve();
      }
      await h.replay({ click: clickImpl, navigate: vi.fn().mockResolvedValue(undefined) } as any, 's1');
      // both clicks should have been attempted
      expect(calls.click).toEqual(['#bad', '#good']);
    });
  });
});
