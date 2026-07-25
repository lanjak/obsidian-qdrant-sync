import { App, PluginSettingTab, type SettingDefinitionItem } from "obsidian";
import type QdrantSyncPlugin from "./main";

export interface QdrantSyncSettings {
  qdrantUrl: string;
  qdrantApiKey: string;
  embedUrl: string;
  embedApiKey: string;
  collection: string;
  pullIntervalSeconds: number;
  lastSyncCursor: number;
}

export const DEFAULT_SETTINGS: QdrantSyncSettings = {
  qdrantUrl: "",
  qdrantApiKey: "",
  embedUrl: "",
  embedApiKey: "",
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

  override setControlValue(key: string, value: unknown): void | Promise<void> {
    if ((key === "qdrantUrl" || key === "embedUrl") && typeof value === "string") {
      value = value.replace(/\/+$/, "");
    }
    return super.setControlValue(key, value);
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: "Qdrant URL",
        desc: "Your Qdrant instance, e.g. https://qdrant.example.com",
        control: { type: "text", key: "qdrantUrl" },
      },
      {
        name: "Qdrant API key",
        desc: "Set via QDRANT__SERVICE__API_KEY on the server",
        control: { type: "text", key: "qdrantApiKey" },
      },
      {
        name: "Embedding server URL",
        desc: "llama.cpp server with --embedding enabled, e.g. https://embed.example.com",
        control: { type: "text", key: "embedUrl" },
      },
      {
        name: "Embed API key",
        desc: "Optional - only needed if the embedding server requires auth. Sent as an Authorization: Bearer header.",
        control: { type: "text", key: "embedApiKey" },
      },
      {
        name: "Collection name",
        control: { type: "text", key: "collection" },
      },
      {
        name: "Pull interval (seconds)",
        desc: "How often to poll Qdrant for remote changes",
        control: { type: "number", key: "pullIntervalSeconds", min: 5 },
      },
      {
        name: "Force full resync",
        desc: "Reset the sync cursor to 0 and re-pull everything on next interval - use if this device missed changes",
        render: (setting) => {
          setting.addButton((btn) =>
            btn.setButtonText("Reset cursor").onClick(async () => {
              this.plugin.settings.lastSyncCursor = 0;
              await this.plugin.saveSettings();
            }),
          );
        },
      },
    ];
  }
}
