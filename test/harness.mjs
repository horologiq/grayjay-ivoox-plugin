// Smoke harness: emulates the parts of the Grayjay plugin runtime used by
// IvooxScript.js, loads the script and exercises each source method against
// the live iVoox API. Usage: node test/harness.mjs
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(path.join(root, "IvooxConfig.json"), "utf8"));
const scriptPath = path.join(root, "IvooxScript.js");

const CHANNEL_URL = "https://www.ivoox.com/podcast-tribuna-deportiva_sq_f1465589_1.html";
const EPISODE_URL = "https://www.ivoox.com/tribuna-deportiva-parte-1-jueves-05-noviembre-audios-mp3_rf_183369361_1.html";
const QUERY = "nadie sabe nada";

function curl(url, extra = []) {
    const out = execFileSync("curl", ["-s", "-A", "Mozilla/5.0", "-w", "\n%{http_code}", ...extra, url], {
        maxBuffer: 64 * 1024 * 1024,
    }).toString();
    const i = out.lastIndexOf("\n");
    return { body: out.slice(0, i), code: parseInt(out.slice(i + 1), 10) };
}

// ---- Grayjay runtime stubs -------------------------------------------------
const g = globalThis;
g.http = {
    GET(url, headers) {
        const h = [];
        for (const [k, v] of Object.entries(headers || {})) h.push("-H", `${k}: ${v}`);
        const r = curl(url, h);
        return { isOk: r.code >= 200 && r.code < 300, code: r.code, body: r.body };
    },
};
class Fields {
    constructor(obj) {
        Object.assign(this, obj);
    }
}
g.PlatformID = class {
    constructor(platform, value, pluginId) {
        Object.assign(this, { platform, value, pluginId });
    }
};
g.Thumbnail = class {
    constructor(url, quality) {
        Object.assign(this, { url, quality });
    }
};
g.Thumbnails = class {
    constructor(sources) {
        this.sources = sources;
    }
};
g.PlatformAuthorLink = class {
    constructor(id, name, url, thumbnail) {
        Object.assign(this, { id, name, url, thumbnail });
    }
};
g.PlatformVideo = class extends Fields {};
g.PlatformVideoDetails = class extends g.PlatformVideo {};
g.PlatformChannel = class extends Fields {};
g.AudioUrlSource = class extends Fields {};
g.UnMuxVideoSourceDescriptor = class {
    constructor(videoSources, audioSources) {
        Object.assign(this, { videoSources, audioSources });
    }
};
g.RatingLikes = class {
    constructor(likes) {
        this.likes = likes;
    }
};
g.ScriptException = class extends Error {};
class Pager {
    constructor(results = [], hasMore = false, context = {}) {
        Object.assign(this, { results, hasMore, context });
    }
    nextPage() {
        return this;
    }
}
g.ContentPager = class extends Pager {};
g.VideoPager = g.ContentPager;
g.ChannelPager = class extends Pager {};
g.Type = { Feed: { Mixed: "MIXED", Videos: "VIDEOS" }, Order: { Chronological: "CHRONOLOGICAL" } };
g.bridge = { log: (m) => console.log("[log]", m) };
g.log = g.bridge.log;
g.source = {};

// ---- Load the plugin --------------------------------------------------------
if (existsSync(scriptPath)) {
    vm.runInThisContext(readFileSync(scriptPath, "utf8"), { filename: scriptPath });
    if (typeof source.enable === "function") source.enable(config, {}, null);
} else {
    console.log("IvooxScript.js not found");
}

// ---- Checks -----------------------------------------------------------------
let failed = false;
function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}
function check(method, fn) {
    if (typeof source[method] !== "function") {
        console.log("SKIP", method);
        return;
    }
    try {
        console.log("PASS", method, fn() ?? "");
    } catch (e) {
        failed = true;
        console.log("FAIL", method, e && e.stack ? e.stack : e);
    }
}
function assertVideo(v) {
    assert(v instanceof PlatformVideo, "not a PlatformVideo");
    assert(/_rf_\d+_\d+\.html/.test(v.url), "bad episode url " + v.url);
    assert(v.name, "missing name");
    assert(v.duration > 0, "bad duration " + v.duration);
    assert(v.uploadDate > 1e9, "bad uploadDate " + v.uploadDate);
    assert(v.author && v.author.name, "missing author");
    assert(v.id && v.id.value, "missing id");
}
const ids = (p) => p.results.map((v) => v.id.value).join(",");

check("isChannelUrl", () => {
    assert(source.isChannelUrl(CHANNEL_URL) === true, "channel url not detected");
    assert(source.isChannelUrl(EPISODE_URL) === false, "episode url taken as channel");
});
check("isContentDetailsUrl", () => {
    assert(source.isContentDetailsUrl(EPISODE_URL) === true, "episode url not detected");
    assert(source.isContentDetailsUrl(CHANNEL_URL) === false, "channel url taken as episode");
});
check("getChannel", () => {
    const c = source.getChannel(CHANNEL_URL);
    assert(c instanceof PlatformChannel, "not a PlatformChannel");
    assert(c.name, "missing name");
    assert(/_sq_f1465589_/.test(c.url), "bad channel url " + c.url);
    return c.name;
});
check("getChannelContents", () => {
    const p = source.getChannelContents(CHANNEL_URL);
    assert(p.results.length === 20, "expected 20 results, got " + p.results.length);
    p.results.forEach(assertVideo);
    assert(p.hasMore === true, "expected hasMore");
    const first = ids(p);
    const p2 = p.nextPage() || p;
    assert(p2.results.length > 0, "empty second page");
    assert(ids(p2) !== first, "second page repeats the first");
    return `${p.results.length} + ${p2.results.length} episodes`;
});
check("getContentDetails", () => {
    const d = source.getContentDetails(EPISODE_URL);
    assert(d instanceof PlatformVideoDetails, "not PlatformVideoDetails");
    assertVideo(d);
    const audio = d.video && d.video.audioSources;
    assert(audio && audio.length === 1, "expected one audio source");
    const head = execFileSync("curl", ["-sI", "-A", "Mozilla/5.0", audio[0].url]).toString();
    assert(/^HTTP\/\S+ 30[12]/m.test(head), "audio url did not redirect");
    assert(/^location: .*\.mp3/im.test(head), "redirect is not an mp3");
    return audio[0].url;
});
check("searchSuggestions", () => {
    const s = source.searchSuggestions(QUERY);
    assert(Array.isArray(s) && s.length > 0 && typeof s[0] === "string", "no suggestions");
    return s.join(" | ");
});
check("getSearchCapabilities", () => {
    const c = source.getSearchCapabilities();
    assert(Array.isArray(c.types) && c.types.length > 0, "no types");
});
check("searchChannels", () => {
    const p = source.searchChannels(QUERY);
    assert(p.results.length > 0, "no channels");
    p.results.forEach((c) => assert(/_sq_f1\d+_/.test(c.url), "bad channel url " + c.url));
    return p.results.map((c) => c.name).join(" | ");
});
check("search", () => {
    const p = source.search(QUERY, null, null, {});
    assert(p.results.length > 0, "no results");
    p.results.forEach(assertVideo);
    return `${p.results.length} episodes`;
});
check("getHome", () => {
    const p = source.getHome();
    assert(p.results.length > 0, "empty home");
    p.results.forEach(assertVideo);
    return `${p.results.length} episodes`;
});

process.exit(failed ? 1 : 0);
