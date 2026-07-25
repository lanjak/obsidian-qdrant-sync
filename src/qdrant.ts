import { requestUrl } from "obsidian";
import type { QdrantSyncSettings } from "./settings";

export interface NotePayload {
  path: string;
  content: string;
  contentHash: string;
  mtime: number;
  size: number;
  deleted: boolean;
}

export interface QdrantPoint {
  id: string;
  payload: NotePayload;
}

/** Deterministic UUID (v4-shaped, not cryptographically meaningful) from a vault path, so renames/moves are the only case that needs a delete+create pair. */
export async function pathToId(path: string): Promise<string> {
  const bytes = new TextEncoder().encode(path);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest).slice(0, 16))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function embed(settings: QdrantSyncSettings, text: string, task: "search_document" | "search_query"): Promise<number[]> {
  const res = await requestUrl({
    url: `${settings.embedUrl}/embedding`,
    method: "POST",
    contentType: "application/json",
    headers: settings.embedApiKey ? { Authorization: `Bearer ${settings.embedApiKey}` } : undefined,
    body: JSON.stringify({ content: `${task}: ${text}` }),
  });
  const body = res.json as Array<{ embedding: number[][] }>;
  return body[0].embedding[0];
}

function headers(settings: QdrantSyncSettings): Record<string, string> {
  return { "api-key": settings.qdrantApiKey, "Content-Type": "application/json" };
}

export async function upsertPoint(settings: QdrantSyncSettings, id: string, vector: number[], payload: NotePayload): Promise<void> {
  await requestUrl({
    url: `${settings.qdrantUrl}/collections/${settings.collection}/points?wait=true`,
    method: "PUT",
    headers: headers(settings),
    body: JSON.stringify({ points: [{ id, vector, payload }] }),
  });
}

/** Scroll every point with payload.mtime > sinceMs, paginating through Qdrant's scroll API. */
export async function scrollChangedSince(settings: QdrantSyncSettings, sinceMs: number): Promise<QdrantPoint[]> {
  const points: QdrantPoint[] = [];
  let offset: string | number | null = null;
  for (;;) {
    const res = await requestUrl({
      url: `${settings.qdrantUrl}/collections/${settings.collection}/points/scroll`,
      method: "POST",
      headers: headers(settings),
      body: JSON.stringify({
        filter: { must: [{ key: "mtime", range: { gt: sinceMs } }] },
        limit: 100,
        offset,
        with_payload: true,
        with_vector: false,
      }),
    });
    const body = res.json as { result: { points: QdrantPoint[]; next_page_offset: string | number | null } };
    points.push(...body.result.points);
    offset = body.result.next_page_offset;
    if (!offset) break;
  }
  return points;
}

export async function getPointByPath(settings: QdrantSyncSettings, path: string): Promise<QdrantPoint | undefined> {
  const res = await requestUrl({
    url: `${settings.qdrantUrl}/collections/${settings.collection}/points/scroll`,
    method: "POST",
    headers: headers(settings),
    body: JSON.stringify({
      filter: { must: [{ key: "path", match: { value: path } }] },
      limit: 1,
      with_payload: true,
      with_vector: false,
    }),
  });
  const body = res.json as { result: { points: QdrantPoint[] } };
  return body.result.points[0];
}
