import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	debounce,
} from "obsidian";

interface GraphSearchSyncSettings {
	enabled: boolean;
	includeLocalGraph: boolean;
	clearOnEmpty: boolean;
	debounceMs: number;
	hoverHighlight: boolean;
}

const DEFAULT_SETTINGS: GraphSearchSyncSettings = {
	enabled: true,
	includeLocalGraph: false,
	clearOnEmpty: true,
	debounceMs: 250,
	hoverHighlight: true,
};

export default class GraphSearchSyncPlugin extends Plugin {
	settings: GraphSearchSyncSettings;

	private attachedInput: HTMLInputElement | null = null;
	private applyDebounced: (query: string) => void;
	private hoveredResultEl: Element | null = null;
	private highlightedRenderers = new Set<any>();

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new GraphSearchSyncSettingTab(this.app, this));
		this.rebuildDebounce();

		this.addCommand({
			id: "toggle-sync",
			name: "Toggle sync",
			callback: async () => {
				this.settings.enabled = !this.settings.enabled;
				await this.saveSettings();
				new Notice(
					this.settings.enabled
						? "Graph Search Sync: enabled"
						: "Graph Search Sync: disabled"
				);
				if (this.settings.enabled) this.syncNow();
			},
		});

		this.addCommand({
			id: "sync-now",
			name: "Apply search query to graph now",
			callback: () => this.syncNow(true),
		});

		this.app.workspace.onLayoutReady(() => {
			this.attachToSearch();
			this.syncNow();
		});

		// The search input and graph views can be (re)created at any time,
		// so re-check on every layout change.
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				this.attachToSearch();
				this.syncNow();
			})
		);
	}

	rebuildDebounce() {
		this.applyDebounced = debounce(
			(query: string) => this.applyToGraphs(query),
			Math.max(0, this.settings.debounceMs),
			true
		);
	}

	private getSearchInput(): HTMLInputElement | null {
		const leaf = this.app.workspace.getLeavesOfType("search")[0];
		const view = leaf?.view as any;
		return (view?.searchComponent?.inputEl as HTMLInputElement) ?? null;
	}

	private attachToSearch() {
		const leaf = this.app.workspace.getLeavesOfType("search")[0];
		const view = leaf?.view as any;
		const input = view?.searchComponent?.inputEl as
			| HTMLInputElement
			| undefined;
		if (!input || input === this.attachedInput) return;
		this.attachedInput = input;

		this.registerDomEvent(input, "input", () => this.onQueryChanged());

		// The search field's clear button does not fire an input event.
		const clearBtn = view?.searchComponent?.clearButtonEl as
			| HTMLElement
			| undefined;
		if (clearBtn) {
			this.registerDomEvent(clearBtn, "click", () =>
				this.onQueryChanged()
			);
		}

		// Hovering a search result highlights the corresponding node in
		// the graph (event delegation on the results container).
		const container =
			((view?.dom?.el as HTMLElement) ?? view?.containerEl) as
				| HTMLElement
				| undefined;
		if (container) {
			this.registerDomEvent(container, "mouseover", (e: MouseEvent) =>
				this.onResultHover(e, view)
			);
			this.registerDomEvent(container, "mouseleave", () =>
				this.endResultHover()
			);
		}
	}

	private onResultHover(e: MouseEvent, searchView: any) {
		if (!this.settings.hoverHighlight) return;
		const el =
			(e.target as HTMLElement)?.closest?.(
				".tree-item.search-result"
			) ?? null;
		if (el === this.hoveredResultEl) return;
		this.hoveredResultEl = el;
		if (!el) {
			this.clearGraphHighlights();
			return;
		}
		const file = this.fileForResultEl(searchView, el);
		if (file?.path) this.highlightInGraphs(file.path);
		else this.clearGraphHighlights();
	}

	private endResultHover() {
		this.hoveredResultEl = null;
		this.clearGraphHighlights();
	}

	private fileForResultEl(searchView: any, el: Element): any {
		const lookup: Map<any, any> | undefined =
			searchView?.dom?.resultDomLookup;
		if (!lookup) return null;
		for (const [file, item] of lookup) {
			if (item?.el === el) return file;
		}
		return null;
	}

	private highlightInGraphs(path: string) {
		this.clearGraphHighlights();
		const types = ["graph"];
		if (this.settings.includeLocalGraph) types.push("localgraph");

		for (const type of types) {
			for (const leaf of this.app.workspace.getLeavesOfType(type)) {
				const renderer = (leaf.view as any)?.renderer;
				const node = renderer?.nodeLookup?.[path];
				if (!node) continue;
				// The render loop clears the highlight when the last known
				// mouse position is not over the node, so reset it.
				renderer.mouseX = null;
				renderer.mouseY = null;
				renderer.highlightNode = node;
				renderer.changed();
				this.highlightedRenderers.add(renderer);
			}
		}
	}

	private clearGraphHighlights() {
		for (const renderer of this.highlightedRenderers) {
			if (renderer?.highlightNode) {
				renderer.highlightNode = null;
				renderer.changed();
			}
		}
		this.highlightedRenderers.clear();
	}

	onunload() {
		this.clearGraphHighlights();
	}

	private onQueryChanged() {
		if (!this.settings.enabled) return;
		const input = this.attachedInput;
		if (!input) return;
		this.applyDebounced(input.value);
	}

	/**
	 * Immediately applies the current search query to all open graphs --
	 * including an empty one, so a reopened graph does not keep a stale
	 * filter. If an empty search should leave the graph alone, the
	 * "clearOnEmpty" setting in applyToGraphs takes care of it.
	 */
	syncNow(force = false) {
		if (!this.settings.enabled && !force) return;
		const input = this.getSearchInput();
		if (!input) return;
		this.applyToGraphs(input.value);
	}

	private applyToGraphs(query: string) {
		if (!this.settings.clearOnEmpty && query.trim() === "") return;

		const types = ["graph"];
		if (this.settings.includeLocalGraph) types.push("localgraph");

		for (const type of types) {
			for (const leaf of this.app.workspace.getLeavesOfType(type)) {
				const view = leaf.view as any;
				// The graph view has no public API; the filter lives on
				// the internal dataEngine (local graph: engine).
				const engine = view?.dataEngine ?? view?.engine;
				const search = engine?.filterOptions?.search;
				const inputEl = search?.inputEl as
					| HTMLInputElement
					| undefined;
				if (inputEl) {
					if (inputEl.value === query) continue;
					inputEl.value = query;
					// Same code path as real typing, so Obsidian
					// re-evaluates the filter itself.
					inputEl.dispatchEvent(new Event("input", { bubbles: true }));
				} else if (typeof search?.setValue === "function") {
					search.setValue(query);
					engine?.updateSearch?.();
				}
			}
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class GraphSearchSyncSettingTab extends PluginSettingTab {
	plugin: GraphSearchSyncPlugin;

	constructor(app: App, plugin: GraphSearchSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Sync enabled")
			.setDesc(
				"Automatically applies the global search query to the graph view filter."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enabled)
					.onChange(async (value) => {
						this.plugin.settings.enabled = value;
						await this.plugin.saveSettings();
						if (value) this.plugin.syncNow();
					})
			);

		new Setting(containerEl)
			.setName("Also filter local graphs")
			.setDesc(
				"Additionally applies the search query to open local graph views."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.includeLocalGraph)
					.onChange(async (value) => {
						this.plugin.settings.includeLocalGraph = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Highlight node on search result hover")
			.setDesc(
				"Hovering a search result in the list highlights the corresponding note in the graph."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.hoverHighlight)
					.onChange(async (value) => {
						this.plugin.settings.hoverHighlight = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Clear graph filter when search is empty")
			.setDesc(
				"When the search query is cleared, the graph filter is cleared as well. If disabled, the last filter is kept."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.clearOnEmpty)
					.onChange(async (value) => {
						this.plugin.settings.clearOnEmpty = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Debounce delay (ms)")
			.setDesc(
				"How long to wait after the last keystroke before updating the graph."
			)
			.addText((text) =>
				text
					.setPlaceholder("250")
					.setValue(String(this.plugin.settings.debounceMs))
					.onChange(async (value) => {
						const num = Number(value);
						if (!Number.isNaN(num) && num >= 0) {
							this.plugin.settings.debounceMs = num;
							await this.plugin.saveSettings();
							this.plugin.rebuildDebounce();
						}
					})
			);
	}
}
