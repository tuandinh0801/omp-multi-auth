// Shared TUI select helpers.
import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { DynamicBorder, keyHint } from "@oh-my-pi/pi-coding-agent";
import { Container, Key, SelectList, Text, matchesKey, type SelectItem } from "@oh-my-pi/pi-tui";

export function getWrappedSelectIndex(items: SelectItem[], value: string | undefined): number {
	if (!value) return 0;
	const index = items.findIndex((item) => item.value === value);
	return index >= 0 ? index : 0;
}

export async function showWrappedSelect(
	ctx: ExtensionCommandContext,
	options: {
		title: string;
		items: SelectItem[];
		subtitle?: string;
		initialValue?: string;
		confirmHint?: string;
		cancelHint?: string;
	},
): Promise<string | undefined> {
	if (options.items.length === 0) return undefined;

	if (!ctx.hasUI) {
		const renderedItems = options.items.map((item) =>
			item.description ? `${item.label} — ${item.description}` : item.label,
		);
		const selected = await ctx.ui.select(options.title, renderedItems);
		if (!selected) return undefined;
		const index = renderedItems.indexOf(selected);
		return index >= 0 ? options.items[index]?.value : undefined;
	}

	const confirmHint = options.confirmHint || "select";
	const cancelHint = options.cancelHint || "close";

	const selectedValue = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		const footer = [
			keyHint("tui.select.confirm", confirmHint),
			keyHint("tui.select.cancel", cancelHint),
		].join(" • ");

		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold(options.title))));
		if (options.subtitle) {
			container.addChild(new Text(theme.fg("dim", options.subtitle)));
		}

		const selectList = new SelectList(options.items, Math.min(options.items.length, 10), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		selectList.setSelectedIndex(getWrappedSelectIndex(options.items, options.initialValue));
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(null);
		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", footer)));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				const current = selectList.getSelectedItem();
				const currentIndex = current
					? options.items.findIndex((item) => item.value === current.value)
					: 0;

				if (matchesKey(data, Key.up) && options.items.length > 1 && currentIndex === 0) {
					selectList.setSelectedIndex(options.items.length - 1);
					tui.requestRender();
					return;
				}

				if (
					matchesKey(data, Key.down)
					&& options.items.length > 1
					&& currentIndex === options.items.length - 1
				) {
					selectList.setSelectedIndex(0);
					tui.requestRender();
					return;
				}

				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});

	return selectedValue ?? undefined;
}
