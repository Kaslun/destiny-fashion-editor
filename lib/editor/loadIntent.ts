/** Only the most recent async look request may publish a result. Edits invalidate it. */
export class LoadIntent {
  private controller: AbortController | null = null;

  invalidate = () => {
    this.controller?.abort();
    this.controller = null;
  };

  begin() {
    this.invalidate();
    const controller = new AbortController();
    this.controller = controller;
    return {
      signal: controller.signal,
      current: () => this.controller === controller && !controller.signal.aborted,
    };
  }
}
