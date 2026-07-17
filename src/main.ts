import { Plugin, TFile, Notice } from "obsidian";
import { DEFAULT_SETTINGS, QdrantSyncSettings, QdrantSyncSettingTab } from "./settings";
import { SyncEngine } from "./sync";

export default class QdrantSyncPlugin extends Plugin {
  settings!: QdrantSyncSettings;
  sync!: SyncEngine;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.sync = new SyncEngine(this);

    this.addSettingTab(new QdrantSyncSettingTab(this.app, this));

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (file instanceof TFile) this.sync.schedulePush(file);
      }),
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile) this.sync.schedulePush(file);
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        void this.sync.pushDelete(file.path);
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile) void this.sync.pushRename(oldPath, file);
      }),
    );

    this.addCommand({
      id: "qdrant-sync-pull-now",
      name: "Pull changes from Qdrant now",
      callback: () => {
        void this.sync.pull().then(() => new Notice("Qdrant sync: pull complete"));
      },
    });

    if (this.sync.isConfigured()) {
      this.sync.startPulling();
    } else {
      new Notice("Qdrant Sync: configure the plugin in Settings to start syncing");
    }
  }

  onunload(): void {
    this.sync.stopPulling();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
