import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Key,
  matchesKey,
  type SelectItem,
  SelectList,
  Text,
} from "@earendil-works/pi-tui";

export type LoopPickResult = { action: "stop"; id: string } | { action: "close" };

export function isLoopStopKey(data: string): boolean {
  return (
    matchesKey(data, "d") ||
    matchesKey(data, "x") ||
    matchesKey(data, Key.backspace) ||
    matchesKey(data, Key.delete)
  );
}

export async function pickLoopToManage(
  ctx: ExtensionContext,
  items: SelectItem[],
): Promise<LoopPickResult> {
  return ctx.ui.custom<LoopPickResult>((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold("Session loops")), 1, 0));

    const selectList = new SelectList(items, Math.min(items.length, 10), {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", t),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    });
    selectList.onSelect = () => done({ action: "close" });
    selectList.onCancel = () => done({ action: "close" });
    container.addChild(selectList);
    container.addChild(new Text(theme.fg("dim", "↑↓ navigate • d stop • esc close"), 1, 0));
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    return {
      render: (w) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        if (isLoopStopKey(data)) {
          const selected = selectList.getSelectedItem();
          if (selected) done({ action: "stop", id: selected.value });
          else done({ action: "close" });
          return;
        }
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });
}
