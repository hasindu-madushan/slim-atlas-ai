import type { ChromeManager } from './chrome.js';
import { log } from './logger.js';

export type SessionAction =
  | { type: 'navigate'; url: string; waitUntil?: string }
  | { type: 'click'; selector: string }
  | { type: 'type'; selector: string; text: string; delay?: number }
  | { type: 'fill'; selector: string; value: string }
  | { type: 'goBack' }
  | { type: 'goForward' }
  | { type: 'reload' };

export class SessionHistory {
  private actions: SessionAction[] = [];
  private lastNavigateIndex = -1;

  record(action: SessionAction): void {
    this.actions.push(action);
    if (action.type === 'navigate') {
      this.lastNavigateIndex = this.actions.length - 1;
    }
  }

  getReplayableActions(): SessionAction[] {
    if (this.lastNavigateIndex < 0) return [];
    return this.actions.slice(this.lastNavigateIndex);
  }

  clear(): void {
    this.actions = [];
    this.lastNavigateIndex = -1;
  }

  async replay(manager: ChromeManager, sessionId: string): Promise<void> {
    const actions = this.getReplayableActions();
    if (actions.length === 0) return;

    log.info(sessionId, `Replaying ${actions.length} action(s) on Chrome`);

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      try {
        switch (action.type) {
          case 'navigate':
            log.debug(sessionId, `Replay: navigate to ${action.url}`);
            await manager.navigate({ url: action.url, waitUntil: action.waitUntil as any });
            break;
          case 'click':
            log.debug(sessionId, `Replay: click ${action.selector}`);
            await manager.click(action.selector);
            break;
          case 'type':
            log.debug(sessionId, `Replay: type into ${action.selector}`);
            await manager.type(action.selector, action.text, { delay: action.delay });
            break;
          case 'fill':
            log.debug(sessionId, `Replay: fill ${action.selector}`);
            await manager.fill(action.selector, action.value);
            break;
          case 'goBack':
            log.debug(sessionId, `Replay: goBack`);
            await manager.goBack();
            break;
          case 'goForward':
            log.debug(sessionId, `Replay: goForward`);
            await manager.goForward();
            break;
          case 'reload':
            log.debug(sessionId, `Replay: reload`);
            await manager.reload();
            break;
        }
      } catch (e: any) {
        log.warn(sessionId, `Replay action ${i} (${action.type}) failed: ${e.message}, continuing`);
      }
    }
  }
}
