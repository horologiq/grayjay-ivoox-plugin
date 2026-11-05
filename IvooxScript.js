const PLATFORM = "iVoox";
const BASE = "https://www.ivoox.com";
const API = "https://vcore-web.ivoox.com/v1/public";
const PAGE_SIZE = 20;

const REGEX_CHANNEL_URL = /^https?:\/\/(www\.)?ivoox\.com\/.*_sq_f1(\d+)_\d+\.html/;
const REGEX_CONTENT_URL = /^https?:\/\/(www\.)?ivoox\.com\/.*_rf_(\d+)_\d+\.html/;

let config = {};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function apiGet(path) {
    const res = http.GET(API + path, { Accept: "application/json" }, false);
    if (!res.isOk) {
        throw new ScriptException("iVoox API " + res.code + " " + path);
    }
    return JSON.parse(res.body).data;
}

function absUrl(url) {
    if (!url) return "";
    return url.startsWith("http") ? url : BASE + url;
}

// iVoox dates come as "YYYY-MM-DD HH:MM:SS" in Spanish local time.
function parseDate(value) {
    if (!value) return 0;
    const ms = Date.parse(value.replace(" ", "T") + "+01:00");
    return isNaN(ms) ? 0 : Math.floor(ms / 1000);
}

function programIdFromUrl(url) {
    const m = REGEX_CHANNEL_URL.exec(url);
    if (!m) throw new ScriptException("Not an iVoox podcast url: " + url);
    return m[2];
}

function audioIdFromUrl(url) {
    const m = REGEX_CONTENT_URL.exec(url);
    if (!m) throw new ScriptException("Not an iVoox episode url: " + url);
    return m[2];
}

function programAuthor(program) {
    return new PlatformAuthorLink(
        new PlatformID(PLATFORM, String(program.id), config.id),
        program.name,
        absUrl(program.url),
        program.image
    );
}

function audioFields(audio, program) {
    return {
        id: new PlatformID(PLATFORM, String(audio.id), config.id),
        name: audio.title,
        thumbnails: new Thumbnails([new Thumbnail(audio.image, 0)]),
        author: programAuthor(program || audio.program),
        uploadDate: parseDate(audio.uploadDate),
        duration: audio.duration || 0,
        viewCount: audio.views || 0,
        url: absUrl(audio.url),
        isLive: false,
    };
}

function audioToVideo(audio, program) {
    return new PlatformVideo(audioFields(audio, program));
}

function programToChannel(program) {
    return new PlatformChannel({
        id: new PlatformID(PLATFORM, String(program.id), config.id),
        name: program.name,
        thumbnail: program.image,
        banner: program.imageHeader || "",
        subscribers: program.subscribers || 0,
        description: program.description || "",
        url: absUrl(program.url),
        links: {},
    });
}

// Latest episodes of a podcast, newest first: { total, items }.
function fetchAudios(programId, page, limit) {
    const filters = encodeURIComponent(JSON.stringify({ program: { eq: Number(programId) } }));
    const orders = encodeURIComponent(JSON.stringify({ uploadDate: "desc" }));
    return apiGet("/audios?filters=" + filters + "&orders=" + orders + "&page=" + page + "&limit=" + limit);
}

// ---------------------------------------------------------------------------
// Pagers
// ---------------------------------------------------------------------------

class IvooxChannelPager extends ContentPager {
    constructor(programId, program) {
        super([], true);
        this.programId = programId;
        this.program = program;
        this.page = 0;
        this.nextPage();
    }

    nextPage() {
        this.page++;
        const data = fetchAudios(this.programId, this.page, PAGE_SIZE);
        const items = data.items || [];
        this.results = items.map((a) => audioToVideo(a, this.program));
        this.hasMore = items.length > 0 && this.page * PAGE_SIZE < (data.total || 0);
        return this;
    }
}

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

source.enable = function (conf) {
    config = conf;
};

source.isChannelUrl = function (url) {
    return REGEX_CHANNEL_URL.test(url);
};

source.isContentDetailsUrl = function (url) {
    return REGEX_CONTENT_URL.test(url);
};

source.getChannel = function (url) {
    return programToChannel(apiGet("/programs/" + programIdFromUrl(url)));
};

source.getChannelContents = function (url) {
    const programId = programIdFromUrl(url);
    const program = apiGet("/programs/" + programId);
    return new IvooxChannelPager(programId, program);
};

source.getContentDetails = function (url) {
    const audio = apiGet("/audios/" + audioIdFromUrl(url));
    const fields = audioFields(audio, audio.program);
    fields.description = audio.description || "";
    fields.video = new UnMuxedVideoDescriptor(
        [],
        [
            new AudioUrlSource({
                container: "audio/mpeg",
                codec: "mp3",
                name: "MP3",
                bitrate: 128000,
                duration: audio.duration || 0,
                url: absUrl(audio.mediaUrl),
                language: "Unknown",
            }),
        ]
    );
    fields.live = null;
    fields.rating = new RatingLikes(audio.likes || 0);
    fields.subtitles = [];
    return new PlatformVideoDetails(fields);
};

// Podcasts matching a query (the API returns at most a handful).
function suggestPrograms(query) {
    const data = apiGet("/suggestions?search=" + encodeURIComponent(query));
    return (data && data.items && data.items.programs) || [];
}

// Newest episodes of each program, skipping programs that fail to load.
function latestEpisodes(programs, perProgram) {
    const results = [];
    for (const program of programs) {
        try {
            const data = fetchAudios(program.id, 1, perProgram);
            for (const audio of data.items || []) {
                results.push(audioToVideo(audio, program));
            }
        } catch (e) {
            log("iVoox: skipping program " + program.id + ": " + e);
        }
    }
    return results;
}

source.getHome = function () {
    const programs = apiGet("/featured-programs/origin/es") || [];
    return new ContentPager(latestEpisodes(programs, 1), false);
};

source.searchSuggestions = function (query) {
    return suggestPrograms(query).map((p) => p.name);
};

source.getSearchCapabilities = function () {
    return { types: [Type.Feed.Mixed], sorts: [], filters: [] };
};

source.search = function (query) {
    return new ContentPager(latestEpisodes(suggestPrograms(query), 5), false);
};

source.searchChannels = function (query) {
    return new ChannelPager(suggestPrograms(query).map(programToChannel), false);
};
