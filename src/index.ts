export interface Env {
  BUCKET: R2Bucket;
  ALLOWED_ORIGIN: string;
}

function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data: unknown, status = 200, origin = "*") {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = env.ALLOWED_ORIGIN ?? "*";
    const url = new URL(request.url);
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (method === "GET" && url.pathname === "/api/list") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const listed = await env.BUCKET.list({ prefix, delimiter: "/" });

      const folders = listed.delimitedPrefixes.map((p) => ({
        type: "folder",
        key: p,
        name: p.replace(prefix, "").replace(/\/$/, ""),
      }));

      const files = listed.objects
        .filter((o) => o.key !== prefix && !o.key.endsWith("/"))
        .map((o) => ({
          type: "file",
          key: o.key,
          name: o.key.replace(prefix, ""),
          size: o.size,
          uploaded: o.uploaded,
          url: `${url.origin}/file/${encodeURIComponent(o.key)}`,
        }));

      return json({ folders, files }, 200, origin);
    }

    if (method === "GET" && url.pathname.startsWith("/file/")) {
      const key = decodeURIComponent(url.pathname.slice("/file/".length));
      const object = await env.BUCKET.get(key);
      if (!object) return json({ error: "Not found" }, 404, origin);

      const headers = new Headers(corsHeaders(origin));
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      headers.set("cache-control", "public, max-age=31536000");
      return new Response(object.body, { headers });
    }

    if (method === "POST" && url.pathname === "/api/upload") {
      const contentType = request.headers.get("content-type") ?? "";
      if (!contentType.includes("multipart/form-data")) {
        return json({ error: "Content-Type must be multipart/form-data" }, 400, origin);
      }

      const formData = await request.formData();
      const file = formData.get("file") as File | null;
      const prefix = (formData.get("prefix") as string | null) ?? "";
      if (!file) return json({ error: "No file provided" }, 400, origin);

      // FIX: arrayBuffer en vez de stream
      const buffer = await file.arrayBuffer();
      const key = `${prefix}${file.name}`;

      await env.BUCKET.put(key, buffer, {
        httpMetadata: { contentType: file.type || "application/octet-stream" },
      });

      return json({
        key,
        name: file.name,
        url: `${url.origin}/file/${encodeURIComponent(key)}`,
        size: file.size,
      }, 201, origin);
    }

    if (method === "POST" && url.pathname === "/api/folder") {
      const { path } = await request.json<{ path: string }>();
      if (!path) return json({ error: "No path provided" }, 400, origin);

      const key = path.endsWith("/") ? path : `${path}/`;
      await env.BUCKET.put(key, new Uint8Array(), {
        httpMetadata: { contentType: "application/x-directory" },
      });
      return json({ key, name: key }, 201, origin);
    }

    if (method === "DELETE" && url.pathname === "/api/delete") {
      const key = url.searchParams.get("key");
      if (!key) return json({ error: "No key provided" }, 400, origin);

      await env.BUCKET.delete(decodeURIComponent(key));
      return json({ deleted: key }, 200, origin);
    }

    return json({ error: "Not found" }, 404, origin);
  },
};