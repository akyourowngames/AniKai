
import { Hono } from "hono";
import { type ServerContext } from "../../config/context.js";
import { log } from "../../config/logger.js";
import { env } from "../../config/env.js";
import { cache } from "../../config/cache.js";
import * as cheerio from "cheerio";

const desidubRouter = new Hono<ServerContext>();

const BASE_URL = "https://www.desidubanime.me";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function fetchWithRetry(url: string, options: any = {}, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url, {
                ...options,
                signal: AbortSignal.timeout(30000),
            });
            if (res.ok) return res;
            if (res.status === 404) throw new Error("Status 404"); // Don't retry 404s
            throw new Error(`Status ${res.status}`);
        } catch (e) {
            if (i === retries - 1 || (e instanceof Error && e.message === "Status 404")) throw e;
            await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
        }
    }
    throw new Error("Failed after retries");
}

// Extract next episode estimation text
function extractNextEpisodeEstimate(html: string, $: cheerio.CheerioAPI): Array<{ lang?: string; server?: string; label: string; iso?: string }> {
    const estimates: Array<{ lang?: string; server?: string; label: string; iso?: string }> = [];

    // Look for "Estimated the next episode will come at" or similar text
    const estimateSelectors = [
        "[class*='estimate']",
        "[class*='next-episode']",
        "div:contains('Estimated')",
        "div:contains('next episode')",
        "span:contains('Estimated')"
    ];

    for (const selector of estimateSelectors) {
        $(selector).each((_, el) => {
            const text = $(el).text().trim();
            const estimateMatch = text.match(/estimated.*?next.*?episode.*?will.*?come.*?at\s*(.+)/i);

            if (estimateMatch) {
                // Try to extract language/server from parent context
                const parent = $(el).closest("div, section");
                const serverName = parent.find("button, [class*='server']").first().text().trim();
                const langText = parent.find("[class*='lang'], [class*='dub']").first().text().trim();

                estimates.push({
                    lang: langText || undefined,
                    server: serverName || undefined,
                    label: estimateMatch[1].trim(),
                    iso: undefined // Could parse date if needed
                });
            }
        });
    }

    return estimates;
}

desidubRouter.get("/home", async (c) => {
    const cacheConfig = c.get("CACHE_CONFIG");

    try {
        const data = await cache.getOrSet(
            async () => {
                const response = await fetchWithRetry(BASE_URL, {
                    headers: { "User-Agent": USER_AGENT },
                });
                const html = await response.text();
                const $ = cheerio.load(html);

                const featured: any[] = [];

                // Verified selector: .swiper-slide (Spotlight)
                $(".swiper-slide").each((_, element) => {
                    // Title logic: h2 > span[data-en-title] or h2
                    let title = $(element).find("h2 span[data-en-title]").text().trim();
                    if (!title) title = $(element).find("h2").text().trim();

                    const url = $(element).find("a").attr("href");
                    const img = $(element).find("img").attr("data-src") || $(element).find("img").attr("src");

                    let slug = "";
                    if (url) {
                        const match = url.match(/\/(?:anime|series)\/([^\/]+)\/?$/);
                        if (match) slug = match[1];
                    }

                    if (title && slug && url) {
                        featured.push({
                            title,
                            slug,
                            url,
                            poster: img,
                            type: "series"
                        });
                    }
                });

                const uniqueFeatured = Array.from(new Map(featured.map(item => [item.slug, item])).values()).slice(0, 20);
                return { featured: uniqueFeatured };
            },
            cacheConfig.key,
            cacheConfig.duration
        );

        return c.json({ provider: "Tatakai", status: 200, data });
    } catch (error) {
        // Cast error to safely read message
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error("DesiDubAnime Home Error: " + errorMessage);
        return c.json({ provider: "Tatakai", status: 500, error: "Failed to fetch data" }, 500);
    }
});

