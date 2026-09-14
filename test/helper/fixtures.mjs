import { createHash } from "node:crypto";

export const ADMIN_PASS = "hunter22";
export const ADMIN_HASH = createHash("sha256").update(ADMIN_PASS).digest("hex");

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

export const SOURCE_A = { id: "a", name: "源A", url: "https://dav.example.com/dav/", user: "u1", pass: "p1" };
export const SOURCE_B = { id: "b", name: "源B", url: "https://dav.example.net/dav", user: "u2", pass: "päss" };
export const SOURCE_ERR = { id: "e", name: "坏源", url: "https://err.example.com/dav/" };
export const SOURCE_BADPATH = { id: "z", name: "怪源", url: "https://bad.example.com/%zz/dav" };

export const BASIC_A = "Basic " + b64(`${SOURCE_A.user}:${SOURCE_A.pass}`);
export const BASIC_B = "Basic " + b64(`${SOURCE_B.user}:${SOURCE_B.pass}`);

export const PROPFIND_A = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
<d:response>
<d:href>/dav/</d:href>
<d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype><d:displayname>Music</d:displayname></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
</d:response>
<d:response>
<d:href>/dav/Alpha%20-%20One.mp3</d:href>
<d:propstat><d:prop><d:resourcetype/><d:displayname>Alpha - One.mp3</d:displayname></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
</d:response>
<d:response>
<d:href>/dav/Beta%20&amp;%20Band%20-%20Two.flac</d:href>
<d:propstat><d:prop><d:resourcetype/><d:displayname>Beta &amp; Band - Two.flac</d:displayname></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
</d:response>
</d:multistatus>`;

export const PROPFIND_B = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
<D:response>
<D:href>/dwb/</D:href>
<D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
</D:response>
<D:response>
<D:href>/dwb/Alpha - One.mp3</D:href>
<D:propstat><D:prop><D:resourcetype/><D:displayname>Alpha - One.mp3</D:displayname></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
</D:response>
<D:response>
<D:href>/dwb/Gamma%20&lt;live&gt;.m4a</D:href>
<D:propstat><D:prop><D:resourcetype/><D:displayname>Gamma &lt;live&gt;.m4a</D:displayname></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
</D:response>
<D:response>
<D:href>/dwb/readme.txt</D:href>
<D:propstat><D:prop><D:resourcetype/></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
</D:response>
</D:multistatus>`;

export const PROPFIND_ONLY_DIR = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
<d:response>
<d:href>/dav/</d:href>
<d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
</d:response>
</d:multistatus>`;

export const PROPFIND_NON_AUDIO = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
<d:response>
<d:href>/dav/</d:href>
<d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
</d:response>
<d:response>
<d:href>/dav/sub/</d:href>
<d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
</d:response>
<d:response>
<d:href>/dav/notes.txt</d:href>
<d:propstat><d:prop><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
</d:response>
</d:multistatus>`;

export const HTML_LOGIN_PAGE = `<!DOCTYPE html>
<html><head><title>Login</title></head><body>Please sign in</body></html>`;

export const WAF_403_BODY = `Access for this IP has been blocked by the security system`;

export const davResponse = (xml, status = 207, statusText = "Multi-Status", contentType = "application/xml") =>
  () => new Response(xml, { status, statusText, headers: { "content-type": contentType } });

export const jsmediatagsBody = "/* jsmediatags 3.9.5 fake payload */";