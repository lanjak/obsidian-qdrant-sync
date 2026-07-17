import { App, PluginSettingTab, Setting } from "obsidian";
import type QdrantSyncPlugin from "./main";

export interface QdrantSyncSettings {
  qdrantUrl: string;
  qdrantApiKey: string;
  embedUrl: string;
  collection: string;
  pullIntervalSeconds: number;
  lastSyncCursor: number;
}

export const DEFAULT_SETTINGS: QdrantSyncSettings = {
  qdrantUrl: "",
  qdrantApiKey: "",
  embedUrl: "",
  collection: "obsidian_notes",
  pullIntervalSeconds: 30,
  lastSyncCursor: 0,
};

export class QdrantSyncSettingTab extends PluginSettingTab {
  plugin: QdrantSyncPlugin;

  constructor(app: App, plugin: QdrantSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Qdrant URL")
      .setDesc("Your Qdrant instance, e.g. https://qdrant.example.com")
      .addText((text) =>
        text.setValue(this.plugin.settings.qdrantUrl).onChange(async (value) => {
          this.plugin.settings.qdrantUrl = value.replace(/\/+$/, "");
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Qdrant API key")
      .setDesc("Set via QDRANT__SERVICE__API_KEY on the server")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setValue(this.plugin.settings.qdrantApiKey).onChange(async (value) => {
          this.plugin.settings.qdrantApiKey = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Embedding server URL")
      .setDesc("llama.cpp server with --embedding enabled, e.g. https://embed.example.com")
      .addText((text) =>
        text.setValue(this.plugin.settings.embedUrl).onChange(async (value) => {
          this.plugin.settings.embedUrl = value.replace(/\/+$/, "");
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Collection name")
      .addText((text) =>
        text.setValue(this.plugin.settings.collection).onChange(async (value) => {
          this.plugin.settings.collection = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Pull interval (seconds)")
      .setDesc("How often to poll Qdrant for remote changes")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.pullIntervalSeconds)).onChange(async (value) => {
          const n = Number(value);
          if (Number.isFinite(n) && n > 0) {
            this.plugin.settings.pullIntervalSeconds = n;
            await this.plugin.saveSettings();
          }
        }),
      );

    new Setting(containerEl)
      .setName("Force full resync")
      .setDesc("Reset the sync cursor to 0 and re-pull everything on next interval - use if this device missed changes")
      .addButton((btn) =>
        btn.setButtonText("Reset cursor").onClick(async () => {
          this.plugin.settings.lastSyncCursor = 0;
          await this.plugin.saveSettings();
        }),
      );
  }
}