desidubRouter.get("/search", async (c) => {
    const query = c.req.query("q");
    if (!query) return c.json({ error: "Query required" }, 400);

    const cacheConfig = c.get("CACHE_CONFIG");

    try {
        const data = await cache.getOrSet(
            async () => {
                // Search is complex on this site (CSR/API protection). 
                // We attempt standard search URL, but expect mixed results.
                // Logic kept simple for now; if it fails (CSR), improved logic needed later.
                const searchUrl = `${BASE_URL}/search?s_keyword=${encodeURIComponent(query)}`;
                const response = await fetchWithRetry(searchUrl, {
                    headers: { "User-Agent": USER_AGENT },
                });
                const html = await response.text();
                const $ = cheerio.load(html);
                const results: any[] = [];

                $("article.post").each((_, element) => {
                    const title = $(element).find(".entry-title").text().trim();
                    const url = $(element).find("a.lnk-blk").attr("href");
                    const img = $(element).find("img").attr("data-src") || $(element).find("img").attr("src");

                    let slug = "";
                    if (url) {
                        const match = url.match(/\/(?:anime|series)\/([^\/]+)\/?$/);
                        if (match) slug = match[1];
                    }

                    if (title && slug) {
                        results.push({
                            title,
                            slug,
                            url,
                            poster: img
                        });
                    }
                });
                return { results };
            },
            cacheConfig.key,
            cacheConfig.duration
        );

        return c.json({ provider: "Tatakai", status: 200, data });
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error("DesiDubAnime Search Error: " + errorMessage);
        return c.json({ provider: "Tatakai", status: 500, error: "Failed to search" }, 500);
    }
});

desidubRouter.get("/info/:id", async (c) => {
    const id = c.req.param("id");
    const cacheConfig = c.get("CACHE_CONFIG");

    try {
        const data = await cache.getOrSet(
            async () => {
                const url = `${BASE_URL}/anime/${id}/`;
                const response = await fetchWithRetry(url, {
                    headers: { "User-Agent": USER_AGENT },
                });
                const html = await response.text();
                const $ = cheerio.load(html);

                const title = $("h1").text().trim();
                const poster = $(".anime-image img").attr("data-src") || $(".anime-image img").attr("src");
                const synopsis = $("[data-synopsis]").text().trim();

                const episodes: any[] = [];

                // Primary: swiper carousel
                $(".swiper-episode-anime .swiper-slide a").each((_, el) => {
                    try {
                        const epUrl = $(el).attr("href");
                        const epTitle = $(el).attr("title");
                        const epNumStr = $(el).find(".episode-list-item-number").text().trim() ||
                            $(el).find("span").text().replace("Episode", "").trim();

                        if (epUrl) {
                            const match = epUrl.match(/\/watch\/([^\/]+)\/?/);
                            const epId = match ? match[1] : "";
                            const epImage = $(el).find("img").attr("src") || $(el).find("img").attr("data-src");

                            episodes.push({
                                id: epId,
                                number: parseFloat(epNumStr) || 0,
                                title: epTitle || `Episode ${epNumStr}`,
                                url: epUrl,
                                image: epImage
                            });
                        }
                    } catch (error) {
                        log.warn(`Failed to parse episode: ${error}`);
                    }
                });

                // Fallback: episode list display
                if (episodes.length === 0) {
                    $(".episode-list-display-box a, a[href*='/watch/']").each((_, el) => {
                        try {
                            const epUrl = $(el).attr("href");
                            if (!epUrl || !epUrl.includes("/watch/")) return;

                            const epNum = $(el).find(".episode-list-item-number").text().trim() ||
                                $(el).text().match(/episode\s*(\d+)/i)?.[1];
                            const epTitle = $(el).find(".episode-list-item-title").text().trim() ||
                                $(el).attr("title") ||
                                $(el).text().trim();

                            const match = epUrl.match(/\/watch\/([^\/]+)\/?/);
                            const epId = match ? match[1] : "";

                            if (epId) {
                                episodes.push({
                                    id: epId,
                                    number: parseFloat(epNum || "0"),
                                    title: epTitle || `Episode ${epNum}`,
                                    url: epUrl
                                });
                            }
                        } catch (error) {
                            log.warn(`Failed to parse episode from fallback: ${error}`);
                        }
                    });
                }

                // Extract "More Season" links
                const seasons: any[] = [];
                $("a[href*='/anime/']").filter((_, el) => {
                    const text = $(el).text().toLowerCase();
                    return text.includes("season") || text.includes("s1") || text.includes("s2");
                }).each((_, el) => {
                    try {
                        const seasonUrl = $(el).attr("href");
                        const seasonTitle = $(el).text().trim();
                        const seasonMatch = seasonUrl?.match(/\/anime\/([^\/]+)\/?/);
                        const seasonSlug = seasonMatch ? seasonMatch[1] : "";

                        if (seasonSlug && seasonTitle) {
                            seasons.push({
                                id: seasonSlug,
                                title: seasonTitle,
                                url: seasonUrl
                            });
                        }
                    } catch (error) {
                        log.warn(`Failed to parse season: ${error}`);
                    }
                });

                // Extract Downloads (480P, 720P, 1080P Google Drive)
                const downloads: any[] = [];
                $("a[href*='drive.google'], a[href*='download']").each((_, el) => {
                    try {
                        const downloadUrl = $(el).attr("href");
                        const qualityText = $(el).text().trim();
                        const qualityMatch = qualityText.match(/(\d+p|480p|720p|1080p)/i);
                        const quality = qualityMatch ? qualityMatch[1].toUpperCase() : "Unknown";

                        if (downloadUrl) {
                            downloads.push({
                                quality,
                                url: downloadUrl
                            });
                        }
                    } catch (error) {
                        log.warn(`Failed to parse download: ${error}`);
                    }
                });

                return {
                    id,
                    title,
                    poster,
                    description: synopsis,
                    episodes: episodes.sort((a, b) => a.number - b.number),
                    seasons: seasons.length > 0 ? seasons : undefined,
                    downloads: downloads.length > 0 ? downloads : undefined
                };
            },
            cacheConfig.key,
            cacheConfig.duration
        );

        return c.json({
            provider: "Tatakai",
            status: 200,
            data
        });

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error("DesiDubAnime Info Error: " + errorMessage);
        return c.json({ provider: "Tatakai", status: 500, error: "Failed to fetch info" }, 500);
    }
});

