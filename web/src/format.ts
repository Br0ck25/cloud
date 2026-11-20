export const size = (n: number | null) => (n == null ? "" : n < 1e3 ? `${n} B` : n < 1e6 ? `${(n / 1e3).toFixed(0)} KB` : n < 1e9 ? `${(n / 1e6).toFixed(1)} MB` : `${(n / 1e9).toFixed(1)} GB`);

export const icon = (i: { kind: string; mime: string | null }) => (i.kind === "folder" ? "📁" : i.mime?.startsWith("image/") ? "🖼️" : i.mime?.startsWith("video/") ? "🎬" : i.mime?.startsWith("audio/") ? "🎵" : "📄");
