const EMBED_BASE_URL = process.env.ANIEMBED_BASE_URL || 'https://vidsrc.xyz';

function getEpisodeList(anime) {
  const total = Math.max(1, Math.min(300, Number(anime.episodeCount) || 24));
  return Array.from({ length: total }, (_, idx) => ({
    number: idx + 1,
    title: `Episode ${idx + 1}`
  }));
}

function getMalId(anime, mediaId) {
  const fromAnime = Number(anime?.idMal);
  if (Number.isFinite(fromAnime) && fromAnime > 0) return fromAnime;
  const fromMedia = Number(mediaId);
  if (Number.isFinite(fromMedia) && fromMedia > 0) return fromMedia;
  return null;
}

module.exports = {
  id: 'aniembed',
  name: 'Anime Embed',
  async getEpisodeList({ anime }) {
    return getEpisodeList(anime);
  },
  async getEpisodeSources({ anime, mediaId, episodeNumber }) {
    const malId = getMalId(anime, mediaId);
    if (!malId) {
      throw new Error('No MAL ID available for embed provider');
    }

    const ep = Math.max(1, Number(episodeNumber) || 1);
    const url = `${EMBED_BASE_URL.replace(/\/+$/, '')}/embed/anime/${malId}/${ep}`;

    return {
      number: ep,
      videoSources: [
        {
          server: 'aniembed',
          url,
          label: 'Embed Player',
          quality: 'auto',
          type: 'embed'
        }
      ]
    };
  }
};