desidubRouter.get("/watch/:id", async (c) => {
    const id = c.req.param("id");
    const cacheConfig = c.get("CACHE_CONFIG");

    try {
        const data = await cache.getOrSet(
            async () => {
                log.info(`Fetching Desidubanime watch: ${BASE_URL}/watch/${id}/`);
                const url = `${BASE_URL}/watch/${id}/`;
                const response = await fetchWithRetry(url, {
                    headers: { "User-Agent": USER_AGENT },
                });
                const html = await response.text();
                const $ = cheerio.load(html);

                const sources: any[] = [];
                const nextEpisodeEstimates: Array<{ lang?: string; server?: string; label: string; iso?: string }> = [];

                // Helper to decode base64 safely
                const decodeB64 = (str: string) => {
                    try {
                        return atob(str);
                    } catch (e) {
                        return "";
                    }
                };

                // Detect SUB/DUB servers via data-embed-id
                $("span[data-embed-id]").each((_, el) => {
                    try {
                        const embedData = $(el).attr("data-embed-id");
                        if (!embedData) return;

                        const [b64Name, b64Url] = embedData.split(":");
                        if (!b64Name || !b64Url) return;

                        const serverName = decodeB64(b64Name);
                        let finalUrl = decodeB64(b64Url);

                        if (!finalUrl || !serverName) return;

                        // Check if finalUrl is an iframe tag
                        if (finalUrl.includes("<iframe")) {
                            const iframeSrc = finalUrl.match(/src=['"]([^'"]+)['"]/)?.[1];
                            if (iframeSrc) finalUrl = iframeSrc;
                        }

                        if (finalUrl && !finalUrl.includes("googletagmanager")) {
                            const isDub = serverName.toLowerCase().includes("dub");
                            sources.push({
                                name: serverName.replace(/dub$/i, ""),
                                url: finalUrl,
                                quality: "default",
                                isM3U8: finalUrl.includes(".m3u8"),
                                isEmbed: !finalUrl.includes(".m3u8"),
                                category: isDub ? "dub" : "sub",
                                language: isDub ? "Hindi" : "Japanese"
                            });
                        }
                    } catch (error) {
                        log.warn(`Failed to parse data-embed-id: ${error}`);
                    }
                });

                // Fallback: Primary parsing logic if span[data-embed-id] is missing or incomplete
                if (sources.length === 0) {
                    $("button, a, [class*='server']").each((_, el) => {
                        try {
                            const text = $(el).text().trim();
                            const serverNames = ["Mirror", "Stream", "p2p", "Abyss", "V Moly", "CLOUD", "No Ads"];
                            const serverName = serverNames.find(name => text.includes(name));

                            if (serverName) {
                                // Get the source URL
                                const sourceUrl = $(el).attr("data-src") ||
                                    $(el).attr("data-url") ||
                                    $(el).attr("href") ||
                                    $(el).attr("onclick")?.match(/['"](https?:\/\/[^'"]+)['"]/)?.[1];

                                // Check for iframe in same container
                                const container = $(el).closest("div, section");
                                const iframe = container.find("iframe").first();
                                const iframeSrc = iframe.attr("src") || iframe.attr("data-src");

                                let finalUrl = sourceUrl || iframeSrc;

                                if (finalUrl && !finalUrl.includes("googletagmanager") && !finalUrl.includes("cdn-cgi")) {
                                    sources.push({
                                        name: serverName,
                                        url: finalUrl,
                                        quality: "default",
                                        isM3U8: finalUrl.includes(".m3u8"),
                                        isEmbed: true,
                                        category: "dub", // Default to dub for desidubanime
                                        language: "Hindi"
                                    });
                                }
                            }
                        } catch (error) {
                            log.warn(`Failed to parse server fallback: ${error}`);
                        }
                    });
                }

                // Fallback: extract all iframes
                if (sources.length === 0) {
                    $("iframe").each((_, el) => {
                        try {
                            const src = $(el).attr("src") || $(el).attr("data-src");
                            if (src && !src.includes("googletagmanager") && !src.includes("cdn-cgi")) {
                                sources.push({
                                    name: "Default",
                                    url: src,
                                    quality: "default",
                                    isM3U8: src.includes(".m3u8"),
                                    isEmbed: true,
                                    category: "dub" // Default to dub for desidubanime
                                });
                            }
                        } catch (error) {
                            log.warn(`Failed to parse iframe: ${error}`);
                        }
                    });
                }

                // Extract next episode estimation
                const estimates = extractNextEpisodeEstimate(html, $);
                nextEpisodeEstimates.push(...estimates);

                // Also look for estimation text in page
                const pageText = $.text();
                const estimateMatch = pageText.match(/estimated.*?next.*?episode.*?will.*?come.*?at\s*([^\n\r]+)/i);
                if (estimateMatch && estimates.length === 0) {
                    nextEpisodeEstimates.push({
                        label: estimateMatch[1].trim()
                    });
                }

                return {
                    sources,
                    nextEpisodeEstimates: nextEpisodeEstimates.length > 0 ? nextEpisodeEstimates : undefined,
                    headers: {
                        Referer: BASE_URL,
                        "User-Agent": USER_AGENT
                    }
                };
            },
            cacheConfig.key,
            cacheConfig.duration
        );

        return c.json({
            provider: "Tatakai",
            status: 200,
            data
        });

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error("DesiDubAnime Watch Error: " + errorMessage);
        const status = errorMessage.includes("Status 404") ? 404 : 500;
        return c.json({ provider: "Tatakai", status, error: errorMessage.includes("Status 404") ? "Episode not found" : "Failed to fetch stream" }, status);
    }
});

export default desidubRouter;
