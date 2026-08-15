import { getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { ThinkingSelectorComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";

const shortcut = Key.shift("tab");

export default function (pi: ExtensionAPI) {
  pi.registerShortcut(shortcut, {
    description: "Choose reasoning level",
    handler: async (ctx) => {
      const model = ctx.model;
      if (!model?.reasoning) {
        ctx.ui.notify("Current model does not support reasoning", "warning");
        return;
      }

      const selected = await ctx.ui.custom<ModelThinkingLevel | null>(
        (tui, _theme, _keybindings, done) => {
          const selector = new ThinkingSelectorComponent(
            pi.getThinkingLevel(),
            getSupportedThinkingLevels(model),
            done,
            () => done(null),
          );

          return {
            render: (width) => selector.render(width),
            invalidate: () => selector.invalidate(),
            handleInput: (data) => {
              if (matchesKey(data, shortcut)) {
                done(null);
                return;
              }
              selector.getSelectList().handleInput(data);
              tui.requestRender();
            },
          };
        },
      );

      if (selected !== null) pi.setThinkingLevel(selected);
    },
  });
}
