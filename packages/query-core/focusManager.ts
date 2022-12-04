export class FocusManager {
  isFocused(): boolean {
    return [undefined, "visible", "prerender"].includes(
      document.visibilityState
    );
  }
}

export const focusManager = new FocusManager();
