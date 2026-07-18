import { TFile, TFolder } from "obsidian";
import type QdrantSyncPlugin from "./main";
import { embed, sha256, pathToId, upsertPoint, scrollChangedSince, getPointByPath } from "./qdrant";

const SYNC_ROOT_EXCLUDE = /^\.obsidian\//;

export class SyncEngine {
  private plugin: QdrantSyncPlugin;
  private pushTimers = new Map<string, number>();
  private pushing = new Set<string>();
  private pullTimer: number | undefined;

  constructor(plugin: QdrantSyncPlugin) {
    this.plugin = plugin;
  }

  private get settings() {
    return this.plugin.settings;
  }

  isConfigured(): boolean {
    return Boolean(this.settings.qdrantUrl && this.settings.qdrantApiKey && this.settings.embedUrl);
  }

  private shouldSync(path: string): boolean {
    return path.endsWith(".md") && !SYNC_ROOT_EXCLUDE.test(path);
  }

  /** Debounced push - called from vault create/modify events. */
  schedulePush(file: TFile): void {
    if (!this.isConfigured() || !this.shouldSync(file.path)) return;
    const existing = this.pushTimers.get(file.path);
    if (existing) window.clearTimeout(existing);
    const timer = window.setTimeout(() => {
      this.pushTimers.delete(file.path);
      void this.pushFile(file);
    }, 2000);
    this.pushTimers.set(file.path, timer);
  }

  private async pushFile(file: TFile): Promise<void> {
    if (this.pushing.has(file.path)) return;
    this.pushing.add(file.path);
    try {
      const content = await this.plugin.app.vault.read(file);
      const contentHash = await sha256(content);

      const remote = await getPointByPath(this.settings, file.path).catch(() => undefined);
      if (remote && remote.payload.contentHash === contentHash && !remote.payload.deleted) {
        return; // no real change (e.g. our own pull-triggered write firing a modify event)
      }

      const vector = await embed(this.settings, content, "search_document");
      const id = await pathToId(file.path);
      await upsertPoint(this.settings, id, vector, {
        path: file.path,
        content,
        contentHash,
        mtime: Date.now(),
        size: content.length,
        deleted: false,
      });
    } catch (e) {
      console.error("qdrant-sync: push failed for", file.path, e);
    } finally {
      this.pushing.delete(file.path);
    }
  }

  async pushDelete(path: string): Promise<void> {
    if (!this.isConfigured() || !this.shouldSync(path)) return;
    const timer = this.pushTimers.get(path);
    if (timer) {
      window.clearTimeout(timer);
      this.pushTimers.delete(path);
    }
    try {
      const id = await pathToId(path);
      await upsertPoint(this.settings, id, await this.tombstoneVector(), {
        path,
        content: "",
        contentHash: "",
        mtime: Date.now(),
        size: 0,
        deleted: true,
      });
    } catch (e) {
      console.error("qdrant-sync: delete tombstone failed for", path, e);
    }
  }

  async pushRename(oldPath: string, file: TFile): Promise<void> {
    if (!this.isConfigured()) return;
    if (this.shouldSync(oldPath)) await this.pushDelete(oldPath);
    if (this.shouldSync(file.path)) await this.pushFile(file);
  }

  /** A zero vector reuses the same collection schema for tombstones without an embed call. */
  private async tombstoneVector(): Promise<number[]> {
    return new Array<number>(768).fill(0);
  }

  startPulling(): void {
    this.stopPulling();
    const intervalMs = Math.max(5, this.settings.pullIntervalSeconds) * 1000;
    this.pullTimer = window.setInterval(() => void this.pull(), intervalMs);
    void this.pull();
  }

  stopPulling(): void {
    if (this.pullTimer) window.clearInterval(this.pullTimer);
  }

  async pull(): Promise<void> {
    if (!this.isConfigured()) return;
    try {
      const changed = await scrollChangedSince(this.settings, this.settings.lastSyncCursor);
      if (changed.length === 0) return;

      let maxMtime = this.settings.lastSyncCursor;
      for (const point of changed) {
        await this.applyRemoteChange(point.payload);
        if (point.payload.mtime > maxMtime) maxMtime = point.payload.mtime;
      }
      this.settings.lastSyncCursor = maxMtime;
      await this.plugin.saveSettings();
    } catch (e) {
      console.error("qdrant-sync: pull failed", e);
    }
  }

  private async applyRemoteChange(payload: {
    path: string;
    content: string;
    mtime: number;
    deleted: boolean;
  }): Promise<void> {
    const vault = this.plugin.app.vault;
    const existing = vault.getAbstractFileByPath(payload.path);

    if (payload.deleted) {
      if (existing instanceof TFile && existing.stat.mtime <= payload.mtime) {
        await this.plugin.app.fileManager.trashFile(existing);
      }
      return;
    }

    if (existing instanceof TFile) {
      if (existing.stat.mtime > payload.mtime) return; // local edit is newer - last-write-wins keeps it
      const localContent = await vault.read(existing);
      if (localContent === payload.content) return;
      await vault.modify(existing, payload.content);
    } else {
      await this.ensureFolder(payload.path);
      await vault.create(payload.path, payload.content);
    }
  }

  private async ensureFolder(filePath: string): Promise<void> {
    const parts = filePath.split("/").slice(0, -1);
    if (parts.length === 0) return;
    const vault = this.plugin.app.vault;
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = vault.getAbstractFileByPath(current);
      if (!(existing instanceof TFolder)) {
        await vault.createFolder(current).catch(() => undefined);
      }
    }
  }
}
